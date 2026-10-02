#!/usr/bin/env node
// Summarizes a `wrangler tail --format json` capture of the staging Portal during a load run: outcome per path
// and the most frequent exceptions. Request headers, cookies, query strings and logs are never printed.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const events = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const outcomes = {};
const byPath = {};
const exceptions = {};
for (const event of events) {
  const outcome = event.outcome ?? "unknown";
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  let path = "?";
  try { path = new URL(event.event?.request?.url ?? "").pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ":id"); } catch { /* not an HTTP event */ }
  const key = `${event.event?.request?.method ?? "?"} ${path}`;
  byPath[key] ??= {};
  const status = event.event?.response?.status ?? "-";
  byPath[key][`${outcome}/${status}`] = (byPath[key][`${outcome}/${status}`] ?? 0) + 1;
  for (const exception of event.exceptions ?? []) {
    const message = `${exception.name ?? "Error"}: ${String(exception.message ?? "").slice(0, 160)}`;
    exceptions[message] = (exceptions[message] ?? 0) + 1;
  }
}
console.log(JSON.stringify({
  events: events.length,
  outcomes,
  paths: Object.fromEntries(Object.entries(byPath).sort(([left], [right]) => left.localeCompare(right))),
  topExceptions: Object.entries(exceptions).sort(([, left], [, right]) => right - left).slice(0, 10),
}, null, 2));
