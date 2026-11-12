import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
/** The real list has ~60k entries: anything far smaller is broken or tampered with. */
export const MIN_BANNED_HASHES = 10_000;

/**
 * Per-user cache location (never a shared temp directory, where another local user could plant a
 * near-empty list): $XDG_CACHE_HOME, %LOCALAPPDATA% on Windows, or ~/.cache.
 */
export function defaultCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CACHE_HOME?.trim() || (process.platform === "win32" ? env.LOCALAPPDATA?.trim() : undefined) || path.join(os.homedir(), ".cache");
  return path.join(base, "deep-search-mcp", "ahmia-banned.txt");
}

export interface BannedListRouting {
  /** Try Ahmia's onion mirror before the clear web (set when Tor is configured). */
  preferTor?: boolean;
  /** Never contact the clear web (DEEP_SEARCH_AHMIA_MODE=onion). */
  torOnly?: boolean;
}

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

/**
 * v3 onion addresses (56 base32 characters) found anywhere in a URL or text: the host itself,
 * tor2web gateways ("<addr>.onion.ly"), translation proxies ("<addr>-onion-ly.translate.goog")
 * and archived copies ("web.archive.org/web/2020/http://<addr>.onion/"). Every one of these
 * paths must face the blacklist, not only hosts that end in ".onion".
 */
const ONION_V3 = /(?<![a-z2-7])([a-z2-7]{56})[.-]onion(?![a-z0-9])/gi;
/**
 * A v3 address used as a host label without any "onion" in sight ("<addr>.tor2web.example"):
 * 56 base32 characters ending in "d" (the encoded version byte 3), followed by "." or "-".
 */
const V3_LABEL = /(?<![a-z2-7])([a-z2-7]{55}d)(?=[.-])/gi;

/** The text plus up to three rounds of percent-decoding ("%2Eonion", double-encoded "%252E"…). */
function decodedForms(text: string): string[] {
  const forms = [text];
  let current = text;
  for (let round = 0; round < 3 && /%[0-9a-f]{2}/i.test(current); round++) {
    try {
      current = decodeURIComponent(current.replace(/%(?![0-9a-f]{2})/gi, "%25"));
    } catch {
      break;
    }
    forms.push(current);
  }
  return forms;
}

export function embeddedOnions(text: string): string[] {
  const found = new Set<string>();
  for (const form of decodedForms(text.slice(0, 20_000))) {
    for (const match of form.matchAll(ONION_V3)) found.add(`${match[1]!.toLowerCase()}.onion`);
    for (const match of form.matchAll(V3_LABEL)) found.add(`${match[1]!.toLowerCase()}.onion`);
  }
  return [...found];
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
    private readonly cacheFile: string | null = defaultCacheFile(),
    private readonly routing: BannedListRouting = {}
  ) {}

  /** Download order: onion mirror first when Tor is preferred, and only the onion mirror in Tor-only mode. */
  downloadPlan(): Array<{ url: string; tor: boolean }> {
    const clear = { url: AHMIA_BANNED_URLS.clearnet, tor: false };
    const onion = { url: AHMIA_BANNED_URLS.onion, tor: true };
    if (!this.http.torEnabled) return this.routing.torOnly ? [] : [clear];
    if (this.routing.torOnly) return [onion];
    return this.routing.preferTor ? [onion, clear] : [clear, onion];
  }

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

  /** True when any onion address embedded in `text` (host, gateway, archived URL) is banned. */
  anyBanned(text: string): boolean {
    return embeddedOnions(text).some(host => this.isBanned(host));
  }

  private async load(signal?: AbortSignal): Promise<void> {
    const fromDisk = await this.readDiskCache();
    if (fromDisk) {
      this.setHashes(fromDisk, "disk cache");
      return;
    }
    const attempts = this.downloadPlan();
    if (attempts.length === 0) throw new Error("Tor-only mode needs DEEP_SEARCH_TOR_PROXY to download the Ahmia blacklist");
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
        if (hashes.size < MIN_BANNED_HASHES) throw new Error("Ahmia blacklist looks truncated or malformed");
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
      // lstat: a symlink planted in place of the cache is ignored, never followed
      const info = await lstat(this.cacheFile);
      if (!info.isFile()) return null;
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) return null;
      if (Date.now() - info.mtimeMs > DISK_MAX_AGE_MS) return null;
      const hashes = parseBannedList(await readFile(this.cacheFile, "utf8"));
      return hashes.size >= MIN_BANNED_HASHES ? hashes : null;
    } catch {
      return null;
    }
  }

  private async writeDiskCache(text: string): Promise<void> {
    if (!this.cacheFile) return;
    try {
      await mkdir(path.dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      // Write a fresh private file ("wx" refuses to reuse an existing path) and swap it in atomically
      const temp = `${this.cacheFile}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temp, this.cacheFile);
    } catch {
      // Cache is an optimization only
    }
  }
}
