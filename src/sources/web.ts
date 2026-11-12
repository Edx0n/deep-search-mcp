import { load } from "cheerio";
import { HttpError } from "../http/client.js";
import type { Source, SourcePage } from "../types.js";
import { clip, collapse, decodeEntities } from "../util/text.js";
import { compact, pageWindow, SNIPPET_CHARS } from "./common.js";

// ---- Marginalia: independent index that favors small, non-commercial, text-heavy sites ----

export interface MarginaliaResponse {
  page?: number;
  pages?: number;
  results?: Array<{ url?: string; title?: string; description?: string; format?: string; quality?: number }>;
}

export function parseMarginalia(data: MarginaliaResponse): SourcePage & { hasMore: boolean } {
  return {
    hasMore: data.page !== undefined && data.pages !== undefined ? data.page < data.pages : false,
    results: (data.results ?? [])
      .filter(r => r.url)
      .map(r =>
        compact({
          source: "marginalia",
          title: collapse(r.title || r.url || ""),
          url: r.url!,
          snippet: clip(r.description, SNIPPET_CHARS),
          type: r.format
        })
      )
  };
}

export const marginalia: Source = {
  id: "marginalia",
  name: "Marginalia Search",
  scope: "web",
  channel: "web",
  homepage: "https://marginalia-search.com",
  description: "Independent search engine with its own index that favors small, non-commercial and personal websites that big engines bury. The shared 'public' key is often rate-limited; a free personal key is available by e-mail (MARGINALIA_API_KEY).",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http, config }) {
    const { page, perPage, skip } = pageWindow(q.offset, q.limit, 100);
    const url = new URL("https://api2.marginalia-search.com/search");
    url.searchParams.set("query", q.query);
    url.searchParams.set("count", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("nsfw", "1"); // Marginalia's own filter for extreme content
    const key = config.keys.marginalia ?? "public";
    try {
      const data = await http.getJson<MarginaliaResponse>(url, { signal: q.signal, label: "Marginalia", headers: { "API-Key": key } });
      const parsed = parseMarginalia(data);
      return { results: parsed.results.slice(skip, skip + q.limit), total: parsed.hasMore ? undefined : q.offset + parsed.results.length - skip };
    } catch (error) {
      if (error instanceof HttpError && (error.status === 429 || error.status === 503) && !config.keys.marginalia) {
        throw new HttpError(
          "Marginalia's shared 'public' API key is over its rate limit. A free personal key (e-mail contact@marginalia-search.com) set as MARGINALIA_API_KEY avoids this.",
          "http",
          error.status
        );
      }
      throw error;
    }
  }
};

// ---- Wiby: a search engine for the "classic", lightweight personal web ----

export type WibyResponse = Array<{ URL?: string; Title?: string; Snippet?: string; Description?: string }>;

export const WIBY_PAGE_SIZE = 12;

export function parseWiby(data: WibyResponse): SourcePage {
  return {
    results: (Array.isArray(data) ? data : [])
      .filter(r => r.URL)
      .map(r =>
        compact({
          source: "wiby",
          title: collapse(decodeEntities(r.Title || r.URL || "")),
          url: r.URL!,
          snippet: clip(decodeEntities(r.Snippet || r.Description || ""), SNIPPET_CHARS)
        })
      )
  };
}

export const wiby: Source = {
  id: "wiby",
  name: "Wiby",
  scope: "web",
  channel: "web",
  homepage: "https://wiby.me",
  description: "Search engine for the old-style, lightweight personal web: hobby pages, essays and documentation that rarely rank on Google.",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http }) {
    const page = Math.floor(q.offset / WIBY_PAGE_SIZE) + 1;
    const skip = q.offset % WIBY_PAGE_SIZE;
    const url = new URL("https://wiby.me/json/");
    url.searchParams.set("q", q.query);
    if (page > 1) url.searchParams.set("p", String(page));
    const data = await http.getJson<WibyResponse>(url, { signal: q.signal, label: "Wiby" });
    const parsed = parseWiby(data);
    return { results: parsed.results.slice(skip, skip + q.limit) };
  }
};

// ---- DuckDuckGo (HTML endpoint): Bing-based results plus DuckDuckGo's own crawler, no Google ----

export const DUCKDUCKGO_ENDPOINTS = {
  clearnet: "https://html.duckduckgo.com/html/",
  /** DuckDuckGo's official onion service (no exit-node bot checks when the request goes through Tor anyway). */
  onion: "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/html/"
};

export function isDuckDuckGoChallenge(html: string): boolean {
  return /anomaly-modal|challenge-form|bots use DuckDuckGo too|g-recaptcha|h-captcha/i.test(html);
}

/** DuckDuckGo wraps outbound links as //duckduckgo.com/l/?uddg=<encoded url>. */
export function unwrapDuckDuckGoLink(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    if (u.hostname.endsWith("duckduckgo.com") && target) return target;
    return u.toString();
  } catch {
    return href;
  }
}

export function parseDuckDuckGo(html: string): SourcePage {
  const $ = load(html);
  const results: SourcePage["results"] = [];
  $(".result").each((_, el) => {
    const node = $(el);
    if (node.hasClass("result--ad") || node.find(".badge--ad").length) return;
    const link = node.find("a.result__a").first();
    const href = link.attr("href");
    if (!href) return;
    const url = unwrapDuckDuckGoLink(href);
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) return;
    results.push(
      compact({
        source: "duckduckgo",
        title: collapse(link.text()),
        url,
        snippet: clip(node.find(".result__snippet").first().text(), SNIPPET_CHARS)
      })
    );
  });
  return { results };
}

export const duckduckgo: Source = {
  id: "duckduckgo",
  name: "DuckDuckGo",
  scope: "web",
  channel: "web",
  homepage: "https://duckduckgo.com",
  description: "General web search without Google (Bing index plus DuckDuckGo's crawler), no personalization. Only the first page is available; bot checks are reported, never bypassed.",
  isDefault: () => true,
  availability: () => ({ ok: true }),
  async search(q, { http }) {
    // On the clear web it identifies itself honestly (deep-search-mcp User-Agent); bot checks are reported,
    // never evaded. When the request goes through Tor anyway, DuckDuckGo's official onion service is used.
    const endpoint = http.routesThroughTor() ? DUCKDUCKGO_ENDPOINTS.onion : DUCKDUCKGO_ENDPOINTS.clearnet;
    const response = await http.request(endpoint, {
      method: "POST",
      signal: q.signal,
      label: "DuckDuckGo",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ q: q.query }).toString()
    });
    const html = response.text();
    if (response.status === 202 || response.status === 403 || isDuckDuckGoChallenge(html)) {
      throw new HttpError(
        "DuckDuckGo answered with a human-verification (bot) check. This server does not solve or bypass CAPTCHAs; try again later or rely on the other web sources.",
        "http",
        response.status
      );
    }
    if (!response.ok) throw new HttpError(`DuckDuckGo returned HTTP ${response.status}.`, "http", response.status);
    const parsed = parseDuckDuckGo(html);
    const page = parsed.results.slice(q.offset, q.offset + q.limit);
    return {
      results: page,
      total: parsed.results.length,
      note: q.offset >= parsed.results.length && parsed.results.length > 0 ? "DuckDuckGo's HTML endpoint only exposes its first page of results." : undefined
    };
  }
};

// ---- Brave Search API: Brave's own independent index (optional, needs a key) ----

export interface BraveResponse {
  query?: { more_results_available?: boolean };
  web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string; language?: string }> };
}

export function parseBrave(data: BraveResponse): SourcePage & { hasMore: boolean } {
  return {
    hasMore: Boolean(data.query?.more_results_available),
    results: (data.web?.results ?? [])
      .filter(r => r.url)
      .map(r =>
        compact({
          source: "brave",
          title: collapse(load(`<p>${r.title ?? ""}</p>`).text()),
          url: r.url!,
          snippet: clip(load(`<p>${r.description ?? ""}</p>`).text(), SNIPPET_CHARS),
          date: r.page_age?.slice(0, 10),
          language: r.language
        })
      )
  };
}

export const brave: Source = {
  id: "brave",
  name: "Brave Search",
  scope: "web",
  channel: "web",
  homepage: "https://brave.com/search/api/",
  description: "Brave's fully independent web index (not Google or Bing). Requires BRAVE_API_KEY.",
  isDefault: config => Boolean(config.keys.brave),
  availability: config => (config.keys.brave ? { ok: true } : { ok: false, reason: "needs BRAVE_API_KEY" }),
  async search(q, { http, config }) {
    const { page, perPage, skip } = pageWindow(q.offset, q.limit, 20);
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", q.query);
    url.searchParams.set("count", String(Math.min(perPage, 20)));
    url.searchParams.set("offset", String(Math.min(page - 1, 9)));
    url.searchParams.set("safesearch", "strict");
    const data = await http.getJson<BraveResponse>(url, {
      signal: q.signal,
      label: "Brave Search",
      headers: { "x-subscription-token": config.keys.brave ?? "" }
    });
    const parsed = parseBrave(data);
    return { results: parsed.results.slice(skip, skip + q.limit), total: parsed.hasMore ? undefined : q.offset + parsed.results.length - skip };
  }
};
