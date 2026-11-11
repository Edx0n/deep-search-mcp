import type { SearchResult } from "../types.js";

/**
 * Maps offset/limit onto a page-based API. Aligned offsets map to a page directly; otherwise we
 * fetch the first `offset + limit` items and skip, or fall back to the nearest aligned page.
 */
export function pageWindow(offset: number, limit: number, maxPerPage = 100): { page: number; perPage: number; skip: number } {
  if (offset % limit === 0) return { page: offset / limit + 1, perPage: limit, skip: 0 };
  if (offset + limit <= maxPerPage) return { page: 1, perPage: offset + limit, skip: offset };
  return { page: Math.floor(offset / limit) + 1, perPage: limit, skip: 0 };
}

export function inYearRange(year: number | undefined, from?: number, to?: number): boolean {
  if (year === undefined) return true;
  if (from !== undefined && year < from) return false;
  if (to !== undefined && year > to) return false;
  return true;
}

/** Drops empty optional fields so JSON output stays compact. */
export function compact(result: SearchResult): SearchResult {
  const out = { ...result } as Record<string, unknown>;
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) delete out[key];
  }
  return out as unknown as SearchResult;
}

/** Same person written two ways ("Naval, Liliana Pena" / "Liliana Pena Naval") → same key. */
function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

export function authorsList(names: Array<string | undefined | null>, max = 8): string[] | undefined {
  const seen = new Set<string>();
  const list = names
    .map(n => (typeof n === "string" ? n.replace(/\s+/g, " ").trim() : ""))
    .filter(n => {
      const key = nameKey(n);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (list.length === 0) return undefined;
  return list.length > max ? [...list.slice(0, max), `+${list.length - max} more`] : list;
}

export const SNIPPET_CHARS = 600;

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Runs tasks one at a time, leaving `gapMs` between the end of one task and the start of the next
 * (for APIs such as Crossref's public pool: 1 concurrent request, 1 request per second).
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private lastEnd = 0;

  constructor(private readonly gapMs = 0) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const start = async () => {
      const wait = this.lastEnd + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        this.lastEnd = Date.now();
      }
    };
    const result = this.tail.then(start, start);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
