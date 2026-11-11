import { isOnionHost } from "../http/client.js";
import { SafetyRefusal, type SearchDeps } from "../search.js";

export type MatchType = "exact" | "prefix" | "host" | "domain";

export interface ArchiveInput {
  url: string;
  from?: string;
  to?: string;
  match: MatchType;
  limit: number;
  newest_first: boolean;
  only_successful: boolean;
}

export interface Snapshot {
  timestamp: string;
  date: string;
  original_url: string;
  mimetype?: string;
  status?: string;
  length?: number;
  archive_url: string;
  raw_url: string;
}

export interface ArchiveOutcome {
  url: string;
  match: MatchType;
  count: number;
  snapshots: Snapshot[];
  hidden: number;
  note?: string;
}

export function formatTimestamp(ts: string): string {
  const m = ts.match(/^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return ts;
  const [, y, mo = "01", d = "01", h, mi] = m;
  return h ? `${y}-${mo}-${d} ${h}:${mi ?? "00"} UTC` : `${y}-${mo}-${d}`;
}

/** Parses CDX JSON output (first row = field names). */
export function parseCdx(rows: unknown): Snapshot[] {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const header = rows[0] as string[];
  const index = (name: string) => header.indexOf(name);
  const [iTs, iOrig, iMime, iStatus, iLen] = ["timestamp", "original", "mimetype", "statuscode", "length"].map(index);
  return (rows.slice(1) as string[][])
    .filter(r => Array.isArray(r) && iTs !== undefined && iOrig !== undefined && r[iTs] && r[iOrig])
    .map(r => {
      const ts = r[iTs!]!;
      const original = r[iOrig!]!;
      const length = iLen !== undefined && iLen >= 0 ? Number(r[iLen]) : NaN;
      return {
        timestamp: ts,
        date: formatTimestamp(ts),
        original_url: original,
        ...(iMime !== undefined && iMime >= 0 && r[iMime] ? { mimetype: r[iMime] } : {}),
        ...(iStatus !== undefined && iStatus >= 0 && r[iStatus] ? { status: r[iStatus] } : {}),
        ...(Number.isFinite(length) ? { length } : {}),
        archive_url: `https://web.archive.org/web/${ts}/${original}`,
        raw_url: `https://web.archive.org/web/${ts}id_/${original}`
      };
    });
}

export async function archivedVersions(input: ArchiveInput, deps: SearchDeps, signal?: AbortSignal): Promise<ArchiveOutcome> {
  const target = input.url.trim();
  const host = (target.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0] ?? "").toLowerCase();
  if (isOnionHost(host)) {
    await deps.banned.ensure(signal);
    if (deps.banned.isBanned(host)) throw new SafetyRefusal("This onion service is on Ahmia's abuse blacklist.");
  }

  const params = new URLSearchParams({
    url: target,
    output: "json",
    fl: "timestamp,original,mimetype,statuscode,length",
    matchType: input.match,
    limit: String(input.newest_first ? -input.limit : input.limit),
    collapse: input.match === "exact" ? "digest" : "urlkey"
  });
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  if (input.only_successful) params.set("filter", "statuscode:200");

  const rows = await deps.http.getJson<unknown>(`https://web.archive.org/cdx/search/cdx?${params}`, {
    signal,
    label: "Wayback Machine",
    timeoutMs: Math.max(deps.config.timeoutMs, 45_000)
  });
  let snapshots = parseCdx(rows);
  if (input.newest_first) snapshots = snapshots.reverse();

  let hidden = 0;
  snapshots = snapshots.filter(s => {
    const blocked = deps.guard.classify(s.original_url, isOnionHost(host) ? "darkweb" : "web");
    if (blocked) hidden++;
    return !blocked;
  });

  return {
    url: target,
    match: input.match,
    count: snapshots.length,
    snapshots,
    hidden,
    ...(snapshots.length === 0
      ? {
          note:
            "No archived copies matched. Try match='prefix' or 'domain', widen from/to, or set only_successful=false. A new capture can be requested manually at https://web.archive.org/save."
        }
      : {})
  };
}
