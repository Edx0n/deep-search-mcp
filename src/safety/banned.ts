import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HttpClient } from "../http/client.js";

/**
 * Ahmia publishes the MD5 hashes of every onion domain it has banned for abuse content
 * (https://ahmia.fi/blacklist/banned/, computed as md5("<56 chars>.onion")). We use that list
 * as an extra layer: banned onions are dropped from results and never fetched.
 */
export const AHMIA_BANNED_URLS = {
  clearnet: "https://ahmia.fi/blacklist/banned/",
  onion: "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/blacklist/banned/"
};

const MEMORY_MAX_AGE_MS = 12 * 60 * 60_000;
const DISK_MAX_AGE_MS = 24 * 60 * 60_000;

export function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

export function parseBannedList(text: string): Set<string> {
  const hashes = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const h = line.trim().toLowerCase();
    if (/^[0-9a-f]{32}$/.test(h)) hashes.add(h);
  }
  return hashes;
}

/** Candidate spellings of an onion host whose hash may appear in the list. */
export function onionHashCandidates(host: string): string[] {
  const h = host.toLowerCase().replace(/\.$/, "");
  const labels = h.split(".");
  const base = labels.length >= 2 ? labels.slice(-2).join(".") : h; // drops subdomains: a.b.onion → b.onion
  const set = new Set([h, base, h.replace(/\.onion$/, ""), base.replace(/\.onion$/, "")]);
  return [...set].map(md5);
}

export interface BannedListStatus {
  loaded: boolean;
  size: number;
  loaded_at?: string;
  source?: string;
  error?: string;
}

export class BannedOnionList {
  private hashes: Set<string> | null = null;
  private loadedAt = 0;
  private source?: string;
  private pending: Promise<void> | null = null;
  private lastError?: string;

  constructor(
    private readonly http: HttpClient,
    private readonly cacheFile: string | null = path.join(os.tmpdir(), "deep-search-mcp", "ahmia-banned.txt")
  ) {}

  /** For tests: preload a known list. */
  static fromHashes(http: HttpClient, hashes: Iterable<string>): BannedOnionList {
    const list = new BannedOnionList(http, null);
    list.hashes = new Set([...hashes].map(h => h.toLowerCase()));
    list.loadedAt = Date.now();
    list.source = "preloaded";
    return list;
  }

  get loaded(): boolean {
    return this.hashes !== null;
  }

  status(): BannedListStatus {
    return {
      loaded: this.hashes !== null,
      size: this.hashes?.size ?? 0,
      loaded_at: this.loadedAt ? new Date(this.loadedAt).toISOString() : undefined,
      source: this.source,
      error: this.lastError
    };
  }

  /** Loads (or refreshes) the list; resolves to whether a list is available. Never throws. */
  async ensure(signal?: AbortSignal): Promise<boolean> {
    if (this.hashes && Date.now() - this.loadedAt < MEMORY_MAX_AGE_MS) return true;
    this.pending ??= this.load(signal).finally(() => {
      this.pending = null;
    });
    try {
      await this.pending;
    } catch (error) {
      this.lastError = (error as Error).message;
    }
    return this.hashes !== null;
  }

  isBanned(host: string): boolean {
    if (!this.hashes) return false;
    return onionHashCandidates(host).some(h => this.hashes!.has(h));
  }

  private async load(signal?: AbortSignal): Promise<void> {
    const fromDisk = await this.readDiskCache();
    if (fromDisk) {
      this.setHashes(fromDisk, "disk cache");
      return;
    }
    const attempts: Array<{ url: string; tor: boolean }> = [{ url: AHMIA_BANNED_URLS.clearnet, tor: false }];
    if (this.http.torEnabled) attempts.push({ url: AHMIA_BANNED_URLS.onion, tor: true });
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const text = await this.http.getText(attempt.url, {
          tor: attempt.tor,
          signal,
          maxBytes: 32 * 1024 * 1024,
          label: "Ahmia blacklist"
        });
        const hashes = parseBannedList(text);
        if (hashes.size < 100) throw new Error("Ahmia blacklist looks empty or malformed");
        this.setHashes(hashes, attempt.tor ? "ahmia onion" : "ahmia.fi");
        await this.writeDiskCache(text);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Could not download the Ahmia blacklist");
  }

  private setHashes(hashes: Set<string>, source: string): void {
    this.hashes = hashes;
    this.loadedAt = Date.now();
    this.source = source;
    this.lastError = undefined;
  }

  private async readDiskCache(): Promise<Set<string> | null> {
    if (!this.cacheFile) return null;
    try {
      const info = await stat(this.cacheFile);
      if (Date.now() - info.mtimeMs > DISK_MAX_AGE_MS) return null;
      const hashes = parseBannedList(await readFile(this.cacheFile, "utf8"));
      return hashes.size >= 100 ? hashes : null;
    } catch {
      return null;
    }
  }

  private async writeDiskCache(text: string): Promise<void> {
    if (!this.cacheFile) return;
    try {
      await mkdir(path.dirname(this.cacheFile), { recursive: true });
      await writeFile(this.cacheFile, text, "utf8");
    } catch {
      // Cache is an optimization only
    }
  }
}
