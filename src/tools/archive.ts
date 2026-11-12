import { isOnionHost } from "../http/client.js";
import { embeddedOnions } from "../safety/banned.js";
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

function hostOfTarget(target: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`).hostname.toLowerCase();
  } catch {
    return (target.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0] ?? "").replace(/^.*@/, "").replace(/:\d+$/, "").toLowerCase();
  }
}

export async function archivedVersions(input: ArchiveInput, deps: SearchDeps, signal?: AbortSignal): Promise<ArchiveOutcome> {
  const target = input.url.trim();
  const host = hostOfTarget(target);
  // Onion services reached directly, through tor2web gateways or by archive URL all face the blacklist (fail-closed)
  const onions = new Set(embeddedOnions(target));
  if (isOnionHost(host)) onions.add(host);
  if (onions.size > 0) {
    const ready = await deps.banned.ensure(signal);
    if (!ready) {
      throw new SafetyRefusal("The Ahmia abuse blacklist could not be loaded, so archives of onion services are not listed (fail-closed). Try again later.");
    }
    if ([...onions].some(h => deps.banned.isBanned(h))) throw new SafetyRefusal("This onion service is on Ahmia's abuse blacklist.");
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

  // Captures can lead to onion services even when the query did not (e.g. match=domain on a gateway):
  // load the blacklist for them, and hide them if it cannot be loaded (fail-closed)
  const leadsToOnion = (s: Snapshot) => onions.size > 0 || isOnionHost(hostOfTarget(s.original_url)) || embeddedOnions(s.original_url).length > 0;
  const listReady = snapshots.some(leadsToOnion) ? await deps.banned.ensure(signal) : deps.banned.loaded;
  let hidden = 0;
  snapshots = snapshots.filter(s => {
    const dark = leadsToOnion(s);
    const blocked =
      (dark && (!listReady || deps.banned.isBanned(hostOfTarget(s.original_url)) || deps.banned.anyBanned(s.original_url))) ||
      deps.guard.classify(s.original_url, dark ? "darkweb" : "web");
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
