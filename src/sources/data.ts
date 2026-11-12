import type { Source, SourcePage } from "../types.js";
import { clip, cleanDoi, sanitizeLucene, stripTags, toYear } from "../util/text.js";
import { authorsList, compact, pageWindow, SNIPPET_CHARS } from "./common.js";

// ---- DataCite: DOIs of datasets from Zenodo, Figshare, Dryad, institutional repositories... ----

interface DataciteRecord {
  id?: string;
  attributes?: {
    doi?: string;
    titles?: Array<{ title?: string }>;
    creators?: Array<{ name?: string }>;
    publisher?: string | { name?: string };
    publicationYear?: number | string;
    descriptions?: Array<{ description?: string; descriptionType?: string }>;
    url?: string;
    types?: { resourceTypeGeneral?: string; resourceType?: string };
    citationCount?: number;
  };
}

export interface DataciteResponse {
  data?: DataciteRecord[];
  meta?: { total?: number };
}

export function parseDatacite(data: DataciteResponse): SourcePage {
  return {
    total: data.meta?.total,
    results: (data.data ?? []).map(r => {
      const a = r.attributes ?? {};
      const doi = cleanDoi(a.doi ?? r.id);
      const description = a.descriptions?.find(d => d.descriptionType === "Abstract")?.description ?? a.descriptions?.[0]?.description;
      return compact({
        source: "datacite",
        title: stripTags(a.titles?.[0]?.title ?? "(untitled)"),
        url: doi ? `https://doi.org/${doi}` : (a.url ?? ""),
        snippet: clip(description ? stripTags(description) : undefined, SNIPPET_CHARS),
        authors: authorsList((a.creators ?? []).map(c => c.name)),
        year: toYear(a.publicationYear),
        venue: typeof a.publisher === "string" ? a.publisher : a.publisher?.name,
        doi,
        type: a.types?.resourceType || a.types?.resourceTypeGeneral?.toLowerCase(),
        citations: a.citationCount || undefined
      });
    })
  };
}

export const datacite: Source = {
  id: "datacite",
  name: "DataCite",
  scope: "data",
  // Open repositories accept user uploads with light moderation: screened with the web rules
  channel: "web",
  homepage: "https://datacite.org",
  description: "Research datasets with DOIs from thousands of repositories (Zenodo, Figshare, Dryad, Dataverse, university archives).",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http }) {
    const { page, perPage, skip } = pageWindow(q.offset, q.limit, 100);
    let query = sanitizeLucene(q.query) || "*";
    if (q.yearFrom !== undefined || q.yearTo !== undefined) {
      query = `(${query}) AND publicationYear:[${q.yearFrom ?? 1000} TO ${q.yearTo ?? 3000}]`;
    }
    const url = new URL("https://api.datacite.org/dois");
    url.searchParams.set("query", query);
    url.searchParams.set("resource-type-id", "dataset");
    url.searchParams.set("page[size]", String(perPage));
    url.searchParams.set("page[number]", String(page));
    url.searchParams.set("fields[dois]", "doi,titles,creators,publisher,publicationYear,descriptions,url,types,citationCount");
    const data = await http.getJson<DataciteResponse>(url, {
      signal: q.signal,
      label: "DataCite",
      headers: { accept: "application/vnd.api+json" }
    });
    const page_ = parseDatacite(data);
    return { ...page_, results: page_.results.slice(skip, skip + q.limit) };
  }
};

// ---- Zenodo: datasets, software, reports, posters and other grey literature ----

interface ZenodoHit {
  id?: number;
  doi?: string;
  links?: { self_html?: string; html?: string };
  metadata?: {
    title?: string;
    publication_date?: string;
    creators?: Array<{ name?: string }>;
    description?: string;
    resource_type?: { title?: string; type?: string };
    access_right?: string;
    language?: string;
  };
}

export interface ZenodoResponse {
  hits?: { total?: number; hits?: ZenodoHit[] };
}

export function parseZenodo(data: ZenodoResponse): SourcePage {
  return {
    total: data.hits?.total,
    results: (data.hits?.hits ?? []).map(h => {
      const m = h.metadata ?? {};
      return compact({
        source: "zenodo",
        title: stripTags(m.title ?? "(untitled)"),
        url: h.links?.self_html ?? h.links?.html ?? `https://zenodo.org/records/${h.id ?? ""}`,
        snippet: clip(m.description ? stripTags(m.description) : undefined, SNIPPET_CHARS),
        authors: authorsList((m.creators ?? []).map(c => c.name)),
        year: toYear(m.publication_date),
        date: m.publication_date,
        venue: "Zenodo",
        doi: cleanDoi(h.doi),
        open_access: m.access_right ? m.access_right === "open" : undefined,
        type: m.resource_type?.title?.toLowerCase() ?? m.resource_type?.type,
        language: m.language
      });
    })
  };
}

export const zenodo: Source = {
  id: "zenodo",
  name: "Zenodo",
  scope: "data",
  channel: "web",
  homepage: "https://zenodo.org",
  description: "CERN's open repository: datasets, software, reports, presentations and other grey literature that journals never index.",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http }) {
    const { page, perPage, skip } = pageWindow(q.offset, q.limit, 25);
    let query = sanitizeLucene(q.query) || "*";
    if (q.yearFrom !== undefined || q.yearTo !== undefined) {
      query = `(${query}) AND publication_date:[${q.yearFrom ?? 1000}-01-01 TO ${q.yearTo ?? 3000}-12-31]`;
    }
    const url = new URL("https://zenodo.org/api/records");
    url.searchParams.set("q", query);
    url.searchParams.set("size", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "bestmatch");
    const data = await http.getJson<ZenodoResponse>(url, { signal: q.signal, label: "Zenodo", maxBytes: 20 * 1024 * 1024 });
    const parsed = parseZenodo(data);
    return { ...parsed, results: parsed.results.slice(skip, skip + q.limit) };
  }
};
