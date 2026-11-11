/**
 * Live check: runs every source once against the real services and prints status, counts and timing.
 * Usage: npm run live -- [query] [sourceId,sourceId...]
 * Not part of `npm test` (it depends on the network and on third-party rate limits).
 */
import { runSearch } from "../src/search.js";
import { createRuntime } from "../src/server.js";
import { SOURCES } from "../src/sources/registry.js";
import type { SourceId } from "../src/types.js";

const query = process.argv[2] ?? "privacy";
const only = process.argv[3]?.split(",") as SourceId[] | undefined;
const rt = createRuntime();
for (const w of rt.warnings) console.error(`warning: ${w}`);

const ids = (only ?? SOURCES.map(s => s.id)) as SourceId[];
const started = Date.now();
const outcome = await runSearch({ query, sources: ids, limit_per_source: 3, offset: 0 }, rt);

let failures = 0;
for (const report of outcome.sources) {
  const first = outcome.results.find(r => r.source === report.id);
  const status = report.status.padEnd(8);
  const detail =
    report.status === "ok"
      ? `${report.count} shown / total ${report.total ?? "?"} / hidden ${report.hidden} — ${first ? first.title.slice(0, 70) : "(none)"}`
      : (report.error ?? report.note ?? "");
  if (report.status === "error") failures++;
  console.log(`${report.id.padEnd(18)} ${status} ${String(report.ms ?? "-").padStart(6)}ms  ${detail}`);
}
console.log(
  `\nquery="${query}" · ${outcome.results.length} results · hidden ${outcome.safety.hidden} ${JSON.stringify(outcome.safety.by_reason)} · banned list loaded: ${outcome.safety.banned_list_loaded} · ${Date.now() - started}ms · ${failures} source error(s)`
);
