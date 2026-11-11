import type { Source, SourcePage } from "../../types.js";
import { clip, cleanDoi } from "../../util/text.js";
import { authorsList, compact, pageWindow, SNIPPET_CHARS } from "../common.js";

interface OpenAlexWork {
  id: string;
  doi?: string | null;
  display_name?: string | null;
  title?: string | null;
  publication_year?: number | null;
  type?: string | null;
  language?: string | null;
  cited_by_count?: number | null;
  authorships?: Array<{ author?: { display_name?: string | null } | null }> | null;
  primary_location?: {
    landing_page_url?: string | null;
    pdf_url?: string | null;
    source?: { display_name?: string | null } | null;
  } | null;
  open_access?: { is_oa?: boolean | null; oa_url?: string | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
}

export interface OpenAlexResponse {
  meta?: { count?: number };
  results?: OpenAlexWork[];
}

/** OpenAlex ships abstracts as an inverted index (word → positions); rebuild the text. */
export function rebuildAbstract(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) if (p >= 0 && p < 5000) words[p] = word;
  }
  const text = words.filter(Boolean).join(" ");
  return text || undefined;
}

export function parseOpenAlex(data: OpenAlexResponse, skip = 0, limit = Infinity): SourcePage {
  const works = (data.results ?? []).slice(skip, skip + limit);
  return {
    total: data.meta?.count,
    results: works.map(w => {
      const doi = cleanDoi(w.doi);
      return compact({
        source: "openalex",
        title: (w.display_name ?? w.title ?? "(untitled)").trim(),
        url: doi ? `https://doi.org/${doi}` : (w.primary_location?.landing_page_url ?? w.id),
        snippet: clip(rebuildAbstract(w.abstract_inverted_index), SNIPPET_CHARS),
        authors: authorsList((w.authorships ?? []).map(a => a.author?.display_name)),
        year: w.publication_year ?? undefined,
        venue: w.primary_location?.source?.display_name ?? undefined,
        doi,
        pdf_url: w.open_access?.oa_url ?? w.primary_location?.pdf_url ?? undefined,
        open_access: w.open_access?.is_oa ?? undefined,
        type: w.type ?? undefined,
        citations: w.cited_by_count ?? undefined,
        language: w.language ?? undefined
      });
    })
  };
}

export const openalex: Source = {
  id: "openalex",
  name: "OpenAlex",
  scope: "academic",
  channel: "academic",
  homepage: "https://openalex.org",
  description: "Open catalog of ~250M scholarly works (journals, repositories, theses, books) with open-access links. Optional OPENALEX_API_KEY raises the daily budget.",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http, config }) {
    const { page, perPage, skip } = pageWindow(q.offset, q.limit, 200);
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", q.query);
    url.searchParams.set("per-page", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set(
      "select",
      "id,doi,display_name,publication_year,authorships,primary_location,open_access,cited_by_count,abstract_inverted_index,type,language"
    );
    const years =
      q.yearFrom !== undefined && q.yearTo !== undefined
        ? `${q.yearFrom}-${q.yearTo}`
        : q.yearFrom !== undefined
          ? `>${q.yearFrom - 1}`
          : q.yearTo !== undefined
            ? `<${q.yearTo + 1}`
            : undefined;
    if (years) url.searchParams.set("filter", `publication_year:${years}`);
    if (config.keys.openalex) url.searchParams.set("api_key", config.keys.openalex);
    if (config.contactEmail) url.searchParams.set("mailto", config.contactEmail);
    const data = await http.getJson<OpenAlexResponse>(url, { signal: q.signal, label: "OpenAlex" });
    return parseOpenAlex(data, skip, q.limit);
  }
};
