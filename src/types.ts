import type { TtlCache } from "./cache.js";
import type { Config } from "./config.js";
import type { HttpClient } from "./http/client.js";
import type { BannedOnionList } from "./safety/banned.js";

/** Groups of sources a search can cover. */
export const SCOPES = ["academic", "data", "archive", "web", "darkweb"] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * Safety channel of a source: decides which filter rules apply.
 * - academic: curated scholarly metadata (only the strictest rules apply)
 * - web: open/user-generated content on the clear web
 * - darkweb: Tor onion services (strictest)
 */
export const CHANNELS = ["academic", "web", "darkweb"] as const;
export type Channel = (typeof CHANNELS)[number];

export const SOURCE_IDS = [
  "openalex",
  "core",
  "crossref",
  "scielo",
  "europepmc",
  "arxiv",
  "doaj",
  "semantic_scholar",
  "bdtd",
  "datacite",
  "zenodo",
  "internet_archive",
  "marginalia",
  "wiby",
  "duckduckgo",
  "brave",
  "ahmia"
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** One search hit, normalized across sources (snake_case: it is serialized as-is in JSON output). */
export interface SearchResult {
  source: SourceId;
  title: string;
  url: string;
  snippet?: string;
  authors?: string[];
  year?: number;
  date?: string;
  venue?: string;
  doi?: string;
  pdf_url?: string;
  open_access?: boolean;
  type?: string;
  citations?: number;
  language?: string;
  onion?: boolean;
  last_seen?: string;
  also_in?: SourceId[];
}

export interface SearchQuery {
  query: string;
  limit: number;
  offset: number;
  yearFrom?: number;
  yearTo?: number;
  signal?: AbortSignal;
}

export interface SourcePage {
  results: SearchResult[];
  /** Total hits reported by the source, when known. */
  total?: number;
  /** True when `results` is the full result list; the orchestrator filters first, then paginates. */
  complete?: boolean;
  note?: string;
}

export interface SourceDeps {
  http: HttpClient;
  config: Config;
  cache: TtlCache<unknown>;
  banned: BannedOnionList;
}

export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface Source {
  id: SourceId;
  name: string;
  scope: Scope;
  channel: Channel;
  homepage: string;
  description: string;
  /** Whether the source runs when its scope is selected and no explicit source list is given. */
  isDefault(config: Config): boolean;
  /** Whether the source can run at all with the current configuration. */
  availability(config: Config): Availability;
  search(query: SearchQuery, deps: SourceDeps): Promise<SourcePage>;
}
