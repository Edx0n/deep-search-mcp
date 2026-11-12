import { load } from "cheerio";
import type { Config } from "../config.js";
import { HttpError, type HttpClient } from "../http/client.js";
import type { SearchResult, Source, SourcePage } from "../types.js";
import { clip, collapse } from "../util/text.js";
import { compact, SNIPPET_CHARS } from "./common.js";

/**
 * Ahmia (ahmia.fi) indexes public Tor onion services and, unlike other onion search engines,
 * removes child-abuse content through a maintained blacklist. It is the only dark web index used here.
 */
export const AHMIA = {
  clearnet: "https://ahmia.fi",
  onion: "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion"
};

const TOKEN_TTL_MS = 10 * 60_000;
const tokens = new Map<string, { name: string; value: string; expires: number }>();

export function ahmiaBase(config: Config): { base: string; viaTor: boolean } | null {
  // With a Tor route beyond .onion-only, dark web searches never touch the clear web
  if (config.torRoute !== "onion") return config.tor ? { base: AHMIA.onion, viaTor: true } : null;
  if (config.ahmiaMode === "clearnet") return { base: AHMIA.clearnet, viaTor: false };
  if (config.ahmiaMode === "onion") return config.tor ? { base: AHMIA.onion, viaTor: true } : null;
  return config.tor ? { base: AHMIA.onion, viaTor: true } : { base: AHMIA.clearnet, viaTor: false };
}

/** Ahmia's search form carries a hidden field with a random name/value that the search endpoint requires. */
export function parseAhmiaToken(html: string): { name: string; value: string } | null {
  const $ = load(html);
  const form = $("form#searchForm").length ? $("form#searchForm") : $("form[action*='search']").first();
  let token: { name: string; value: string } | null = null;
  form.find("input[type='hidden']").each((_, el) => {
    const name = $(el).attr("name");
    const value = $(el).attr("value");
    if (!token && name && value !== undefined && name !== "q") token = { name, value };
  });
  return token;
}

function onionTarget(href: string, base: string): string {
  try {
    const u = new URL(href, base);
    return u.searchParams.get("redirect_url") ?? u.toString();
  } catch {
    return href;
  }
}

export function parseAhmiaResults(html: string, base = AHMIA.clearnet): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];
  $("li.result").each((_, el) => {
    const node = $(el);
    const link = node.find("h4 a").first();
    const href = link.attr("href");
    if (!href) return;
    const url = onionTarget(href, base);
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (!host.endsWith(".onion")) return;
    const description = collapse(node.find("p").first().text());
    results.push(
      compact({
        source: "ahmia",
        title: collapse(link.text()) || host,
        url,
        snippet: description && !/^no description provided$/i.test(description) ? clip(description, SNIPPET_CHARS) : undefined,
        onion: true,
        last_seen: node.find(".lastSeen").attr("data-timestamp")?.trim() || undefined,
        venue: collapse(node.find("cite").first().text()) || host
      })
    );
  });
  return results;
}

async function getToken(http: HttpClient, base: string, viaTor: boolean, signal?: AbortSignal, refresh = false) {
  const cached = tokens.get(base);
  if (!refresh && cached && cached.expires > Date.now()) return cached;
  const html = await http.getText(`${base}/`, { tor: viaTor, signal, label: "Ahmia", headers: { accept: "text/html" } });
  const token = parseAhmiaToken(html);
  if (!token) throw new HttpError("Ahmia changed its search form (no session token found); the dark web search needs an update.", "http");
  const entry = { ...token, expires: Date.now() + TOKEN_TTL_MS };
  tokens.set(base, entry);
  return entry;
}

export const ahmia: Source = {
  id: "ahmia",
  name: "Ahmia",
  scope: "darkweb",
  channel: "darkweb",
  homepage: "https://ahmia.fi",
  description: "Search engine for Tor onion services that filters child-abuse content. Reached over the clear web by default, or through its onion mirror when DEEP_SEARCH_TOR_PROXY is set. Results are .onion links (open only through Tor).",
  isDefault: () => true,
  availability: config =>
    ahmiaBase(config)
      ? { ok: true }
      : { ok: false, reason: "this Tor setting (DEEP_SEARCH_AHMIA_MODE=onion or DEEP_SEARCH_TOR_ROUTE) needs DEEP_SEARCH_TOR_PROXY" },
  async search(q, { http, config }): Promise<SourcePage> {
    const target = ahmiaBase(config);
    if (!target) throw new HttpError("Ahmia onion mode requires DEEP_SEARCH_TOR_PROXY.", "tor");
    const { base, viaTor } = target;

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getToken(http, base, viaTor, q.signal, attempt > 0);
      const url = new URL(`${base}/search/`);
      url.searchParams.set("q", q.query);
      url.searchParams.set(token.name, token.value);
      const response = await http.request(url, {
        tor: viaTor,
        signal: q.signal,
        label: "Ahmia",
        redirect: "manual",
        maxBytes: 24 * 1024 * 1024,
        headers: { accept: "text/html", referer: `${base}/` }
      });
      if (response.status >= 300 && response.status < 400) continue; // stale token: Ahmia bounces to its home page
      if (!response.ok) throw new HttpError(`Ahmia returned HTTP ${response.status}.`, "http", response.status);
      const html = response.text();
      const results = parseAhmiaResults(html, base);
      return {
        results,
        total: results.length,
        complete: true,
        note: viaTor ? "Searched through Ahmia's onion mirror over Tor." : undefined
      };
    }
    throw new HttpError("Ahmia kept rejecting the search session token; try again in a minute.", "http");
  }
};
