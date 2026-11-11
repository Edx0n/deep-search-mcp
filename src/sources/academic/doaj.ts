import type { Source, SourcePage } from "../../types.js";
import { clip, cleanDoi, sanitizeLucene, stripTags, toYear } from "../../util/text.js";
import { authorsList, compact, pageWindow, SNIPPET_CHARS } from "../common.js";

interface DoajArticle {
  id?: string;
  bibjson?: {
    title?: string;
    abstract?: string;
    year?: string;
    journal?: { title?: string; language?: string[] };
    author?: Array<{ name?: string }>;
    link?: Array<{ type?: string; url?: string }>;
    identifier?: Array<{ type?: string; id?: string }>;
  };
}

export interface DoajResponse {
  total?: number;
  results?: DoajArticle[];
}

export function parseDoaj(data: DoajResponse, skip = 0, limit = Infinity): SourcePage {
  return {
    total: data.total,
    results: (data.results ?? []).slice(skip, skip + limit).map(a => {
      const b = a.bibjson ?? {};
      const doi = cleanDoi(b.identifier?.find(i => i.type?.toLowerCase() === "doi")?.id);
      const fulltext = b.link?.find(l => l.type === "fulltext")?.url;
      return compact({
        source: "doaj",
        title: stripTags(b.title ?? "(untitled)"),
        url: fulltext ?? (doi ? `https://doi.org/${doi}` : `https://doaj.org/article/${a.id ?? ""}`),
        snippet: clip(b.abstract ? stripTags(b.abstract) : undefined, SNIPPET_CHARS),
        authors: authorsList((b.author ?? []).map(x => x.name)),
        year: toYear(b.year),
        venue: b.journal?.title,
        doi,
        open_access: true,
        type: "journal-article",
        language: b.journal?.language?.[0]
      });
    })
  };
}

export const doaj: Source = {
  id: "doaj",
  name: "DOAJ",
  scope: "academic",
  channel: "academic",
  homepage: "https://doaj.org",
  description: "Directory of Open Access Journals: peer-reviewed, fully open-access articles (strong coverage of non-English journals).",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http }) {
    const { page, perPage, skip } = pageWindow(q.offset, q.limit, 100);
    let query = sanitizeLucene(q.query) || "*";
    if (q.yearFrom !== undefined || q.yearTo !== undefined) {
      query = `(${query}) AND bibjson.year:[${q.yearFrom ?? 1000} TO ${q.yearTo ?? 3000}]`;
    }
    const url = new URL(`https://doaj.org/api/v4/search/articles/${encodeURIComponent(query)}`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(perPage));
    const data = await http.getJson<DoajResponse>(url, { signal: q.signal, label: "DOAJ" });
    return parseDoaj(data, skip, q.limit);
  }
};
