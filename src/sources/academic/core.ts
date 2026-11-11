import { HttpError } from "../../http/client.js";
import type { Source, SourcePage } from "../../types.js";
import { clip, cleanDoi, sanitizeLucene, stripTags } from "../../util/text.js";
import { authorsList, compact, SNIPPET_CHARS } from "../common.js";

interface CoreWork {
  id?: number | string;
  title?: string;
  abstract?: string | null;
  authors?: Array<{ name?: string }>;
  doi?: string | null;
  downloadUrl?: string | null;
  yearPublished?: number | null;
  publisher?: string | null;
  journals?: Array<{ title?: string | null }>;
  documentType?: string | null;
  language?: { code?: string; name?: string } | null;
  links?: Array<{ type?: string; url?: string }>;
}

export interface CoreResponse {
  totalHits?: number;
  results?: CoreWork[];
}

export function parseCore(data: CoreResponse): SourcePage {
  return {
    total: data.totalHits,
    results: (data.results ?? []).map(w => {
      const doi = cleanDoi(w.doi ?? undefined);
      const display = w.links?.find(l => l.type === "display")?.url ?? (w.id !== undefined ? `https://core.ac.uk/works/${w.id}` : undefined);
      return compact({
        source: "core",
        title: stripTags(w.title ?? "(untitled)"),
        url: display ?? (doi ? `https://doi.org/${doi}` : ""),
        snippet: clip(w.abstract ? stripTags(w.abstract) : undefined, SNIPPET_CHARS),
        authors: authorsList((w.authors ?? []).map(a => a.name)),
        year: w.yearPublished ?? undefined,
        venue: w.journals?.find(j => j.title)?.title ?? w.publisher ?? undefined,
        doi,
        pdf_url: w.downloadUrl ?? undefined,
        open_access: w.downloadUrl ? true : undefined,
        type: w.documentType ?? undefined,
        language: w.language?.code ?? undefined
      });
    })
  };
}

export const core: Source = {
  id: "core",
  name: "CORE",
  scope: "academic",
  channel: "academic",
  homepage: "https://core.ac.uk",
  description: "Aggregator of ~300M open-access papers from institutional repositories worldwide; finds free versions of paywalled articles. Optional CORE_API_KEY (free) avoids tight rate limits.",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http, config }) {
    let query = `(${sanitizeLucene(q.query)})`;
    if (q.yearFrom !== undefined) query += ` AND yearPublished>=${q.yearFrom}`;
    if (q.yearTo !== undefined) query += ` AND yearPublished<=${q.yearTo}`;
    const url = new URL("https://api.core.ac.uk/v3/search/works/");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(q.limit));
    url.searchParams.set("offset", String(q.offset));
    const headers: Record<string, string> = {};
    if (config.keys.core) headers.authorization = `Bearer ${config.keys.core}`;
    try {
      // Results embed full texts, so responses are large
      const data = await http.getJson<CoreResponse>(url, { signal: q.signal, label: "CORE", headers, maxBytes: 40 * 1024 * 1024 });
      return parseCore(data);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 429 || error.status === 401) && !config.keys.core) {
        throw new HttpError(
          `CORE rate limit reached for anonymous use (HTTP ${error.status}). A free key from https://core.ac.uk/services/api (env CORE_API_KEY) lifts it.`,
          "http",
          error.status
        );
      }
      throw error;
    }
  }
};
