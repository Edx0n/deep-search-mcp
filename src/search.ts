import type { TtlCache } from "./cache.js";
import type { Config } from "./config.js";
import { HttpError, type HttpClient } from "./http/client.js";
import type { BannedOnionList } from "./safety/banned.js";
import { SafetyGuard } from "./safety/guard.js";
import type { CategoryId } from "./safety/rules.js";
import { inYearRange } from "./sources/common.js";
import { SOURCES } from "./sources/registry.js";
import type { Channel, Scope, SearchResult, Source, SourceId, SourcePage } from "./types.js";
import { dedupeKey, hostOf } from "./util/text.js";

export const DEFAULT_SCOPES: readonly Scope[] = ["academic", "data", "archive", "web", "darkweb"];

export interface SearchInput {
  query: string;
  scopes?: Scope[];
  sources?: SourceId[];
  limit_per_source: number;
  offset: number;
  year_from?: number;
  year_to?: number;
  exclude_domains?: string[];
}

export type SourceStatus = "ok" | "error" | "skipped" | "refused";

export interface SourceReport {
  id: SourceId;
  name: string;
  scope: Scope;
  status: SourceStatus;
  count: number;
  total?: number;
  has_more: boolean;
  hidden: number;
  duplicates: number;
  error?: string;
  note?: string;
  ms?: number;
}

export type HiddenReason = CategoryId | "ahmia_blacklist";

export interface SearchOutcome {
  query: string;
  scopes: Scope[];
  offset: number;
  limit_per_source: number;
  year_from?: number;
  year_to?: number;
  sources: SourceReport[];
  results: SearchResult[];
  safety: {
    hidden: number;
    by_reason: Partial<Record<HiddenReason, number>>;
    refused: Array<{ channel: Channel; category: CategoryId; label: string }>;
    banned_list_loaded: boolean;
  };
  has_more: boolean;
  next_offset?: number;
}

export interface SearchDeps {
  http: HttpClient;
  config: Config;
  cache: TtlCache<unknown>;
  guard: SafetyGuard;
  banned: BannedOnionList;
}

/** Thrown when the safety policy refuses every requested source. */
export class SafetyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyRefusal";
  }
}

function resultText(result: SearchResult, channel: Channel): string {
  // Academic metadata is judged on title + abstract; open-web results also on the URL.
  const parts = [result.title, result.snippet ?? ""];
  if (channel !== "academic") parts.push(result.url);
  return parts.join(" \n ");
}

function excluded(url: string, domains: string[]): boolean {
  if (domains.length === 0) return false;
  const host = hostOf(url);
  return domains.some(d => host === d || host.endsWith(`.${d}`));
}

export function selectSources(input: Pick<SearchInput, "scopes" | "sources">, config: Config, registry: readonly Source[] = SOURCES): Source[] {
  if (input.sources?.length) {
    const wanted = new Set(input.sources);
    return registry.filter(s => wanted.has(s.id));
  }
  const scopes = new Set(input.scopes?.length ? input.scopes : DEFAULT_SCOPES);
  return registry.filter(s => scopes.has(s.scope) && s.isDefault(config));
}

export async function runSearch(
  input: SearchInput,
  deps: SearchDeps,
  signal?: AbortSignal,
  registry: readonly Source[] = SOURCES
): Promise<SearchOutcome> {
  const query = input.query.trim();
  const limit = input.limit_per_source;
  const offset = input.offset;
  const excludeDomains = (input.exclude_domains ?? []).map(d => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean);
  const selected = selectSources(input, deps.config, registry);
  const scopes = [...new Set(selected.map(s => s.scope))];

  const refusedChannels = deps.guard.checkQuery(query);
  const refused = [...refusedChannels.entries()]
    .filter(([channel]) => selected.some(s => s.channel === channel))
    .map(([channel, category]) => ({ channel, category, label: SafetyGuard.label(category) }));

  const runnable = selected.filter(s => !refusedChannels.has(s.channel));
  if (selected.length > 0 && runnable.length === 0) {
    const labels = [...new Set(refused.map(r => r.label))].join(", ");
    throw new SafetyRefusal(
      `Search refused by the safety policy (${labels}). This server does not look for that kind of content on the web or the dark web.` +
        (refusedChannels.has("academic") ? "" : " Scholarly research on the subject is still possible with scopes=['academic']."),
    );
  }

  const needsBanned = runnable.some(s => s.channel === "darkweb");
  const bannedReady = needsBanned ? deps.banned.ensure(signal) : Promise.resolve(deps.banned.loaded);

  const byReason: Partial<Record<HiddenReason, number>> = {};
  const reports = new Map<SourceId, SourceReport>();
  const pages = new Map<SourceId, SearchResult[]>();

  for (const source of selected) {
    const base = { id: source.id, name: source.name, scope: source.scope, count: 0, has_more: false, hidden: 0, duplicates: 0 };
    const refusal = refusedChannels.get(source.channel);
    if (refusal) {
      reports.set(source.id, { ...base, status: "refused", note: `Query refused on this channel (${SafetyGuard.label(refusal)}).` });
      continue;
    }
    const availability = source.availability(deps.config);
    if (!availability.ok) reports.set(source.id, { ...base, status: "skipped", note: availability.reason });
  }

  await Promise.all(
    runnable
      .filter(s => !reports.has(s.id))
      .map(async source => {
        const started = Date.now();
        const base = { id: source.id, name: source.name, scope: source.scope, count: 0, has_more: false, hidden: 0, duplicates: 0 };
        try {
          const page = await fetchPage(source, { query, limit, offset, yearFrom: input.year_from, yearTo: input.year_to }, deps, signal);
          if (source.channel === "darkweb") await bannedReady;

          const kept: SearchResult[] = [];
          let hidden = 0;
          for (const result of page.results) {
            if (!result.url || !inYearRange(result.year, input.year_from, input.year_to) || excluded(result.url, excludeDomains)) continue;
            let reason: HiddenReason | null = null;
            if (result.onion && deps.banned.isBanned(hostOf(result.url))) reason = "ahmia_blacklist";
            else reason = deps.guard.classify(resultText(result, source.channel), source.channel);
            if (reason) {
              hidden++;
              byReason[reason] = (byReason[reason] ?? 0) + 1;
              continue;
            }
            kept.push(result);
          }

          let shown: SearchResult[];
          let total: number | undefined;
          let hasMore: boolean;
          if (page.complete) {
            // The source returned everything: paginate after filtering so pages stay consistent.
            shown = kept.slice(offset, offset + limit);
            total = kept.length;
            hasMore = offset + limit < kept.length;
          } else {
            shown = kept.slice(0, limit);
            total = page.total;
            hasMore = total !== undefined ? offset + page.results.length < total : page.results.length >= limit;
          }
          pages.set(source.id, shown);
          const note = [page.note, source.channel === "darkweb" && !deps.banned.loaded ? "Ahmia blacklist unavailable: only keyword filtering applied." : undefined]
            .filter(Boolean)
            .join(" ");
          reports.set(source.id, { ...base, status: "ok", count: shown.length, total, has_more: hasMore, hidden, note: note || undefined, ms: Date.now() - started });
        } catch (error) {
          if (signal?.aborted) throw error;
          const message = error instanceof HttpError || error instanceof Error ? error.message : String(error);
          reports.set(source.id, { ...base, status: "error", error: message, ms: Date.now() - started });
        }
      })
  );

  // Cross-source de-duplication (same DOI or URL): keep the first occurrence, note where else it appeared.
  const seen = new Map<string, SearchResult>();
  const results: SearchResult[] = [];
  for (const source of selected) {
    const list = pages.get(source.id) ?? [];
    const unique: SearchResult[] = [];
    for (const result of list) {
      const key = dedupeKey(result.url, result.doi);
      const first = seen.get(key);
      if (first) {
        first.also_in = [...new Set([...(first.also_in ?? []), result.source])];
        const report = reports.get(source.id);
        if (report) {
          report.duplicates++;
          report.count--;
        }
        continue;
      }
      seen.set(key, result);
      unique.push(result);
    }
    results.push(...unique);
  }

  const sourceReports = selected.map(s => reports.get(s.id)!).filter(Boolean);
  const hasMore = sourceReports.some(r => r.status === "ok" && r.has_more);
  const hiddenTotal = Object.values(byReason).reduce((a, b) => a + (b ?? 0), 0);

  return {
    query,
    scopes,
    offset,
    limit_per_source: limit,
    ...(input.year_from !== undefined ? { year_from: input.year_from } : {}),
    ...(input.year_to !== undefined ? { year_to: input.year_to } : {}),
    sources: sourceReports,
    results,
    safety: { hidden: hiddenTotal, by_reason: byReason, refused, banned_list_loaded: deps.banned.loaded },
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + limit } : {})
  };
}

async function fetchPage(
  source: Source,
  q: { query: string; limit: number; offset: number; yearFrom?: number; yearTo?: number },
  deps: SearchDeps,
  signal?: AbortSignal
): Promise<SourcePage> {
  const key = JSON.stringify([source.id, q.query.toLowerCase(), q.limit, q.offset, q.yearFrom, q.yearTo]);
  const completeKey = JSON.stringify([source.id, "complete", q.query.toLowerCase(), q.yearFrom, q.yearTo]);
  const cached = (deps.cache.get(completeKey) ?? deps.cache.get(key)) as SourcePage | undefined;
  if (cached) return cached;
  const page = await source.search({ ...q, signal }, { http: deps.http, config: deps.config, cache: deps.cache, banned: deps.banned });
  deps.cache.set(page.complete ? completeKey : key, page);
  return page;
}
