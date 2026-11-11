import { HttpError } from "../../http/client.js";
import type { Source, SourcePage } from "../../types.js";
import { clip, cleanDoi } from "../../util/text.js";
import { authorsList, compact, SNIPPET_CHARS } from "../common.js";

interface S2Paper {
  paperId?: string;
  title?: string;
  year?: number | null;
  url?: string;
  abstract?: string | null;
  authors?: Array<{ name?: string }>;
  venue?: string | null;
  openAccessPdf?: { url?: string | null } | null;
  citationCount?: number | null;
  externalIds?: { DOI?: string } | null;
  publicationTypes?: string[] | null;
}

export interface S2Response {
  total?: number;
  data?: S2Paper[];
}

export function parseSemanticScholar(data: S2Response): SourcePage {
  return {
    total: data.total,
    results: (data.data ?? []).map(p =>
      compact({
        source: "semantic_scholar",
        title: p.title?.trim() || "(untitled)",
        url: p.url ?? `https://www.semanticscholar.org/paper/${p.paperId ?? ""}`,
        snippet: clip(p.abstract ?? undefined, SNIPPET_CHARS),
        authors: authorsList((p.authors ?? []).map(a => a.name)),
        year: p.year ?? undefined,
        venue: p.venue || undefined,
        doi: cleanDoi(p.externalIds?.DOI),
        pdf_url: p.openAccessPdf?.url || undefined,
        open_access: p.openAccessPdf?.url ? true : undefined,
        type: p.publicationTypes?.[0],
        citations: p.citationCount ?? undefined
      })
    )
  };
}

export const semanticScholar: Source = {
  id: "semantic_scholar",
  name: "Semantic Scholar",
  scope: "academic",
  channel: "academic",
  homepage: "https://www.semanticscholar.org",
  description: "AI-assisted scholarly search (~200M papers) with citation counts. The keyless API is almost always rate-limited, so it runs by default only with SEMANTIC_SCHOLAR_API_KEY.",
  isDefault: config => Boolean(config.keys.semanticScholar),
  availability: () => ({ ok: true }),
  async search(q, { http, config }) {
    const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
    url.searchParams.set("query", q.query);
    url.searchParams.set("offset", String(q.offset));
    url.searchParams.set("limit", String(q.limit));
    url.searchParams.set("fields", "title,year,url,abstract,authors,venue,openAccessPdf,citationCount,externalIds,publicationTypes");
    if (q.yearFrom !== undefined || q.yearTo !== undefined) url.searchParams.set("year", `${q.yearFrom ?? ""}-${q.yearTo ?? ""}`);
    const headers: Record<string, string> = {};
    if (config.keys.semanticScholar) headers["x-api-key"] = config.keys.semanticScholar;
    try {
      return parseSemanticScholar(await http.getJson<S2Response>(url, { signal: q.signal, label: "Semantic Scholar", headers }));
    } catch (error) {
      if (error instanceof HttpError && error.status === 429 && !config.keys.semanticScholar) {
        throw new HttpError(
          "Semantic Scholar's shared keyless quota is exhausted (HTTP 429). Request a free key at https://www.semanticscholar.org/product/api and set SEMANTIC_SCHOLAR_API_KEY.",
          "http",
          429
        );
      }
      throw error;
    }
  }
};
