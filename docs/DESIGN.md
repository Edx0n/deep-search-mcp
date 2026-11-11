# Deep Search MCP: design notes

## Goal

Give an assistant (through MCP) access to sources that commercial search engines bury or never index: scholarly and grey literature, open data, digital archives, independent indexes and `.onion` services. All of it behind a safety filter that the user cannot switch off entirely.

**Success criteria**

- A single call (`deepsearch_search`) covers every scope. One failing source never fails the search.
- Citable results (URL, DOI, open-access PDF) and predictable pagination.
- Abusive content is never shown. Legitimate research *about* sensitive topics stays possible.
- No CAPTCHA or bot-check evasion. The client identifies itself honestly.

## Architecture

```
src/
├── index.ts              stdio entry point (logs go to stderr only)
├── server.ts             createRuntime() + createServer(): 4 tools + 1 prompt (MCP SDK v2, Zod 4)
├── config.ts             environment variables → Config
├── search.ts             orchestrator: source selection, per-channel refusal, parallel execution,
│                         filtering, de-duplication, pagination
├── format.ts             Markdown/JSON under 25k characters (shorter snippets first, then fewer items)
├── cache.ts              in-memory TTL cache (10 min)
├── http/
│   ├── client.ts         undici.request: only the headers we set, redirects re-checked,
│   │                     byte limits, Tor through SOCKS5 (fetch-socks)
│   └── ssrf.ts           private-address blocking (at DNS lookup, i.e. at connect time)
├── safety/
│   ├── rules.ts          11 categories, per-channel rules and query-refusal rules
│   ├── normalize.ts      lowercase, no accents, leetspeak, URL separators
│   ├── guard.ts          checkQuery / classify / checkDocument
│   ├── banned.ts         Ahmia's MD5 blacklist (24 h disk cache)
│   └── scholarly.ts      scholarly hosts (their pages are screened with academic rules)
├── sources/              one source = pure parser (testable) + search() doing the HTTP call
│   ├── academic/         openalex, core, crossref (+ scielo), europepmc, arxiv, doaj,
│   │                     semanticscholar, bdtd
│   ├── data.ts           datacite, zenodo
│   ├── archive.ts        internet archive
│   ├── web.ts            marginalia, wiby, duckduckgo, brave
│   ├── darkweb.ts        ahmia (clear web or onion mirror)
│   └── registry.ts       display order and scope labels
├── extract/              HTML → structured text + links; PDF → text (unpdf)
└── tools/                logic of deepsearch_fetch_page and deepsearch_archived_versions
```

## Search flow

1. **Selection**: explicit `sources`, or the default sources of the requested `scopes` (all of them by default).
2. **Per-channel refusal**: `guard.checkQuery()` returns the channels where the query may not run. If every requested channel is refused, the tool returns an error that explains why.
3. **Parallel execution**: each source has its own timeout; errors become an `error` status in that source's report.
4. **Per-source post-processing**: year filter (sources that support it filter server-side; for the others this is a safety net), `exclude_domains`, Ahmia's blacklist and `guard.classify()`. Hidden results are counted by reason; their content is never shown.
5. **Pagination**:
   - Sources that paginate server-side receive `offset` and `limit`; page-based APIs go through `pageWindow()`.
   - Ahmia returns everything in a single page (`complete: true`), so the orchestrator filters **before** paginating and pages stay consistent.
6. **De-duplication**: by DOI, or by normalized URL. The first occurrence is kept and gains `also_in`.
7. **Formatting**: above 25k characters, snippets are shortened first (600 → 280 → 140 characters) while every result is kept. Only if that is not enough, the number of items per source drops one at a time (the same cap for every source), and `next_offset` stays correct. JSON text is compact (no indentation).

## Safety model

| Channel | Sources | Rules applied |
|---|---|---|
| `academic` | scholarly metadata, and pages on scholarly hosts | only unambiguous child-abuse slang |
| `web` | web search engines, Internet Archive, clear-web pages | every active category |
| `darkweb` | Ahmia, `.onion` pages | every active category, plus topic rules (e.g. clinical abuse terms) and the blacklist |

- **Queries**: locked categories refuse the query on the open channels (explicit `csam`, `mass_harm`) or only on the dark web (topic terms, `exploitation`). Configurable categories never refuse queries; they only hide listings.
- **Documents** (`deepsearch_fetch_page`): a single hit of a locked category withholds the page. Configurable categories need 3 hits, so a news article that merely mentions the subject still passes.
- **Rules target transactions, not topics**. "buy cocaine" is filtered; "darknet drug markets research" is not. A false-positive test suite protects cases such as "bath bomb", "bomba d'água", "Al Gore", "drug delivery", "Lolita (Nabokov)", "cp command" and "recover hacked Instagram account".
- **Ahmia's blacklist**: MD5 of the `.onion` domain (the same computation as Ahmia's own code). Opening any `.onion` page requires the list to be loaded (fail-closed).

## Decisions and rejected alternatives

- **Ahmia only for the dark web**: it is the only index that actively removes abuse content. Torch, Haystak and others do not filter, and their known addresses were outdated.
- **`undici.request` instead of `fetch`**: `fetch` injects browser headers (`sec-fetch-mode`…). With them, DuckDuckGo treated the client as a disguised bot; with a plain, honest request it answers normally.
- **User-Agent**: honest (`deep-search-mcp/x.y`) on the clear web; Tor Browser's only over Tor, for its anonymity set.
- **Crossref behind a serial queue (1 request/s)**: the public pool announces `x-rate-limit-limit: 1` and `x-concurrency-limit: 1`. Crossref and SciELO share the queue and retry once after a 429.
- **SciELO through Crossref (member 530)**: SciELO's own search blocks automation; Crossref covers the same DOIs.
- **Semantic Scholar and Brave on request**: without keys, one lives in HTTP 429 and the other does not work at all. Marginalia runs by default because, when it works, it is the most "anti-favoritism" source.
- **The user's e-mail is never sent** to the APIs. The polite pool is used only if `DEEP_SEARCH_CONTACT_EMAIL` is set.
- **Shorter snippets before fewer results**: an all-scope search used to be cut to 2 results per source. Shortening snippets first keeps 5 per source in Markdown; the full text is one `deepsearch_fetch_page` call away.

## Tests

- `npm test` (no network):
  - safety rules: positives, false positives, disabling and locks;
  - parsers of every source, with synthetic fixtures;
  - HTTP client: SSRF, a simulated SOCKS5 proxy (checks that the `.onion` name goes to the proxy), redirects and byte limits;
  - HTML extraction, the orchestrator with fake sources (dedupe, post-filter pagination, refusals, isolated failures) and output sizing.
- `npm run smoke`: a real MCP client over stdio against the real services: academic and dark web search, refusals, HTML, an arXiv PDF, SSRF, Wayback and input validation.
- `npm run live`: per-source diagnostics.
