#!/usr/bin/env node
// Summarizes a `wrangler tail --format json` capture of the staging Portal during a load run: outcome per path
// and the most frequent exceptions. Request headers, cookies, query strings and logs are never printed.
import { readFileSync } from "node:fs";

const file = process.argv[2];
// wrangler writes pretty-printed objects back to back, so split on balanced top-level braces (outside strings).
function splitObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try { objects.push(JSON.parse(text.slice(start, index + 1))); } catch { /* partial object at the cut */ }
      }
    }
  }
  return objects;
}
const events = splitObjects(readFileSync(file, "utf8"));
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
