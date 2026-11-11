import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { CHARACTER_LIMIT, renderSearch } from "../src/format.js";
import { HttpClient } from "../src/http/client.js";
import { BannedOnionList, md5 } from "../src/safety/banned.js";
import { SafetyGuard } from "../src/safety/guard.js";
import { runSearch, SafetyRefusal, type SearchDeps } from "../src/search.js";
import type { SearchResult, Source, SourceId, SourcePage } from "../src/types.js";

const BANNED = "e".repeat(56) + ".onion";
const onion = (n: number) => `${String(n).padStart(2, "0")}${"f".repeat(54)}.onion`;

function fakeSource(id: SourceId, scope: Source["scope"], channel: Source["channel"], page: (q: { offset: number; limit: number }) => SourcePage): Source {
  return {
    id,
    name: id.toUpperCase(),
    scope,
    channel,
    homepage: "https://example.org",
    description: "fake",
    isDefault: () => true,
    availability: () => ({ ok: true }),
    search: async q => page(q)
  };
}

const r = (source: SourceId, title: string, url: string, extra: Partial<SearchResult> = {}): SearchResult => ({ source, title, url, ...extra });

const academicA = fakeSource("openalex", "academic", "academic", () => ({
  total: 100,
  results: [
    r("openalex", "Shared paper", "https://doi.org/10.1234/shared", { doi: "10.1234/shared", year: 2020 }),
    r("openalex", "Old paper", "https://doi.org/10.1234/old", { doi: "10.1234/old", year: 1990 }),
    r("openalex", "Mirror copy", "https://mirror.example/p", { year: 2021 })
  ]
}));
const academicB = fakeSource("crossref", "academic", "academic", () => ({
  total: 50,
  results: [r("crossref", "Shared paper (crossref)", "https://doi.org/10.1234/SHARED", { doi: "10.1234/SHARED", year: 2020 })]
}));
const web = fakeSource("wiby", "web", "web", () => ({
  results: [r("wiby", "Free porn videos", "https://adult.example/"), r("wiby", "A personal essay", "https://essay.example/")]
}));
const dark = fakeSource("ahmia", "darkweb", "darkweb", () => ({
  complete: true,
  results: [
    r("ahmia", "Banned service", `http://${BANNED}/`, { onion: true }),
    r("ahmia", "Fresh CVV shop", `http://${onion(99)}/`, { onion: true }),
    ...Array.from({ length: 12 }, (_, i) => r("ahmia", `Forum ${i}`, `http://${onion(i)}/`, { onion: true }))
  ]
}));
const registry = [academicA, academicB, web, dark];

function deps(): SearchDeps {
  const config = loadConfig({}).config;
  const http = new HttpClient(config);
  return {
    config,
    http,
    cache: new TtlCache<unknown>(60_000),
    guard: new SafetyGuard(),
    banned: BannedOnionList.fromHashes(http, [md5(BANNED)])
  };
}

describe("runSearch", () => {
  it("merges duplicates across sources by DOI", async () => {
    const out = await runSearch({ query: "anything", limit_per_source: 5, offset: 0 }, deps(), undefined, registry);
    const shared = out.results.filter(x => x.doi?.toLowerCase() === "10.1234/shared");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.also_in).toEqual(["crossref"]);
    const crossref = out.sources.find(s => s.id === "crossref")!;
    expect(crossref.duplicates).toBe(1);
    expect(crossref.count).toBe(0);
  });

  it("hides filtered and blacklisted results and counts them by reason", async () => {
    const out = await runSearch({ query: "anything", limit_per_source: 5, offset: 0 }, deps(), undefined, registry);
    expect(out.results.some(x => x.title === "Free porn videos")).toBe(false);
    expect(out.results.some(x => x.title === "A personal essay")).toBe(true);
    expect(out.results.some(x => x.url.includes(BANNED))).toBe(false);
    expect(out.safety.by_reason).toMatchObject({ sexual: 1, ahmia_blacklist: 1, fraud: 1 });
    expect(out.safety.hidden).toBe(3);
  });

  it("paginates complete (dark web) lists after filtering", async () => {
    const first = await runSearch({ query: "forum", sources: ["ahmia"], limit_per_source: 5, offset: 0 }, deps(), undefined, registry);
    expect(first.results.map(x => x.title)).toEqual(["Forum 0", "Forum 1", "Forum 2", "Forum 3", "Forum 4"]);
    expect(first.sources[0]).toMatchObject({ total: 12, has_more: true, hidden: 2 });
    expect(first.next_offset).toBe(5);
    const last = await runSearch({ query: "forum", sources: ["ahmia"], limit_per_source: 5, offset: 10 }, deps(), undefined, registry);
    expect(last.results.map(x => x.title)).toEqual(["Forum 10", "Forum 11"]);
    expect(last.has_more).toBe(false);
    expect(last.next_offset).toBeUndefined();
  });

  it("applies year ranges and excluded domains", async () => {
    const out = await runSearch(
      { query: "anything", scopes: ["academic"], limit_per_source: 5, offset: 0, year_from: 2000, exclude_domains: ["https://www.mirror.example"] },
      deps(),
      undefined,
      registry
    );
    const titles = out.results.map(x => x.title);
    expect(titles).toContain("Shared paper");
    expect(titles).not.toContain("Old paper");
    expect(titles).not.toContain("Mirror copy");
  });

  it("refuses abuse queries on web/dark web but still runs academic sources", async () => {
    const out = await runSearch({ query: "child porn", limit_per_source: 5, offset: 0 }, deps(), undefined, registry);
    expect(out.sources.find(s => s.id === "ahmia")?.status).toBe("refused");
    expect(out.sources.find(s => s.id === "wiby")?.status).toBe("refused");
    expect(out.sources.find(s => s.id === "openalex")?.status).toBe("ok");
    expect(out.safety.refused.map(x => x.channel).sort()).toEqual(["darkweb", "web"]);
  });

  it("throws a SafetyRefusal when every requested source is refused", async () => {
    await expect(runSearch({ query: "child porn", scopes: ["darkweb", "web"], limit_per_source: 5, offset: 0 }, deps(), undefined, registry)).rejects.toBeInstanceOf(
      SafetyRefusal
    );
  });

  it("reports a failing source without failing the search", async () => {
    const broken: Source = { ...academicB, search: async () => Promise.reject(new Error("upstream down")) };
    const out = await runSearch({ query: "x", scopes: ["academic"], limit_per_source: 5, offset: 0 }, deps(), undefined, [academicA, broken]);
    expect(out.sources.find(s => s.id === "crossref")).toMatchObject({ status: "error", error: "upstream down" });
    expect(out.results.length).toBeGreaterThan(0);
  });
});

describe("renderSearch", () => {
  it("renders Markdown with per-scope sections and a pagination hint", async () => {
    const out = await runSearch({ query: "forum", limit_per_source: 5, offset: 0 }, deps(), undefined, registry);
    const { text } = renderSearch(out, "markdown");
    expect(text).toContain('# Deep Search: "forum"');
    expect(text).toContain("## Academic literature");
    expect(text).toContain("## Dark web (Tor onion services)");
    expect(text).toContain("Also in: crossref");
    expect(text).toMatch(/Safety filter:\*\* 3 results hidden/);
    expect(text).toContain("call again with offset=5");
  });

  it("returns parseable JSON with structured content", async () => {
    const out = await runSearch({ query: "forum", limit_per_source: 5, offset: 0 }, deps(), undefined, registry);
    const rendered = renderSearch(out, "json");
    expect(JSON.parse(rendered.text)).toEqual(rendered.structured);
  });

  it("stays under the character limit by showing fewer results per source", async () => {
    const long = "word ".repeat(120);
    const big = fakeSource("openalex", "academic", "academic", () => ({
      total: 1000,
      results: Array.from({ length: 25 }, (_, i) => r("openalex", `Paper ${i} ${long}`.slice(0, 300), `https://p.example/${i}`, { snippet: long }))
    }));
    const big2 = fakeSource("core", "academic", "academic", () => ({
      total: 1000,
      results: Array.from({ length: 25 }, (_, i) => r("core", `Other ${i}`, `https://q.example/${i}`, { snippet: long }))
    }));
    const out = await runSearch({ query: "x", limit_per_source: 25, offset: 0 }, deps(), undefined, [big, big2]);
    for (const format of ["markdown", "json"] as const) {
      const rendered = renderSearch(out, format);
      expect(rendered.text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
      expect(rendered.text).toMatch(format === "json" ? /"trimmed_to"/ : /Output trimmed/);
    }
  });
});
