import type { SearchQuery, Source, SourceDeps, SourceId, SourcePage } from "../../types.js";
import { clip, cleanDoi, stripTags, toYear } from "../../util/text.js";
import { HttpError } from "../../http/client.js";
import { authorsList, compact, SerialQueue, sleep, SNIPPET_CHARS } from "../common.js";

/** Crossref's public pool allows 1 concurrent request and 1 request/second: Crossref and SciELO share this queue. */
const queue = new SerialQueue(1_000);

interface CrossrefItem {
  DOI?: string;
  URL?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  "container-title"?: string[];
  issued?: { "date-parts"?: Array<Array<number | null>> };
  type?: string;
  abstract?: string;
  "is-referenced-by-count"?: number;
  language?: string;
  publisher?: string;
}

export interface CrossrefResponse {
  message?: { "total-results"?: number; items?: CrossrefItem[] };
}

/** Crossref member id of SciELO (FapUNIFESP), used to search SciELO's Latin American journals. */
export const SCIELO_MEMBER_ID = 530;

export function parseCrossref(data: CrossrefResponse, source: SourceId = "crossref"): SourcePage {
  const items = data.message?.items ?? [];
  return {
    total: data.message?.["total-results"],
    results: items.map(item => {
      const doi = cleanDoi(item.DOI);
      return compact({
        source,
        title: stripTags(item.title?.[0] ?? "(untitled)"),
        url: doi ? `https://doi.org/${doi}` : (item.URL ?? ""),
        snippet: clip(item.abstract ? stripTags(item.abstract).replace(/^abstract\s*/i, "") : undefined, SNIPPET_CHARS),
        authors: authorsList((item.author ?? []).map(a => a.name ?? [a.given, a.family].filter(Boolean).join(" "))),
        year: toYear(item.issued?.["date-parts"]?.[0]?.[0] ?? undefined),
        venue: item["container-title"]?.[0] ?? item.publisher,
        doi,
        type: item.type,
        citations: item["is-referenced-by-count"],
        language: item.language
      });
    })
  };
}

async function searchCrossref(q: SearchQuery, { http, config }: SourceDeps, source: SourceId, member?: number): Promise<SourcePage> {
  const url = new URL("https://api.crossref.org/works");
  // query.bibliographic ranks title/author matches better than the generic `query`
  url.searchParams.set("query.bibliographic", q.query);
  url.searchParams.set("rows", String(q.limit));
  url.searchParams.set("offset", String(Math.min(q.offset, 9_999)));
  url.searchParams.set("select", "DOI,URL,title,author,container-title,issued,type,abstract,is-referenced-by-count,publisher");
  const filters: string[] = [];
  if (q.yearFrom !== undefined) filters.push(`from-pub-date:${q.yearFrom}`);
  if (q.yearTo !== undefined) filters.push(`until-pub-date:${q.yearTo}`);
  if (member !== undefined) filters.push(`member:${member}`);
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  if (config.contactEmail) url.searchParams.set("mailto", config.contactEmail);
  const label = source === "scielo" ? "SciELO (via Crossref)" : "Crossref";
  const data = await queue.run(async () => {
    try {
      return await http.getJson<CrossrefResponse>(url, { signal: q.signal, label });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 429) throw error;
      await sleep(2_000); // one polite retry after the rate-limit window
      return http.getJson<CrossrefResponse>(url, { signal: q.signal, label });
    }
  });
  return parseCrossref(data, source);
}

export const crossref: Source = {
  id: "crossref",
  name: "Crossref",
  scope: "academic",
  channel: "academic",
  homepage: "https://www.crossref.org",
  description: "Metadata for ~170M DOIs from every major publisher, including SSRN working papers, reports and book chapters.",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  search: (q, deps) => searchCrossref(q, deps, "crossref")
};

export const scielo: Source = {
  id: "scielo",
  name: "SciELO",
  scope: "academic",
  channel: "academic",
  homepage: "https://scielo.org",
  description: "Brazilian and Latin American journals (SciELO collection, searched through Crossref member 530).",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  search: (q, deps) => searchCrossref(q, deps, "scielo", SCIELO_MEMBER_ID)
};
