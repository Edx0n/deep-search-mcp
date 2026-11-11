import type { BannedListStatus } from "./safety/banned.js";
import { SafetyGuard, type PolicyEntry } from "./safety/guard.js";
import type { SearchOutcome, SourceReport } from "./search.js";
import { SCOPE_LABELS } from "./sources/registry.js";
import type { ArchiveOutcome } from "./tools/archive.js";
import type { PageOutcome } from "./tools/page.js";
import type { Scope, SearchResult } from "./types.js";
import { clip, formatNumber } from "./util/text.js";

export const CHARACTER_LIMIT = 25_000;
export type ResponseFormat = "markdown" | "json";

export interface Rendered {
  text: string;
  structured?: Record<string, unknown>;
}

/** Compact JSON: indentation would spend a third of the size budget on whitespace. */
function json(value: Record<string, unknown>): Rendered {
  return { text: JSON.stringify(value), structured: value };
}

/** Keeps titles from breaking Markdown emphasis. */
function md(text: string): string {
  return text.replace(/\*\*/g, "*").replace(/\s+/g, " ").trim();
}

function resultBlock(r: SearchResult, n: number): string {
  const lines = [`${n}. **${md(r.title)}**${r.year ? ` (${r.year})` : ""}`];
  const authors = r.authors?.length ? r.authors.slice(0, 4).join(", ") + (r.authors.length > 4 ? " et al." : "") : undefined;
  const meta = [
    authors,
    r.venue && r.venue !== r.title ? r.venue : undefined,
    r.type,
    r.citations ? `cited ${formatNumber(r.citations)}×` : undefined,
    r.open_access ? "open access" : undefined,
    r.language,
    r.last_seen ? `last seen ${r.last_seen}` : undefined
  ].filter(Boolean);
  if (meta.length) lines.push(`   ${meta.join(" · ")}`);
  lines.push(`   ${r.url}`);
  if (r.pdf_url && r.pdf_url !== r.url) lines.push(`   PDF: ${r.pdf_url}`);
  if (r.doi && !r.url.toLowerCase().includes(r.doi.toLowerCase())) lines.push(`   DOI: ${r.doi}`);
  if (r.also_in?.length) lines.push(`   Also in: ${r.also_in.join(", ")}`);
  if (r.snippet) lines.push(`   > ${r.snippet}`);
  return lines.join("\n");
}

function reportHeading(report: SourceReport): string {
  if (report.status === "error") return `### ${report.name} — error: ${report.error}`;
  if (report.status === "skipped") return `### ${report.name} — skipped${report.note ? `: ${report.note}` : ""}`;
  if (report.status === "refused") return `### ${report.name} — ${report.note ?? "refused by the safety policy"}`;
  const parts = [report.count === 0 ? "no results" : report.total !== undefined ? `${report.count} of ${formatNumber(report.total)}` : `${report.count}`];
  if (report.hidden) parts.push(`${report.hidden} hidden by safety filter`);
  if (report.duplicates) parts.push(`${report.duplicates} duplicate${report.duplicates > 1 ? "s" : ""} merged`);
  return `### ${report.name} — ${parts.join(" · ")}`;
}

/** Applies a per-source cap (used to fit the response size limit) and recomputes pagination. */
function capOutcome(outcome: SearchOutcome, cap: number): SearchOutcome {
  if (cap >= outcome.limit_per_source) return outcome;
  const perSource = new Map<string, number>();
  const results = outcome.results.filter(r => {
    const n = perSource.get(r.source) ?? 0;
    if (n >= cap) return false;
    perSource.set(r.source, n + 1);
    return true;
  });
  const sources = outcome.sources.map(s => (s.status === "ok" ? { ...s, count: Math.min(s.count, cap), has_more: s.has_more || s.count > cap } : s));
  const hasMore = sources.some(s => s.status === "ok" && s.has_more);
  const { next_offset: _ignored, ...rest } = outcome;
  return { ...rest, results, sources, has_more: hasMore, ...(hasMore ? { next_offset: outcome.offset + cap } : {}) };
}

/** How a search response was shrunk to fit CHARACTER_LIMIT. */
interface Fit {
  snippetMax?: number;
  trimmedTo?: number;
}

function searchMarkdown(o: SearchOutcome, fit: Fit = {}): string {
  const { snippetMax, trimmedTo } = fit;
  const lines: string[] = [`# Deep Search: "${o.query}"`];
  const scopeInfo = [`Scopes: ${o.scopes.join(", ") || "none"}`, `up to ${trimmedTo ?? o.limit_per_source} per source`];
  if (o.offset) scopeInfo.push(`offset ${o.offset}`);
  if (o.year_from !== undefined || o.year_to !== undefined) scopeInfo.push(`years ${o.year_from ?? "…"}–${o.year_to ?? "…"}`);
  lines.push(scopeInfo.join(" · "));

  if (o.safety.refused.length) {
    const refused = o.safety.refused.map(r => `${r.channel} (${r.label})`).join(", ");
    lines.push(`**Safety policy:** this query is not searched on: ${refused}.`);
  }
  if (o.safety.hidden) {
    const reasons = Object.entries(o.safety.by_reason)
      .map(([k, v]) => `${k === "ahmia_blacklist" ? "Ahmia abuse blacklist" : SafetyGuard.label(k as never)}: ${v}`)
      .join(", ");
    lines.push(`**Safety filter:** ${o.safety.hidden} result${o.safety.hidden > 1 ? "s" : ""} hidden (${reasons}).`);
  }
  if (trimmedTo !== undefined) {
    lines.push(`_To fit the response size limit: ${trimmedTo} result(s) per source, snippets cut to ${snippetMax} characters._`);
  } else if (snippetMax !== undefined) {
    lines.push(`_Snippets cut to ${snippetMax} characters to fit the response size limit; deepsearch_fetch_page reads the full text._`);
  }

  const scopes = [...new Set(o.sources.map(s => s.scope))] as Scope[];
  for (const scope of scopes) {
    lines.push("", `## ${SCOPE_LABELS[scope]}`);
    for (const report of o.sources.filter(s => s.scope === scope)) {
      lines.push("", reportHeading(report));
      if (report.note && report.status === "ok") lines.push(`_${report.note}_`);
      const items = o.results.filter(r => r.source === report.id);
      items.forEach((r, i) => lines.push(resultBlock(r, o.offset + i + 1)));
    }
    if (scope === "darkweb" && o.results.some(r => r.onion)) {
      lines.push("", "> .onion links only open through Tor. deepsearch_fetch_page can read them when DEEP_SEARCH_TOR_PROXY is configured. Treat dark web content as unverified.");
    }
  }

  const failed = o.sources.filter(s => s.status === "error").length;
  lines.push("", "---");
  if (o.results.length === 0) lines.push("No results. Try broader or different keywords, another language, or other scopes.");
  if (failed) lines.push(`${failed} source(s) failed; the rest are shown.`);
  if (o.has_more && o.next_offset !== undefined) lines.push(`More results: call again with offset=${o.next_offset}.`);
  return lines.join("\n");
}

/** Snippet lengths tried, in order, before any result is dropped. */
export const SNIPPET_STEPS = [280, 140] as const;

function shortenSnippets(outcome: SearchOutcome, max: number): SearchOutcome {
  return { ...outcome, results: outcome.results.map(r => (r.snippet && r.snippet.length > max ? { ...r, snippet: clip(r.snippet, max) } : r)) };
}

/**
 * Renders a search and keeps it under CHARACTER_LIMIT: first shorter snippets (every result stays),
 * then fewer results per source, one at a time (next_offset stays consistent).
 */
export function renderSearch(outcome: SearchOutcome, format: ResponseFormat): Rendered {
  const render = (o: SearchOutcome, fit: Fit = {}): Rendered =>
    format === "json"
      ? json({
          ...o,
          ...(fit.snippetMax !== undefined ? { snippets_shortened_to: fit.snippetMax } : {}),
          ...(fit.trimmedTo !== undefined ? { trimmed_to: fit.trimmedTo } : {})
        } as unknown as Record<string, unknown>)
      : { text: searchMarkdown(o, fit) };

  let rendered = render(outcome);
  if (rendered.text.length <= CHARACTER_LIMIT) return rendered;

  let shortened = outcome;
  let snippetMax: number | undefined;
  for (const max of SNIPPET_STEPS) {
    snippetMax = max;
    shortened = shortenSnippets(outcome, max);
    rendered = render(shortened, { snippetMax });
    if (rendered.text.length <= CHARACTER_LIMIT) return rendered;
  }

  for (let cap = outcome.limit_per_source - 1; cap >= 1 && rendered.text.length > CHARACTER_LIMIT; cap--) {
    rendered = render(capOutcome(shortened, cap), { snippetMax, trimmedTo: cap });
  }
  return rendered;
}

export function renderPage(page: PageOutcome, format: ResponseFormat): Rendered {
  // Fit the links into what the text leaves of the size limit
  const budget = CHARACTER_LIMIT - page.text.length - 2_500;
  let links = page.links ?? [];
  const estimate = (list: typeof links) => list.reduce((n, l) => n + l.text.length + l.url.length + 12, 0);
  while (links.length > 0 && estimate(links) > budget) links = links.slice(0, Math.floor(links.length * 0.7));
  const omitted = (page.links?.length ?? 0) - links.length;

  if (format === "json") {
    return json({ ...page, ...(page.links ? { links } : {}), ...(omitted > 0 ? { links_omitted: omitted } : {}) } as unknown as Record<string, unknown>);
  }
  const lines: string[] = [`# ${md(page.title ?? page.final_url)}`];
  const info = [page.final_url];
  if (page.via_tor) info.push("via Tor");
  info.push(page.content_type.split(";")[0] ?? page.content_type);
  if (page.pdf_pages !== undefined) info.push(`${page.pdf_pages} PDF page(s)`);
  info.push(`chars ${formatNumber(page.start_char)}–${formatNumber(page.end_char)} of ${formatNumber(page.total_chars)}`);
  lines.push(info.join(" · "));
  if (page.final_url !== page.requested_url) lines.push(`(redirected from ${page.requested_url})`);
  if (page.description) lines.push(`Description: ${page.description}`);
  if (page.truncated_download) lines.push("_The download hit the 12 MB limit; the end of the page is missing._");
  lines.push("", "---", "", page.text || "(no readable text in this range)", "", "---");
  if (page.has_more && page.next_start_char !== undefined) lines.push(`More text: call again with start_char=${page.next_start_char}.`);
  if (page.links) {
    const hiddenNote = page.links_hidden ? `, ${page.links_hidden} hidden by the safety filter` : "";
    const omittedNote = omitted > 0 ? `, ${omitted} omitted for size` : "";
    lines.push("", `## Links (${links.length}${hiddenNote}${omittedNote})`);
    for (const link of links) lines.push(`- ${link.onion ? "[onion] " : ""}${md(link.text)} — ${link.url}`);
  }
  return { text: lines.join("\n") };
}

function formatBytes(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function renderArchive(outcome: ArchiveOutcome, format: ResponseFormat): Rendered {
  if (format === "json") return json(outcome as unknown as Record<string, unknown>);
  const lines = [`# Wayback Machine captures of ${outcome.url} (match: ${outcome.match})`, `${outcome.count} capture(s)${outcome.hidden ? `, ${outcome.hidden} hidden by the safety filter` : ""}.`, ""];
  for (const s of outcome.snapshots) {
    const meta = [s.mimetype, s.status ? `HTTP ${s.status}` : undefined, formatBytes(s.length) || undefined].filter(Boolean).join(", ");
    lines.push(`- **${s.date}** — ${s.original_url}${meta ? ` (${meta})` : ""}`, `  view: ${s.archive_url}`, `  raw (for deepsearch_fetch_page): ${s.raw_url}`);
  }
  if (outcome.note) lines.push("", outcome.note);
  let text = lines.join("\n");
  if (text.length > CHARACTER_LIMIT) text = `${text.slice(0, CHARACTER_LIMIT - 120)}\n…\n(Output truncated: lower 'limit' or narrow from/to.)`;
  return { text };
}

export interface SourceListing {
  id: string;
  name: string;
  scope: Scope;
  default: boolean;
  available: boolean;
  status: string;
  homepage: string;
  description: string;
}

export interface ServerStatus {
  version: string;
  sources: SourceListing[];
  tor: { configured: boolean; proxy?: string; ahmia_mode: string };
  safety: { policy: PolicyEntry[]; ignored_config: string[]; ahmia_blacklist: BannedListStatus };
}

export function renderSources(status: ServerStatus, format: ResponseFormat): Rendered {
  if (format === "json") return json(status as unknown as Record<string, unknown>);
  const lines = [`# Deep Search ${status.version}: sources and policy`, ""];
  for (const scope of Object.keys(SCOPE_LABELS) as Scope[]) {
    const list = status.sources.filter(s => s.scope === scope);
    if (!list.length) continue;
    lines.push(`## ${SCOPE_LABELS[scope]} (scope "${scope}")`);
    for (const s of list) {
      lines.push(`- **${s.id}** — ${s.name} [${s.status}] ${s.description}`);
    }
    lines.push("");
  }
  lines.push(
    "## Tor",
    status.tor.configured
      ? `Configured (${status.tor.proxy}). .onion pages can be read; Ahmia mode: ${status.tor.ahmia_mode}.`
      : `Not configured: dark web *search* works through ahmia.fi, but reading .onion pages needs DEEP_SEARCH_TOR_PROXY (Tor Browser: socks5h://127.0.0.1:9150; tor service: socks5h://127.0.0.1:9050).`,
    "",
    "## Safety policy"
  );
  for (const p of status.safety.policy) {
    lines.push(`- ${p.enabled ? "ON " : "off"} ${p.locked ? "(locked) " : ""}**${p.id}** — ${p.label}: ${p.description}`);
  }
  if (status.safety.ignored_config.length) lines.push(`Ignored DEEP_SEARCH_DISABLED_FILTERS entries: ${status.safety.ignored_config.join(", ")}.`);
  const bl = status.safety.ahmia_blacklist;
  lines.push(
    `Ahmia abuse blacklist: ${bl.loaded ? `${formatNumber(bl.size)} banned onion domains loaded (${bl.source})` : "loads on first dark web use"}${bl.error ? ` — last error: ${bl.error}` : ""}.`
  );
  return { text: lines.join("\n") };
}
