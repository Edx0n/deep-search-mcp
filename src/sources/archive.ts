import type { Source, SourcePage } from "../types.js";
import { clip, firstString, sanitizeLucene, stripTags, toYear } from "../util/text.js";
import { authorsList, compact, pageWindow, SNIPPET_CHARS } from "./common.js";

interface IaDoc {
  identifier?: string;
  title?: string | string[];
  description?: string | string[];
  mediatype?: string;
  date?: string;
  year?: string | number;
  creator?: string | string[];
}

export interface IaResponse {
  response?: { numFound?: number; docs?: IaDoc[] };
}

export function parseInternetArchive(data: IaResponse): SourcePage {
  return {
    total: data.response?.numFound,
    results: (data.response?.docs ?? []).map(d => {
      const creators = Array.isArray(d.creator) ? d.creator : d.creator ? [d.creator] : [];
      const description = Array.isArray(d.description) ? d.description.join(" ") : d.description;
      return compact({
        source: "internet_archive",
        title: stripTags(firstString(d.title) ?? d.identifier ?? "(untitled)"),
        url: `https://archive.org/details/${encodeURIComponent(d.identifier ?? "")}`,
        snippet: clip(description ? stripTags(description) : undefined, SNIPPET_CHARS),
        authors: authorsList(creators),
        year: toYear(d.year) ?? toYear(d.date),
        date: d.date?.slice(0, 10),
        venue: "Internet Archive",
        type: d.mediatype
      });
    })
  };
}

export const internetArchive: Source = {
  id: "internet_archive",
  name: "Internet Archive",
  scope: "archive",
  channel: "web",
  homepage: "https://archive.org",
  description: "Digitized books, government and corporate documents, magazines, old software, audio and video, including material taken offline elsewhere.",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http }) {
    const { page, perPage, skip } = pageWindow(q.offset, q.limit, 100);
    // Matching title/subject (not the full text of transcripts) keeps results on topic
    const terms = sanitizeLucene(q.query) || "*";
    let query = `(title:(${terms}) OR subject:(${terms})) AND -mediatype:(collection OR account OR web)`;
    if (q.yearFrom !== undefined || q.yearTo !== undefined) {
      query += ` AND year:[${q.yearFrom ?? 1000} TO ${q.yearTo ?? 3000}]`;
    }
    const url = new URL("https://archive.org/advancedsearch.php");
    url.searchParams.set("q", query);
    for (const field of ["identifier", "title", "description", "mediatype", "date", "year", "creator"]) {
      url.searchParams.append("fl[]", field);
    }
    url.searchParams.set("rows", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("output", "json");
    const data = await http.getJson<IaResponse>(url, { signal: q.signal, label: "Internet Archive" });
    const parsed = parseInternetArchive(data);
    return { ...parsed, results: parsed.results.slice(skip, skip + q.limit) };
  }
};
