import { socksDispatcher } from "fetch-socks";
import { Agent, request, type Dispatcher } from "undici";
import type { Config } from "../config.js";
import { assertPublicHost, BlockedRequestError, safeLookup } from "./ssrf.js";

export type HttpErrorKind = "http" | "timeout" | "network" | "blocked" | "too_large" | "tor" | "content_type" | "cancelled";

/** Error whose message is safe to show to the model: it names the host, never the full URL (which may carry API keys). */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly kind: HttpErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Maximum body size in bytes (default 8 MB). */
  maxBytes?: number;
  /** When the body exceeds maxBytes: false → throw, true → keep the first maxBytes and flag `truncated`. */
  truncate?: boolean;
  signal?: AbortSignal;
  /** Route through the Tor SOCKS proxy. Defaults to true for .onion hosts (which require it). */
  tor?: boolean;
  /**
   * Privacy-sensitive request (dark web index, page reading, Wayback lookups, general web search).
   * With DEEP_SEARCH_TOR_ROUTE=sensitive these go through Tor; with `all`, every request does.
   */
  sensitive?: boolean;
  /** "follow" (default) follows up to 5 redirects, re-checking every hop; "manual" returns the 3xx response. */
  redirect?: "follow" | "manual";
  /** Called with the response Content-Type before the body is downloaded; return false to reject it. */
  acceptContentType?: (contentType: string) => boolean;
  /** Human-readable service name used in error messages (defaults to the host). */
  label?: string;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  url: string;
  headers: Headers;
  contentType: string;
  body: Uint8Array;
  truncated: boolean;
  viaTor: boolean;
  text(): string;
  json<T = unknown>(): T;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export function isOnionHost(hostname: string): boolean {
  return hostname.toLowerCase().replace(/\.$/, "").endsWith(".onion");
}

/** Message for a non-2xx status, phrased so the model knows how to recover. */
export function statusMessage(label: string, status: number): string {
  if (status === 400) return `${label} rejected the query (HTTP 400). Try simpler keywords without special characters.`;
  if (status === 401 || status === 403) {
    return `${label} denied access (HTTP ${status}). It may require an API key or be blocking automated requests.`;
  }
  if (status === 404) return `${label} returned "not found" (HTTP 404).`;
  if (status === 429) return `${label} rate limit reached (HTTP 429). Wait a minute before retrying, or configure an API key.`;
  if (status >= 500) return `${label} is having problems (HTTP ${status}). Try again later.`;
  return `${label} returned HTTP ${status}.`;
}

function decode(body: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset\s*=\s*"?([\w.:-]+)/i)?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      // Unknown label: fall back to UTF-8
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

/**
 * Drops a response body we will not read. undici emits an AbortError when a body stream is destroyed;
 * without a listener that error is uncaught and would crash the server process.
 */
function discard(body: Dispatcher.ResponseData["body"]): void {
  body.on("error", () => undefined);
  body.destroy();
}

const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-subscription-token"]);

export function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
}

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

/**
 * Plain HTTP client (undici.request): it sends only the headers we set, identifies itself honestly
 * on the clear web, refuses private addresses (SSRF guard) and routes .onion hosts through Tor.
 */
export class HttpClient {
  private readonly direct: Dispatcher;
  /** Connection pools shared with every view created by withDefaults(). */
  private readonly pools: { tor?: Dispatcher } = {};
  private defaults: Partial<RequestOptions> = {};

  constructor(private readonly config: Config) {
    // Every clear-web connection resolves through safeLookup, which refuses private addresses.
    this.direct = new Agent({ connect: { lookup: safeLookup }, connections: 32 });
  }

  get torEnabled(): boolean {
    return this.config.tor !== undefined;
  }

  /** A view of this client whose requests use these defaults, e.g. { sensitive: true } for privacy-sensitive sources. */
  withDefaults(defaults: Partial<RequestOptions>): HttpClient {
    const scoped = Object.create(this) as HttpClient;
    scoped.defaults = { ...this.defaults, ...defaults };
    return scoped;
  }

  /** True when requests with these options are forced through Tor (on top of .onion hosts, which always are). */
  routesThroughTor(options: RequestOptions = {}): boolean {
    const merged = { ...this.defaults, ...options };
    if (merged.tor === true || this.config.torRoute === "all") return true;
    return this.config.torRoute === "sensitive" && merged.sensitive === true;
  }

  private tor(): Dispatcher {
    const tor = this.config.tor;
    if (!tor) {
      const route = this.config.torRoute !== "onion" ? ` (DEEP_SEARCH_TOR_ROUTE=${this.config.torRoute} sends this request through Tor and never directly)` : "";
      throw new HttpError(
        `Tor is not configured${route}. Start Tor (Tor Browser listens on 127.0.0.1:9150, the tor service on 9050) and set DEEP_SEARCH_TOR_PROXY, e.g. socks5h://127.0.0.1:9150.`,
        "tor"
      );
    }
    this.pools.tor ??= socksDispatcher({ type: 5, host: tor.host, port: tor.port });
    return this.pools.tor;
  }

  /** Validates a URL and picks the route (direct or Tor) for it. */
  private route(url: URL, forceTor: boolean | undefined): { dispatcher: Dispatcher; viaTor: boolean } {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new HttpError(`Only http and https URLs are supported (got ${url.protocol}).`, "blocked");
    }
    if (url.username || url.password) throw new HttpError("URLs with embedded credentials are not allowed.", "blocked");
    const onion = isOnionHost(url.hostname);
    const viaTor = onion || forceTor === true;
    if (!onion) {
      // Clear-web hosts may never be local or private, even when the hop is routed through Tor
      try {
        assertPublicHost(url);
      } catch (error) {
        throw new HttpError((error as Error).message, "blocked");
      }
    }
    return viaTor ? { dispatcher: this.tor(), viaTor } : { dispatcher: this.direct, viaTor };
  }

  async request(input: string | URL, requestOptions: RequestOptions = {}): Promise<HttpResponse> {
    const options: RequestOptions = { ...this.defaults, ...requestOptions };
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new HttpError(`Invalid URL: ${String(input).slice(0, 200)}`, "blocked");
    }
    const label = options.label ?? url.hostname;
    let method = options.method ?? "GET";
    let body = options.body;
    const follow = (options.redirect ?? "follow") === "follow";
    // The routing policy can force Tor from the first hop. Once a request has gone through Tor, every
    // redirect hop stays on Tor: leaving it would reveal the user's IP.
    let forceTor: boolean | undefined = this.routesThroughTor(options) ? true : options.tor;
    let extraHeaders: Record<string, string> = { ...options.headers };

    for (let hop = 0; ; hop++) {
      const { dispatcher, viaTor } = this.route(url, forceTor);
      if (viaTor) forceTor = true;
      const timeoutMs = options.timeoutMs ?? (viaTor ? this.config.torTimeoutMs : this.config.timeoutMs);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const headers: Record<string, string> = {
        // Over Tor, the Tor Browser UA keeps us inside its anonymity set; elsewhere we say who we are.
        "user-agent": viaTor ? this.config.torUserAgent : this.config.userAgent,
        accept: "*/*",
        ...(viaTor ? { "accept-language": "en-US,en;q=0.5" } : {}), // Tor Browser's default, for every user
        ...extraHeaders
      };

      let response: Dispatcher.ResponseData;
      try {
        response = await request(url, { method, headers, body, signal, dispatcher });
      } catch (error) {
        throw this.wrapError(error, label, viaTor, timeoutMs, options.signal, timeout);
      }

      const responseHeaders = toHeaders(response.headers);
      const status = response.statusCode;
      const location = responseHeaders.get("location");
      if (follow && location && [301, 302, 303, 307, 308].includes(status)) {
        discard(response.body);
        if (hop >= MAX_REDIRECTS) throw new HttpError(`${label} redirected too many times.`, "http", status);
        const next = new URL(location, url);
        // API keys and cookies never follow a redirect to another origin (host, port or scheme)
        if (next.origin !== url.origin) extraHeaders = withoutCredentials(extraHeaders);
        url = next;
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }

      const ok = status >= 200 && status < 300;
      const contentType = responseHeaders.get("content-type") ?? "";
      if (options.acceptContentType && ok && !options.acceptContentType(contentType)) {
        discard(response.body);
        throw new HttpError(
          `Unsupported content type "${contentType || "unknown"}" from ${label}. Only text, HTML, XML, JSON and PDF are read (no images, video or downloads).`,
          "content_type",
          status
        );
      }

      let data: { body: Uint8Array; truncated: boolean };
      try {
        data = await readBody(response, responseHeaders, options.maxBytes ?? DEFAULT_MAX_BYTES, options.truncate ?? false, label);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw this.wrapError(error, label, viaTor, timeoutMs, options.signal, timeout);
      }

      return {
        status,
        ok,
        url: url.toString(),
        headers: responseHeaders,
        contentType,
        body: data.body,
        truncated: data.truncated,
        viaTor,
        text: () => decode(data.body, contentType),
        json: <T>() => {
          try {
            return JSON.parse(decode(data.body, contentType)) as T;
          } catch {
            throw new HttpError(`${label} returned an invalid JSON response.`, "http", status);
          }
        }
      };
    }
  }

  /** Like request(), but throws an HttpError for non-2xx responses. */
  async requestOk(input: string | URL, options: RequestOptions = {}): Promise<HttpResponse> {
    const response = await this.request(input, options);
    if (!response.ok) {
      throw new HttpError(statusMessage(options.label ?? safeHost(input), response.status), "http", response.status);
    }
    return response;
  }

  async getJson<T>(input: string | URL, options: RequestOptions = {}): Promise<T> {
    const response = await this.requestOk(input, { ...options, headers: { accept: "application/json", ...options.headers } });
    return response.json<T>();
  }

  async getText(input: string | URL, options: RequestOptions = {}): Promise<string> {
    return (await this.requestOk(input, options)).text();
  }

  private wrapError(
    error: unknown,
    label: string,
    viaTor: boolean,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    timeout: AbortSignal
  ): HttpError {
    if (error instanceof HttpError) return error;
    if (callerSignal?.aborted) return new HttpError("Request cancelled.", "cancelled");
    if (timeout.aborted) {
      return new HttpError(
        `${label} did not respond within ${Math.round(timeoutMs / 1000)}s${viaTor ? " (onion services are often slow or offline)" : ""}.`,
        "timeout"
      );
    }
    const cause = (error as { cause?: unknown }).cause ?? error;
    if (cause instanceof BlockedRequestError || (cause as { code?: string })?.code === "EBLOCKED") {
      return new HttpError((cause as Error).message, "blocked");
    }
    const code = (cause as { code?: string })?.code;
    const message = (cause as Error)?.message ?? String(cause);
    if (viaTor) {
      // Through SOCKS, a refused TCP connection can only be the proxy itself (destinations fail with SOCKS replies)
      if ((code === "ECONNREFUSED" || /ECONNREFUSED/.test(message)) && this.config.tor) {
        return new HttpError(`Could not reach the Tor SOCKS proxy at ${this.config.tor.host}:${this.config.tor.port}. Is Tor running?`, "tor");
      }
      if (/socks/i.test(message)) {
        return new HttpError(`Tor could not reach ${label}: the onion service may be offline (${message}).`, "network");
      }
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new HttpError(`Could not resolve ${label} (DNS lookup failed).`, "network");
    if (code === "ECONNREFUSED") return new HttpError(`${label} refused the connection.`, "network");
    if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return new HttpError(`Connection to ${label} was reset.`, "network");
    if ((typeof code === "string" && code.startsWith("CERT_")) || /certificate/i.test(message)) {
      return new HttpError(`TLS certificate problem with ${label}: ${message}`, "network");
    }
    return new HttpError(`Request to ${label} failed: ${message}`, "network");
  }
}

function safeHost(input: string | URL): string {
  try {
    return new URL(input).hostname;
  } catch {
    return "the server";
  }
}

async function readBody(
  response: Dispatcher.ResponseData,
  headers: Headers,
  maxBytes: number,
  truncate: boolean,
  label: string
): Promise<{ body: Uint8Array; truncated: boolean }> {
  const declared = Number(headers.get("content-length") ?? "NaN");
  if (!truncate && Number.isFinite(declared) && declared > maxBytes) {
    discard(response.body);
    throw new HttpError(`Response from ${label} is too large (${declared} bytes, limit ${maxBytes}).`, "too_large", response.statusCode);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  response.body.on("error", () => undefined); // errors surface through the iterator below
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    if (size + chunk.byteLength > maxBytes) {
      if (!truncate) {
        discard(response.body);
        throw new HttpError(`Response from ${label} is larger than the ${maxBytes}-byte limit.`, "too_large", response.statusCode);
      }
      chunks.push(chunk.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      discard(response.body);
      break;
    }
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated };
}
