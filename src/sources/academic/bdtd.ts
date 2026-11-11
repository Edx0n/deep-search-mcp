import type { Source, SourcePage } from "../../types.js";
import { clip, firstString, toYear } from "../../util/text.js";
import { authorsList, compact, pageWindow, SNIPPET_CHARS } from "../common.js";

interface BdtdRecord {
  id?: string;
  title?: string;
  primaryAuthors?: string[];
  authors?: { primary?: Record<string, unknown> };
  formats?: string[];
  languages?: string[];
  urls?: Array<{ url?: string }>;
  publicationDates?: string[];
  summary?: string[];
}

export interface BdtdResponse {
  resultCount?: number;
  records?: BdtdRecord[];
  status?: string;
}

const FORMAT_LABELS: Record<string, string> = {
  masterThesis: "master's thesis",
  doctoralThesis: "doctoral thesis",
  bachelorThesis: "bachelor's thesis"
};

export function parseBdtd(data: BdtdResponse, skip = 0, limit = Infinity): SourcePage {
  return {
    total: data.resultCount,
    results: (data.records ?? [])
      .slice(skip, skip + limit)
      .filter(r => r.title?.trim()) // a few records come back without any title: they are noise
      .map(r => {
      const format = r.formats?.[0];
      const authors = r.primaryAuthors?.length ? r.primaryAuthors : Object.keys(r.authors?.primary ?? {});
      return compact({
        source: "bdtd",
        title: r.title!.trim(),
        url: r.urls?.find(u => u.url)?.url ?? `https://bdtd.ibict.br/vufind/Record/${encodeURIComponent(r.id ?? "")}`,
        snippet: clip(firstString(r.summary), SNIPPET_CHARS),
        authors: authorsList(authors),
        year: toYear(firstString(r.publicationDates)),
        venue: "BDTD (Brazilian theses & dissertations)",
        open_access: true,
        type: format ? (FORMAT_LABELS[format] ?? format) : "thesis",
        language: r.languages?.[0]
      });
    })
  };
}

export const bdtd: Source = {
  id: "bdtd",
  name: "BDTD",
  scope: "academic",
  channel: "academic",
  homepage: "https://bdtd.ibict.br",
  description: "Brazilian Digital Library of Theses and Dissertations (IBICT): master's and doctoral theses from Brazilian universities, mostly open access.",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http }) {
    const { page, perPage, skip } = pageWindow(q.offset, q.limit, 100);
    const url = new URL("https://bdtd.ibict.br/vufind/api/v1/search");
    url.searchParams.set("lookfor", q.query);
    url.searchParams.set("type", "AllFields");
    url.searchParams.set("limit", String(perPage));
    url.searchParams.set("page", String(page));
    for (const field of ["id", "title", "primaryAuthors", "formats", "languages", "urls", "publicationDates", "summary"]) {
      url.searchParams.append("field[]", field);
    }
    if (q.yearFrom !== undefined || q.yearTo !== undefined) {
      url.searchParams.append("filter[]", `publishDate:"[${q.yearFrom ?? "*"} TO ${q.yearTo ?? "*"}]"`);
    }
    const data = await http.getJson<BdtdResponse>(url, { signal: q.signal, label: "BDTD" });
    return parseBdtd(data, skip, q.limit);
  }
};
