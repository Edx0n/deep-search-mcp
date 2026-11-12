#!/usr/bin/env node
/**
 * Deep Search MCP server (stdio).
 * stdout carries the MCP protocol: log only to stderr.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { VERSION } from "./config.js";
import { createRuntime, createServer } from "./server.js";

const runtime = createRuntime();
for (const warning of runtime.warnings) console.error(`[deep-search] warning: ${warning}`);

serveStdio(() => createServer(runtime));

const tor = runtime.config.tor
  ? `Tor via ${runtime.config.tor.host}:${runtime.config.tor.port}, route ${runtime.config.torRoute}`
  : `Tor not configured, route ${runtime.config.torRoute}`;
const disabled = runtime.guard.disabled.length ? `; filters disabled: ${runtime.guard.disabled.join(", ")}` : "";
console.error(`[deep-search] v${VERSION} running on stdio (${tor}${disabled})`);
