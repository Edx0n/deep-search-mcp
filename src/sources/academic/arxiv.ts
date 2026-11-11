import { XMLParser } from "fast-xml-parser";
import type { Source, SourcePage } from "../../types.js";
import { asArray, clip, cleanDoi, collapse, toYear } from "../../util/text.js";
import { authorsList, compact, SNIPPET_CHARS } from "../common.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true
});

interface AtomLink {
  "@_href"?: string;
  "@_title"?: string;
  "@_rel"?: string;
  "@_type"?: string;
}

interface AtomEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  author?: { name?: string } | Array<{ name?: string }>;
  link?: AtomLink | AtomLink[];
  doi?: string;
  primary_category?: { "@_term"?: string };
}

/** Builds an arXiv search_query: every keyword must appear (AND), optional submission-date range. */
export function arxivQuery(query: string, yearFrom?: number, yearTo?: number): string {
  const terms = query
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter(t => t.length > 0 && !/^(and|or|not)$/i.test(t))
    .slice(0, 12);
  let q = terms.length ? terms.map(t => `all:${t}`).join(" AND ") : "all:*";
  if (yearFrom !== undefined || yearTo !== undefined) {
    q += ` AND submittedDate:[${yearFrom ?? 1991}01010000 TO ${yearTo ?? 2100}12312359]`;
  }
  return q;
}

export function parseArxiv(xml: string): SourcePage {
  const doc = parser.parse(xml) as { feed?: { totalResults?: string | number; entry?: AtomEntry | AtomEntry[] } };
  const feed = doc.feed ?? {};
  const entries = asArray(feed.entry);
  const total = Number(feed.totalResults);
  return {
    total: Number.isFinite(total) ? total : undefined,
    results: entries
      .filter(e => e.id && !/arxiv\.org\/api\/errors/.test(e.id))
      .map(e => {
        const links = asArray(e.link);
        const abs = links.find(l => l["@_rel"] === "alternate")?.["@_href"] ?? e.id ?? "";
        const pdf = links.find(l => l["@_title"] === "pdf")?.["@_href"];
        return compact({
          source: "arxiv",
          title: collapse(e.title ?? "(untitled)"),
          url: abs.replace(/^http:/, "https:"),
          snippet: clip(e.summary, SNIPPET_CHARS),
          authors: authorsList(asArray(e.author).map(a => a.name)),
          year: toYear(e.published),
          date: e.published?.slice(0, 10),
          venue: e.primary_category?.["@_term"] ? `arXiv ${e.primary_category["@_term"]}` : "arXiv",
          doi: cleanDoi(e.doi),
          pdf_url: pdf?.replace(/^http:/, "https:"),
          open_access: true,
          type: "preprint"
        });
      })
  };
}

export const arxiv: Source = {
  id: "arxiv",
  name: "arXiv",
  scope: "academic",
  channel: "academic",
  homepage: "https://arxiv.org",
  description: "Preprints in physics, mathematics, computer science, quantitative biology, finance and economics (all open access).",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http }) {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", arxivQuery(q.query, q.yearFrom, q.yearTo));
    url.searchParams.set("start", String(q.offset));
    url.searchParams.set("max_results", String(q.limit));
    url.searchParams.set("sortBy", "relevance");
    const xml = await http.getText(url, { signal: q.signal, label: "arXiv" });
    return parseArxiv(xml);
  }
};
