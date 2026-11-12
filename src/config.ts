export interface TorProxy {
  host: string;
  port: number;
}

/** How the Ahmia dark web index is reached: `auto` uses the onion mirror when Tor is configured. */
export type AhmiaMode = "auto" | "clearnet" | "onion";

/**
 * Which traffic goes through Tor:
 * - onion (default): only .onion addresses (which cannot be reached any other way)
 * - sensitive: also the dark web index, page reading, Wayback lookups and general web search;
 *   academic and open-data APIs stay direct
 * - all: every request
 * In `sensitive` and `all`, a request that must use Tor fails when Tor is unavailable: it never goes out directly.
 */
export type TorRoute = "onion" | "sensitive" | "all";

export interface Config {
  tor?: TorProxy;
  ahmiaMode: AhmiaMode;
  torRoute: TorRoute;
  /** Safety filter categories the user asked to disable (locked ones are ignored by the guard). */
  disabledFilters: string[];
  keys: {
    openalex?: string;
    core?: string;
    semanticScholar?: string;
    marginalia?: string;
    brave?: string;
  };
  /** Optional contact e-mail for the "polite pools" of Crossref/OpenAlex. Never sent unless set. */
  contactEmail?: string;
  timeoutMs: number;
  torTimeoutMs: number;
  /** User-Agent for API calls. Generic on purpose: it identifies the software, not the user. */
  userAgent: string;
  /** User-Agent over Tor: Tor Browser's, so the traffic blends into its anonymity set. */
  torUserAgent: string;
  cacheTtlMs: number;
}

export const VERSION = "0.1.0";

/**
 * Tor Browser's User-Agent (Firefox ESR base, always reported as Windows). Update it, or set
 * DEEP_SEARCH_TOR_USER_AGENT, when Tor Browser moves to a new ESR, or this client stands out.
 */
export const TOR_BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0";

const DEFAULTS = {
  timeoutMs: 20_000,
  torTimeoutMs: 60_000,
  cacheTtlMs: 10 * 60_000
};

/** Accepts `socks5h://127.0.0.1:9050`, `socks5://host:port`, `host:port` or a bare port. */
export function parseTorProxy(value: string): TorProxy {
  const raw = value.trim();
  if (/^\d+$/.test(raw)) return { host: "127.0.0.1", port: checkPort(Number(raw), value) };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `socks5h://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`DEEP_SEARCH_TOR_PROXY is not a valid proxy address: "${value}". Use e.g. socks5h://127.0.0.1:9050`);
  }
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") {
    throw new Error(`DEEP_SEARCH_TOR_PROXY must be a SOCKS5 proxy (socks5h://host:port), got "${url.protocol}"`);
  }
  if (!url.port) throw new Error(`DEEP_SEARCH_TOR_PROXY needs a port, e.g. socks5h://127.0.0.1:9050`);
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: checkPort(Number(url.port), value) };
}

function checkPort(port: number, original: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`DEEP_SEARCH_TOR_PROXY has an invalid port: "${original}"`);
  }
  return port;
}

function positiveInt(value: string | undefined, fallback: number, name: string, warnings: string[]): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    warnings.push(`${name}="${value}" is not a positive integer; using ${fallback}.`);
    return fallback;
  }
  return n;
}

function optional(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): { config: Config; warnings: string[] } {
  const warnings: string[] = [];

  let tor: TorProxy | undefined;
  const torValue = optional(env.DEEP_SEARCH_TOR_PROXY);
  if (torValue) {
    try {
      tor = parseTorProxy(torValue);
    } catch (error) {
      warnings.push(`${(error as Error).message} — Tor features stay disabled.`);
    }
  }

  let ahmiaMode: AhmiaMode = "auto";
  const modeValue = optional(env.DEEP_SEARCH_AHMIA_MODE)?.toLowerCase();
  if (modeValue === "auto" || modeValue === "clearnet" || modeValue === "onion") {
    ahmiaMode = modeValue;
  } else if (modeValue) {
    warnings.push(`DEEP_SEARCH_AHMIA_MODE="${modeValue}" is invalid (auto|clearnet|onion); using auto.`);
  }
  if (ahmiaMode === "onion" && !tor) {
    warnings.push("DEEP_SEARCH_AHMIA_MODE=onion requires DEEP_SEARCH_TOR_PROXY; dark web search will be unavailable.");
  }

  let torRoute: TorRoute = "onion";
  const routeValue = optional(env.DEEP_SEARCH_TOR_ROUTE)?.toLowerCase();
  if (routeValue === "onion" || routeValue === "sensitive" || routeValue === "all") {
    torRoute = routeValue;
  } else if (routeValue) {
    warnings.push(`DEEP_SEARCH_TOR_ROUTE="${routeValue}" is invalid (onion|sensitive|all); using onion.`);
  }
  if (torRoute !== "onion" && !tor) {
    warnings.push(
      `DEEP_SEARCH_TOR_ROUTE=${torRoute} needs DEEP_SEARCH_TOR_PROXY: requests that must use Tor will fail instead of going out directly.`
    );
  }

  const disabledFilters = (env.DEEP_SEARCH_DISABLED_FILTERS ?? "")
    .split(/[\s,;]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const config: Config = {
    tor,
    ahmiaMode,
    torRoute,
    disabledFilters,
    keys: {
      openalex: optional(env.OPENALEX_API_KEY),
      core: optional(env.CORE_API_KEY),
      semanticScholar: optional(env.SEMANTIC_SCHOLAR_API_KEY),
      marginalia: optional(env.MARGINALIA_API_KEY),
      brave: optional(env.BRAVE_API_KEY)
    },
    contactEmail: optional(env.DEEP_SEARCH_CONTACT_EMAIL),
    timeoutMs: positiveInt(env.DEEP_SEARCH_TIMEOUT_MS, DEFAULTS.timeoutMs, "DEEP_SEARCH_TIMEOUT_MS", warnings),
    torTimeoutMs: positiveInt(env.DEEP_SEARCH_TOR_TIMEOUT_MS, DEFAULTS.torTimeoutMs, "DEEP_SEARCH_TOR_TIMEOUT_MS", warnings),
    userAgent: `deep-search-mcp/${VERSION}`,
    torUserAgent: optional(env.DEEP_SEARCH_TOR_USER_AGENT) ?? TOR_BROWSER_USER_AGENT,
    cacheTtlMs: DEFAULTS.cacheTtlMs
  };
  return { config, warnings };
}
