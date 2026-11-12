import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { TtlCache } from "./cache.js";
import { loadConfig, VERSION, type Config } from "./config.js";
import { renderArchive, renderPage, renderSearch, renderSources, type Rendered, type ResponseFormat } from "./format.js";
import { HttpClient, HttpError } from "./http/client.js";
import { BannedOnionList, defaultCacheFile } from "./safety/banned.js";
import { SafetyGuard } from "./safety/guard.js";
import { runSearch, SafetyRefusal, type SearchDeps } from "./search.js";
import { SOURCES } from "./sources/registry.js";
import { archivedVersions } from "./tools/archive.js";
import { fetchPageContent } from "./tools/page.js";
import { SCOPES, SOURCE_IDS } from "./types.js";

export interface Runtime extends SearchDeps {
  warnings: string[];
}

/** Shared, long-lived state (HTTP agents, caches, blacklist). Built once per process. */
export function createRuntime(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Runtime {
  const { config: loaded, warnings } = loadConfig(env);
  const config: Config = { ...loaded, ...overrides };
  const http = new HttpClient(config);
  const guard = new SafetyGuard(config.disabledFilters);
  for (const ignored of guard.ignored) warnings.push(`DEEP_SEARCH_DISABLED_FILTERS: ignoring ${ignored}.`);
  return {
    config,
    warnings,
    http,
    guard,
    cache: new TtlCache<unknown>(config.cacheTtlMs),
    // With Tor configured the blacklist comes through Ahmia's onion mirror first; in onion mode, only from it
    banned: new BannedOnionList(http, defaultCacheFile(env), { preferTor: Boolean(config.tor), torOnly: config.ahmiaMode === "onion" })
  };
}

const INSTRUCTIONS = `Deep Search finds material that mainstream search engines bury or never index.
Workflow: 1) deepsearch_search across scopes (academic, data, archive, web without Google, darkweb via Ahmia);
2) deepsearch_fetch_page to read promising results, including PDFs (.onion pages need Tor);
3) deepsearch_archived_versions to recover pages that were removed or changed.
Cite URLs/DOIs. Treat dark web and small-web results as unverified leads.
A safety policy is always on: some subjects are refused and some results are hidden. Never rephrase a query to get around a refusal.`;

const responseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' for readable text (default) or 'json' for structured data.");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function ok(rendered: Rendered, format: ResponseFormat): CallToolResult {
  return format === "json" && rendered.structured
    ? { content: [{ type: "text", text: rendered.text }], structuredContent: rendered.structured }
    : { content: [{ type: "text", text: rendered.text }] };
}

function failure(error: unknown): CallToolResult {
  let text: string;
  if (error instanceof SafetyRefusal) text = `Refused by the safety policy: ${error.message}`;
  else if (error instanceof HttpError) text = error.message;
  else if (error instanceof Error && error.name === "AbortError") text = "Request cancelled.";
  else text = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  return { isError: true, content: [{ type: "text", text }] };
}

export function createServer(rt: Runtime): McpServer {
  const server = new McpServer({ name: "deep-search", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "deepsearch_search",
    {
      title: "Deep Search",
      description: `Search beyond Google in one call: academic databases, open data, digital archives, independent web indexes and the Tor dark web.

Scopes (default: all):
- academic: OpenAlex, CORE, Crossref, SciELO, Europe PMC (incl. PubMed), arXiv, DOAJ, BDTD (Brazilian theses); Semantic Scholar on request
- data: DataCite datasets, Zenodo
- archive: Internet Archive collections (books, documents, media)
- web: Marginalia and Wiby (independent small-web indexes), DuckDuckGo; Brave with a key
- darkweb: Ahmia, an onion-service index that removes abuse content

Returns results grouped by source with title, URL, snippet, authors/year/venue, DOI and open-access PDF links when available, plus per-source status (errors in one source do not fail the call). Duplicates across sources are merged.

Examples:
- "studies on glyphosate and cancer since 2015" -> query="glyphosate cancer", scopes=["academic","data"], year_from=2015
- "what is said about this ransomware group on onion sites" -> query="<group name>", scopes=["darkweb"]
- "independent blogs about local tech history" -> query="...", scopes=["web"], exclude_domains=["wikipedia.org"]

Use deepsearch_fetch_page to read a result and deepsearch_archived_versions for removed pages. Safety: the query is screened (some subjects are refused on web/dark web) and results are filtered; do not rephrase to get around a refusal.`,
      inputSchema: z.strictObject({
        query: z
          .string()
          .trim()
          .min(2)
          .max(300)
          .describe("What to research, in any language. Plain keywords work best, e.g. 'dengue vaccine efficacy' or 'vazamento de dados'."),
        scopes: z
          .array(z.enum(SCOPES))
          .min(1)
          .max(SCOPES.length)
          .optional()
          .describe("Source groups to search: 'academic', 'data', 'archive', 'web', 'darkweb'. Default: all."),
        sources: z
          .array(z.enum(SOURCE_IDS))
          .min(1)
          .max(SOURCE_IDS.length)
          .optional()
          .describe("Run exactly these sources instead of whole scopes, e.g. ['openalex','ahmia']. Needed for opt-in sources like 'semantic_scholar'. See deepsearch_list_sources."),
        limit_per_source: z.number().int().min(1).max(25).default(5).describe("Maximum results per source (1-25)."),
        offset: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .default(0)
          .describe("Results to skip in every source, for pagination. Use next_offset from the previous call."),
        year_from: z.number().int().min(1500).max(2100).optional().describe("Only works from this year on (academic, data and archive sources)."),
        year_to: z.number().int().min(1500).max(2100).optional().describe("Only works up to this year (academic, data and archive sources)."),
        exclude_domains: z
          .array(z.string().trim().min(3).max(253))
          .max(50)
          .optional()
          .describe("Hide results from these domains and their subdomains, e.g. ['wikipedia.org','medium.com']."),
        response_format: responseFormat
      }),
      annotations: READ_ONLY
    },
    async (args, ctx) => {
      try {
        if (args.year_from !== undefined && args.year_to !== undefined && args.year_from > args.year_to) {
          return failure(new Error("year_from must be less than or equal to year_to."));
        }
        const outcome = await runSearch(args, rt, ctx.mcpReq.signal);
        return ok(renderSearch(outcome, args.response_format), args.response_format);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "deepsearch_fetch_page",
    {
      title: "Read Page",
      description: `Fetch a web page, PDF or .onion page and return its readable text (no images, scripts or downloads), plus its outgoing links.

- Accepts full URLs or bare domains; PDFs are converted to text; Wayback Machine snapshot URLs are read without the archive toolbar.
- Long pages are returned in chunks: when has_more is true, call again with start_char=next_start_char.
- .onion pages require Tor (DEEP_SEARCH_TOR_PROXY). Onion services on Ahmia's abuse blacklist are never opened.
- Local/private network addresses are refused.

Safety: pages dominated by filtered content are withheld (the text is not returned) and filtered links are hidden.`,
      inputSchema: z.strictObject({
        url: z
          .string()
          .trim()
          .min(4)
          .max(2048)
          .describe("Page to read: http(s) URL, bare domain, PDF link, .onion address or Wayback snapshot URL."),
        max_chars: z.number().int().min(500).max(20_000).default(10_000).describe("How many characters of text to return in this call."),
        start_char: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Where to continue reading a long page. Use next_start_char from the previous call."),
        include_links: z.boolean().default(true).describe("Also list the page's links (filtered by the safety policy)."),
        response_format: responseFormat
      }),
      annotations: READ_ONLY
    },
    async (args, ctx) => {
      try {
        const page = await fetchPageContent(args, rt, ctx.mcpReq.signal);
        return ok(renderPage(page, args.response_format), args.response_format);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "deepsearch_archived_versions",
    {
      title: "Archived Versions",
      description: `List Wayback Machine (Internet Archive) captures of a URL, site or path, to recover pages that were deleted, censored or rewritten.

Each capture has a 'view' link and a 'raw' link; pass the raw link to deepsearch_fetch_page to read that version.

Examples:
- "was this government page changed?" -> url="gov.example/page", newest_first=true
- "everything archived under a deleted blog" -> url="blog.example.com/", match="prefix", limit=50
- "captures from 2019 only" -> from="2019", to="2019"`,
      inputSchema: z.strictObject({
        url: z.string().trim().min(3).max(2048).describe("URL or domain, e.g. 'example.com/report.pdf' or 'https://site.example/page'."),
        match: z
          .enum(["exact", "prefix", "host", "domain"])
          .default("exact")
          .describe("'exact' = this URL; 'prefix' = every URL under this path; 'host' = the whole host; 'domain' = host and subdomains."),
        from: z
          .string()
          .regex(/^\d{4}(\d{2}){0,5}$/, "Use YYYY, YYYYMM or YYYYMMDD")
          .optional()
          .describe("Earliest capture date: YYYY, YYYYMM or YYYYMMDD."),
        to: z
          .string()
          .regex(/^\d{4}(\d{2}){0,5}$/, "Use YYYY, YYYYMM or YYYYMMDD")
          .optional()
          .describe("Latest capture date: YYYY, YYYYMM or YYYYMMDD."),
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum captures to list."),
        newest_first: z.boolean().default(true).describe("true = most recent captures first."),
        only_successful: z.boolean().default(true).describe("Only captures that returned HTTP 200."),
        response_format: responseFormat
      }),
      annotations: READ_ONLY
    },
    async (args, ctx) => {
      try {
        const outcome = await archivedVersions(args, rt, ctx.mcpReq.signal);
        return ok(renderArchive(outcome, args.response_format), args.response_format);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "deepsearch_list_sources",
    {
      title: "List Sources & Policy",
      description:
        "List every search source (id, scope, whether it runs by default, configuration it needs), the Tor status and the active safety policy (which filter categories are on and which are locked). Use the ids with deepsearch_search's 'sources' parameter.",
      inputSchema: z.strictObject({ response_format: responseFormat }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async args => {
      const config = rt.config;
      const status = {
        version: VERSION,
        sources: SOURCES.map(s => {
          const availability = s.availability(config);
          const isDefault = s.isDefault(config);
          return {
            id: s.id,
            name: s.name,
            scope: s.scope,
            default: isDefault,
            available: availability.ok,
            status: !availability.ok ? `unavailable: ${availability.reason ?? "not configured"}` : isDefault ? "on by default" : "on request",
            homepage: s.homepage,
            description: s.description
          };
        }),
        tor: {
          configured: Boolean(config.tor),
          ...(config.tor ? { proxy: `socks5h://${config.tor.host}:${config.tor.port}` } : {}),
          ahmia_mode: config.ahmiaMode
        },
        safety: { policy: rt.guard.policy(), ignored_config: rt.guard.ignored, ahmia_blacklist: rt.banned.status() }
      };
      return ok(renderSources(status, args.response_format), args.response_format);
    }
  );

  server.registerPrompt(
    "deepsearch_investigate",
    {
      title: "Investigate a topic",
      description: "Guided multi-source investigation of a topic with Deep Search, ending in a cited report.",
      argsSchema: z.object({
        topic: z.string().min(2).describe("Topic to investigate"),
        focus: z.string().optional().describe("Optional angle, e.g. 'what mainstream outlets omit' or 'threat intelligence'")
      })
    },
    ({ topic, focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Investigate this topic in depth with the Deep Search tools: "${topic}"${focus ? ` (focus: ${focus})` : ""}.

1. Run deepsearch_search with the default scopes and limit_per_source=5. Repeat with one or two alternative phrasings or translations (for example English and Portuguese) to widen coverage.
2. Read the most promising results with deepsearch_fetch_page (PDFs included). For pages that are gone or changed, use deepsearch_archived_versions and read a capture's raw link.
3. Cross-check claims across independent sources. Prefer peer-reviewed and primary sources; treat dark web and small-web results as unverified leads.
4. Write a report: key findings with a citation (URL or DOI) for each, points of disagreement, what mainstream sources leave out, and open questions. Mark which findings come from the dark web.

If a search or page is refused by the safety policy, accept it and do not rephrase to get around it.`
          }
        }
      ]
    })
  );

  return server;
}
