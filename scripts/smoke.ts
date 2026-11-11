/**
 * End-to-end self-check: starts the built server over stdio (as an MCP host would), calls every tool
 * against the real services and exits non-zero on any failure.
 * Usage: npm run build && npm run smoke
 */
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

const passEnv = ["DEEP_SEARCH_TOR_PROXY", "OPENALEX_API_KEY", "CORE_API_KEY", "SEMANTIC_SCHOLAR_API_KEY", "MARGINALIA_API_KEY", "BRAVE_API_KEY"];
const env: Record<string, string> = { ...getDefaultEnvironment() };
for (const name of passEnv) if (process.env[name]) env[name] = process.env[name]!;

const client = new Client({ name: "deep-search-smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "ignore" }));

let failures = 0;
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    console.error(`  ok   ${name} (${Date.now() - started}ms) ${detail}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}: ${(error as Error).message}`);
  }
}
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult) => r.content?.map(c => c.text ?? "").join("\n") ?? "";

await check("lists the four tools and the prompt", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ["deepsearch_archived_versions", "deepsearch_fetch_page", "deepsearch_list_sources", "deepsearch_search"]);
  for (const tool of tools) assert.ok(tool.annotations?.readOnlyHint, `${tool.name} should be read-only`);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name), ["deepsearch_investigate"]);
  return `${tools.length} tools`;
});

await check("deepsearch_list_sources (json)", async () => {
  const r = await call("deepsearch_list_sources", { response_format: "json" });
  assert.ok(!r.isError, text(r));
  const sources = r.structuredContent?.sources as unknown[];
  assert.equal(sources.length, 17);
  return `${sources.length} sources`;
});

await check("academic search returns results with links", async () => {
  const r = await call("deepsearch_search", { query: "dengue vaccine", sources: ["openalex", "arxiv", "europepmc"], limit_per_source: 2, response_format: "json" });
  assert.ok(!r.isError, text(r));
  const results = r.structuredContent?.results as Array<{ url: string; title: string }>;
  assert.ok(results.length >= 2, "expected results");
  assert.ok(results.every(x => /^https?:\/\//.test(x.url)));
  return `${results.length} results, e.g. "${results[0]!.title.slice(0, 50)}"`;
});

await check("dark web search goes through Ahmia with the filter applied", async () => {
  const r = await call("deepsearch_search", { query: "privacy", scopes: ["darkweb"], limit_per_source: 3, response_format: "json" });
  assert.ok(!r.isError, text(r));
  const results = r.structuredContent?.results as Array<{ onion?: boolean }>;
  const safety = r.structuredContent?.safety as { hidden: number; banned_list_loaded: boolean };
  assert.ok(results.length > 0 && results.every(x => x.onion), "expected onion results");
  assert.ok(safety.banned_list_loaded, "Ahmia blacklist should be loaded");
  return `${results.length} onion results, ${safety.hidden} hidden by the filter`;
});

await check("abuse query is refused on web and dark web", async () => {
  const r = await call("deepsearch_search", { query: "child porn", scopes: ["web", "darkweb"] });
  assert.equal(r.isError, true);
  assert.match(text(r), /Refused by the safety policy/);
  return "refused";
});

await check("abuse query still allows academic research", async () => {
  const r = await call("deepsearch_search", { query: "child sexual abuse prevention", scopes: ["academic"], sources: ["openalex"], limit_per_source: 2 });
  assert.ok(!r.isError, text(r));
  return "allowed";
});

await check("weapons-of-mass-harm instructions are refused", async () => {
  const r = await call("deepsearch_search", { query: "how to make a pipe bomb", scopes: ["web", "darkweb"] });
  assert.equal(r.isError, true);
  return "refused";
});

await check("fetch_page reads an HTML page", async () => {
  const r = await call("deepsearch_fetch_page", { url: "https://example.com", response_format: "json" });
  assert.ok(!r.isError, text(r));
  assert.match(String(r.structuredContent?.text), /Example Domain|documentation/i);
  return `title="${r.structuredContent?.title}"`;
});

await check("fetch_page converts a PDF to text", async () => {
  const r = await call("deepsearch_fetch_page", { url: "https://arxiv.org/pdf/1308.6768", max_chars: 2000, response_format: "json" });
  assert.ok(!r.isError, text(r));
  const s = r.structuredContent as { total_chars: number; pdf_pages?: number; has_more: boolean };
  assert.ok(s.total_chars > 5000 && (s.pdf_pages ?? 0) > 1, "expected a multi-page PDF");
  assert.ok(s.has_more, "long PDF should paginate");
  return `${s.pdf_pages} pages, ${s.total_chars} chars`;
});

await check("fetch_page refuses private network addresses", async () => {
  const r = await call("deepsearch_fetch_page", { url: "http://127.0.0.1:8080/admin" });
  assert.equal(r.isError, true);
  assert.match(text(r), /private|local/i);
  return "blocked";
});

await check("fetch_page explains that .onion needs Tor", async () => {
  if (process.env.DEEP_SEARCH_TOR_PROXY) return "skipped (Tor configured)";
  const r = await call("deepsearch_fetch_page", { url: "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/" });
  assert.equal(r.isError, true);
  assert.match(text(r), /Tor/);
  return "explained";
});

await check("archived_versions lists Wayback captures", async () => {
  const r = await call("deepsearch_archived_versions", { url: "example.com", limit: 3, response_format: "json" });
  assert.ok(!r.isError, text(r));
  const snaps = r.structuredContent?.snapshots as Array<{ raw_url: string }>;
  assert.ok(snaps.length > 0 && snaps[0]!.raw_url.includes("id_/"));
  return `${snaps.length} captures`;
});

await check("invalid arguments come back as a tool error", async () => {
  const r = await call("deepsearch_search", { query: "x" });
  assert.equal(r.isError, true);
  const r2 = await call("deepsearch_search", { query: "ok query", unknown_field: 1 });
  assert.equal(r2.isError, true);
  return "rejected";
});

await check("investigate prompt renders", async () => {
  const p = await client.getPrompt({ name: "deepsearch_investigate", arguments: { topic: "água contaminada em Minas Gerais" } });
  assert.match(JSON.stringify(p.messages), /deepsearch_search/);
  return "ok";
});

await client.close();
if (failures) {
  console.error(`\nSmoke test FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.error("\nSmoke test passed");
