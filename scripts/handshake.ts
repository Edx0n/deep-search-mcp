/**
 * Offline MCP handshake (used by CI): starts the built server over stdio, like an MCP host, and checks
 * everything that needs no network: tool and prompt listing, sources and safety policy, input
 * validation, safety refusals, the SSRF guard and the Tor requirement for .onion pages.
 * Usage: npm run build && npm run handshake
 */
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

const client = new Client({ name: "deep-search-handshake", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: getDefaultEnvironment(), stderr: "ignore" }));

const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult) => r.content?.map(c => c.text ?? "").join("\n") ?? "";

const { tools } = await client.listTools();
assert.deepEqual(tools.map(t => t.name).sort(), ["deepsearch_archived_versions", "deepsearch_fetch_page", "deepsearch_list_sources", "deepsearch_search"]);
for (const tool of tools) assert.ok(tool.annotations?.readOnlyHint, `${tool.name} should be read-only`);
const { prompts } = await client.listPrompts();
assert.deepEqual(prompts.map(p => p.name), ["deepsearch_investigate"]);

const listing = await call("deepsearch_list_sources", { response_format: "json" });
assert.ok(!listing.isError, text(listing));
assert.equal((listing.structuredContent?.sources as unknown[]).length, 17);
const policy = (listing.structuredContent?.safety as { policy: Array<{ id: string; locked: boolean; enabled: boolean }> }).policy;
assert.deepEqual(policy.filter(p => p.locked).map(p => p.id), ["csam", "exploitation", "mass_harm"]);
assert.ok(policy.every(p => p.enabled), "every safety category is on by default");

const invalid = await call("deepsearch_search", { query: "x" });
assert.equal(invalid.isError, true, "a one-character query must be rejected");

const refused = await call("deepsearch_search", { query: "child porn", scopes: ["web", "darkweb"] });
assert.equal(refused.isError, true);
assert.match(text(refused), /Refused by the safety policy/);

const ssrf = await call("deepsearch_fetch_page", { url: "http://127.0.0.1:8080/admin" });
assert.equal(ssrf.isError, true);
assert.match(text(ssrf), /private|local/i);

const onion = await call("deepsearch_fetch_page", { url: `http://${"b".repeat(55)}d.onion/` });
assert.equal(onion.isError, true);
assert.match(text(onion), /Tor/);

await client.close();
console.error("Handshake passed: 4 tools, 1 prompt, 17 sources, locked policy, validation, refusal, SSRF and Tor checks");
