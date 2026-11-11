import type { Source, SourcePage } from "../../types.js";
import { clip, cleanDoi, sanitizeLucene, stripTags, toYear } from "../../util/text.js";
import { compact, SNIPPET_CHARS } from "../common.js";

interface EpmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalInfo?: { journal?: { title?: string } };
  journalTitle?: string;
  pubYear?: string;
  abstractText?: string;
  isOpenAccess?: string;
  citedByCount?: number;
  language?: string;
  pubTypeList?: { pubType?: string[] };
  fullTextUrlList?: { fullTextUrl?: Array<{ availabilityCode?: string; documentStyle?: string; url?: string }> };
}

export interface EpmcResponse {
  hitCount?: number;
  resultList?: { result?: EpmcResult[] };
}

export function parseEuropePmc(data: EpmcResponse, skip = 0, limit = Infinity): SourcePage {
  const results = (data.resultList?.result ?? []).slice(skip, skip + limit);
  return {
    total: data.hitCount,
    results: results.map(r => {
      const free = r.fullTextUrlList?.fullTextUrl?.filter(u => u.availabilityCode === "OA" || u.availabilityCode === "F") ?? [];
      const pdf = free.find(u => u.documentStyle === "pdf")?.url;
      const url = r.pmcid
        ? `https://europepmc.org/article/PMC/${r.pmcid}`
        : `https://europepmc.org/article/${r.source ?? "MED"}/${r.id ?? r.pmid ?? ""}`;
      return compact({
        source: "europepmc",
        title: stripTags(r.title ?? "(untitled)").replace(/\.$/, ""),
        url,
        snippet: clip(r.abstractText ? stripTags(r.abstractText) : undefined, SNIPPET_CHARS),
        authors: r.authorString ? r.authorString.replace(/\.$/, "").split(/,\s*/).slice(0, 8) : undefined,
        year: toYear(r.pubYear),
        venue: r.journalInfo?.journal?.title ?? r.journalTitle,
        doi: cleanDoi(r.doi),
        pdf_url: pdf,
        open_access: r.isOpenAccess === "Y" ? true : r.isOpenAccess === "N" ? false : undefined,
        type: r.pubTypeList?.pubType?.[0],
        citations: r.citedByCount,
        language: r.language
      });
    })
  };
}

export const europepmc: Source = {
  id: "europepmc",
  name: "Europe PMC",
  scope: "academic",
  channel: "academic",
  homepage: "https://europepmc.org",
  description: "Life sciences and health literature: all of PubMed/MEDLINE plus PMC full texts, preprints and patents.",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http }) {
    // Europe PMC paginates with cursors only, so fetch the first offset+limit hits and skip.
    const pageSize = Math.min(q.offset + q.limit, 1000);
    const skip = q.offset;
    let query = `(${sanitizeLucene(q.query)})`;
    if (q.yearFrom !== undefined || q.yearTo !== undefined) {
      query += ` AND PUB_YEAR:[${q.yearFrom ?? 1000} TO ${q.yearTo ?? 3000}]`;
    }
    const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
    url.searchParams.set("query", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "core");
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("cursorMark", "*");
    const data = await http.getJson<EpmcResponse>(url, { signal: q.signal, label: "Europe PMC", maxBytes: 20 * 1024 * 1024 });
    return parseEuropePmc(data, skip, q.limit);
  }
};
