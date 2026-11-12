import { extractHtml } from "../extract/html.js";
import { extractPdf } from "../extract/pdf.js";
import { HttpError, isOnionHost, statusMessage, type HttpResponse } from "../http/client.js";
import { embeddedOnions } from "../safety/banned.js";
import { SafetyGuard } from "../safety/guard.js";
import { isScholarlyHost } from "../safety/scholarly.js";
import { SafetyRefusal, type SearchDeps } from "../search.js";
import type { Channel } from "../types.js";

export interface PageInput {
  url: string;
  max_chars: number;
  start_char: number;
  include_links: boolean;
}

export interface PageLink {
  text: string;
  url: string;
  onion?: boolean;
}

export interface PageOutcome {
  requested_url: string;
  final_url: string;
  via_tor: boolean;
  status: number;
  content_type: string;
  title?: string;
  description?: string;
  language?: string;
  pdf_pages?: number;
  /** Set when a limit stopped PDF extraction early. */
  pdf_pages_read?: number;
  /** True when the extracted text was cut at the size, page or time limit. */
  text_truncated?: boolean;
  total_chars: number;
  start_char: number;
  end_char: number;
  has_more: boolean;
  next_start_char?: number;
  truncated_download: boolean;
  text: string;
  links?: PageLink[];
  links_hidden?: number;
}

const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD = 12 * 1024 * 1024;
/** Text kept from one page (about 100 calls of 20k characters): screening cost stays bounded. */
export const MAX_TEXT_CHARS = 2_000_000;
const READABLE = /^(text\/(html|plain|xml|markdown|csv)|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml|pdf))\b/i;

/**
 * Accepts "example.com/x", adds a scheme (http for onions, which rarely use TLS) and rewrites
 * Wayback Machine links to their raw "id_" form so the archive toolbar is not part of the text.
 */
export function normalizeUserUrl(raw: string): URL {
  const trimmed = raw.trim();
  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const host = trimmed.split(/[/?#]/)[0] ?? "";
    candidate = `${isOnionHost(host) ? "http" : "https"}://${trimmed}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new HttpError(`Not a valid URL: "${raw.slice(0, 200)}".`, "blocked");
  }
  if (url.hostname === "web.archive.org") {
    const m = url.pathname.match(/^\/web\/(\d{4,14})([a-z]{2}_)?\/(.+)$/);
    if (m && m[2] !== "id_") url.pathname = `/web/${m[1]}id_/${m[3]}`;
  }
  return url;
}

/**
 * Safety channel used to screen a page: dark web for onions (including tor2web gateways and archived
 * onion copies), academic for scholarly hosts, web otherwise.
 */
export function pageChannel(url: URL): Channel {
  if (isOnionHost(url.hostname) || embeddedOnions(url.toString()).length > 0) return "darkweb";
  return isScholarlyHost(url.hostname) ? "academic" : "web";
}

/** Onion services a URL leads to: its own host, or one embedded through a gateway or an archive. */
function onionTargets(url: URL): string[] {
  const targets = new Set(embeddedOnions(url.toString()));
  if (isOnionHost(url.hostname)) targets.add(url.hostname.toLowerCase().replace(/\.$/, ""));
  return [...targets];
}

async function assertAllowed(url: URL, deps: SearchDeps, signal?: AbortSignal): Promise<void> {
  const channel = pageChannel(url);
  if (isOnionHost(url.hostname) && !deps.http.torEnabled) {
    throw new HttpError(
      ".onion pages can only be opened through Tor. Start Tor (Tor Browser uses port 9150; the tor service uses 9050) and set DEEP_SEARCH_TOR_PROXY=socks5h://127.0.0.1:9150 in the MCP server's environment.",
      "tor"
    );
  }
  const onions = onionTargets(url);
  if (onions.length > 0) {
    // Fail closed: never open an onion service (directly, via a gateway or an archive) without the abuse blacklist.
    const ready = await deps.banned.ensure(signal);
    if (!ready) {
      throw new SafetyRefusal(
        "The Ahmia abuse blacklist could not be loaded, so onion content is not opened (fail-closed). Check the connection and try again."
      );
    }
    if (onions.some(host => deps.banned.isBanned(host))) {
      throw new SafetyRefusal("This onion service is on Ahmia's abuse blacklist. It is not opened, directly or through gateways and archives.");
    }
  }
  const category = deps.guard.classify(url.toString(), channel);
  if (category) {
    throw new SafetyRefusal(`This URL was blocked by the safety filter (${SafetyGuard.label(category)}).`);
  }
}

function sniffKind(contentType: string, body: Uint8Array): "pdf" | "html" | "text" {
  const ct = contentType.toLowerCase();
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("html") || ct.includes("xhtml")) return "html";
  if (body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46) return "pdf"; // %PDF
  if (!ct) {
    const head = new TextDecoder().decode(body.subarray(0, 512)).trimStart().toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<body")) return "html";
  }
  return "text";
}

export async function fetchPageContent(input: PageInput, deps: SearchDeps, signal?: AbortSignal): Promise<PageOutcome> {
  let url = normalizeUserUrl(input.url);
  const requested = url.toString();
  let response: HttpResponse | undefined;
  // After an onion hop, later hops stay on Tor so a redirect to the clear web cannot reveal the user's IP
  let viaTorSoFar = false;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertAllowed(url, deps, signal);
    response = await deps.http.request(url, {
      redirect: "manual",
      tor: viaTorSoFar || undefined,
      sensitive: true, // reading a page reveals what is being investigated
      signal,
      maxBytes: MAX_DOWNLOAD,
      truncate: true,
      acceptContentType: ct => !ct || READABLE.test(ct.trim()),
      headers: { accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5" }
    });
    viaTorSoFar ||= response.viaTor;
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === MAX_REDIRECTS) throw new HttpError(`Too many redirects (more than ${MAX_REDIRECTS}).`, "http", response.status);
      url = new URL(location, url);
      continue;
    }
    break;
  }
  if (!response) throw new HttpError("No response received.", "network");
  if (!response.ok) {
    const hint = response.status === 403 || response.status === 503 ? " The site may block automated readers; try deepsearch_archived_versions for a Wayback copy." : "";
    throw new HttpError(statusMessage(url.hostname, response.status) + hint, "http", response.status);
  }

  const channel = pageChannel(url);
  const kind = sniffKind(response.contentType, response.body);
  let text: string;
  let title: string | undefined;
  let description: string | undefined;
  let language: string | undefined;
  let pdfPages: number | undefined;
  let pdfPagesRead: number | undefined;
  let textTruncated = false;
  let rawLinks: Array<{ text: string; url: string }> = [];

  if (kind === "pdf") {
    if (response.truncated) throw new HttpError(`The PDF is larger than ${MAX_DOWNLOAD / 1024 / 1024} MB and was not read.`, "too_large");
    try {
      const pdf = await extractPdf(response.body);
      text = pdf.text;
      title = pdf.title;
      pdfPages = pdf.pages;
      pdfPagesRead = pdf.pagesRead;
      textTruncated = pdf.truncated;
    } catch (error) {
      throw new HttpError(`Could not read this PDF (${(error as Error).message}).`, "http");
    }
    if (!text.trim()) text = "(This PDF has no text layer: it is probably a scanned image without OCR.)";
  } else if (kind === "html") {
    const page = extractHtml(response.text(), url.toString());
    text = page.text;
    title = page.title;
    description = page.description;
    language = page.language;
    rawLinks = page.links;
  } else {
    if (looksBinary(response.body)) {
      throw new HttpError("This URL returned binary data; only text, HTML and PDF are read (no images, video or downloads).", "content_type");
    }
    text = response.text();
  }
  // Bounded work for screening and pagination, whatever the page size
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    textTruncated = true;
  }

  const verdict = deps.guard.checkDocument([title, description, text].filter(Boolean).join("\n"), channel);
  if (verdict.category) {
    throw new SafetyRefusal(
      `Page withheld by the safety filter (${SafetyGuard.label(verdict.category)}). Its content is not shown.`
    );
  }

  let links: PageLink[] | undefined;
  let linksHidden = 0;
  if (input.include_links && rawLinks.length) {
    const leadsToOnion = (link: { url: string }) => isOnionHost(safeHostname(link.url)) || embeddedOnions(link.url).length > 0;
    if (rawLinks.some(leadsToOnion)) await deps.banned.ensure(signal);
    links = [];
    for (const link of rawLinks) {
      const host = safeHostname(link.url);
      const onion = isOnionHost(host);
      const dark = leadsToOnion(link);
      // Onion links (direct, gateway or archived) are listed only when the blacklist is loaded and clears them
      if (dark && (!deps.banned.loaded || deps.banned.isBanned(host) || deps.banned.anyBanned(link.url))) {
        linksHidden++;
        continue;
      }
      // Each link is judged by where it points, not by the page it was found on
      if (deps.guard.classify(`${link.text} ${link.url}`, dark ? "darkweb" : isScholarlyHost(host) ? "academic" : "web")) {
        linksHidden++;
        continue;
      }
      links.push(onion ? { ...link, onion: true } : link);
    }
  }

  const total = text.length;
  const start = Math.min(input.start_char, total);
  const end = Math.min(start + input.max_chars, total);
  const hasMore = end < total;
  return {
    requested_url: requested,
    final_url: url.toString(),
    via_tor: response.viaTor,
    status: response.status,
    content_type: response.contentType || kind,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(language ? { language } : {}),
    ...(pdfPages !== undefined ? { pdf_pages: pdfPages } : {}),
    ...(textTruncated && pdfPagesRead !== undefined ? { pdf_pages_read: pdfPagesRead } : {}),
    ...(textTruncated ? { text_truncated: true } : {}),
    total_chars: total,
    start_char: start,
    end_char: end,
    has_more: hasMore,
    ...(hasMore ? { next_start_char: end } : {}),
    truncated_download: response.truncated,
    text: text.slice(start, end),
    ...(links ? { links } : {}),
    ...(linksHidden ? { links_hidden: linksHidden } : {})
  };
}

/** NUL bytes near the start mean binary data (an image or archive served without a content type). */
export function looksBinary(body: Uint8Array): boolean {
  const head = body.subarray(0, 4096);
  for (const byte of head) if (byte === 0) return true;
  return false;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
