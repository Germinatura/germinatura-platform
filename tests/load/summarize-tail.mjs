#!/usr/bin/env node
// Summarizes a `wrangler tail --format json` capture of a staging Worker during a load run: outcome per path (or
// cron), platform limits, the most frequent exceptions and the session resolution timings the apps log when
// AUTH_TIMING_LOG=1. Request headers, cookies, query strings and log messages are never printed.
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
function percentile(values, rank) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1))];
}
const spread = (values) => ({ p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), max: values.length ? Math.max(...values) : null });

const events = splitObjects(readFileSync(file, "utf8"));
const outcomes = {};
const byPath = {};
const exceptions = {};
const limits = { exceededCpu: 0, exceededMemory: 0, subrequestLimit: 0 };
// Session resolutions: per source and outcome, and how many each HTTP request ran.
const resolutions = {};
const perRequest = {};
// Jobs Worker cycles (jobs.cycle.completed / jobs.cycle.failed); only the counts are reported.
const jobsCycles = { completed: 0, failed: 0 };
for (const event of events) {
  const outcome = event.outcome ?? "unknown";
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  let path = "?";
  try { path = new URL(event.event?.request?.url ?? "").pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ":id"); } catch { /* not an HTTP event */ }
  const key = event.event?.cron !== undefined ? `scheduled ${event.event.cron}` : `${event.event?.request?.method ?? "?"} ${path}`;
  if (outcome === "exceededCpu") limits.exceededCpu += 1;
  if (outcome === "exceededMemory") limits.exceededMemory += 1;
  let count = 0;
  for (const log of event.logs ?? []) {
    const [message] = log.message ?? [];
    if (typeof message !== "string" || !message.startsWith("{")) continue;
    let entry;
    try { entry = JSON.parse(message); } catch { continue; }
    if (entry.event === "jobs.cycle.completed") jobsCycles.completed += 1;
    if (entry.event === "jobs.cycle.failed") jobsCycles.failed += 1;
    if (entry.event !== "auth.session_resolution") continue;
    count += 1;
    const bucket = (resolutions[`${entry.source}/${entry.outcome}`] ??= { count: 0, verifyMs: [], sessionMs: [], totalMs: [] });
    bucket.count += 1;
    for (const field of ["verifyMs", "sessionMs", "totalMs"]) if (typeof entry[field] === "number") bucket[field].push(entry[field]);
  }
  if (event.event?.request) perRequest[count] = (perRequest[count] ?? 0) + 1;
  byPath[key] ??= {};
  const status = event.event?.response?.status ?? "-";
  byPath[key][`${outcome}/${status}`] = (byPath[key][`${outcome}/${status}`] ?? 0) + 1;
  for (const exception of event.exceptions ?? []) {
    const message = `${exception.name ?? "Error"}: ${String(exception.message ?? "").slice(0, 160)}`;
    if (/subrequest/i.test(message)) limits.subrequestLimit += 1;
    exceptions[message] = (exceptions[message] ?? 0) + 1;
  }
}
console.log(JSON.stringify({
  events: events.length,
  outcomes,
  limits,
  jobsCycles,
  sessionResolutions: {
    perRequest,
    bySourceAndOutcome: Object.fromEntries(Object.entries(resolutions).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, bucket]) => [key, { count: bucket.count, verifyMs: spread(bucket.verifyMs), sessionMs: spread(bucket.sessionMs), totalMs: spread(bucket.totalMs) }])),
  },
  paths: Object.fromEntries(Object.entries(byPath).sort(([left], [right]) => left.localeCompare(right))),
  topExceptions: Object.entries(exceptions).sort(([, left], [, right]) => right - left).slice(0, 10),
}, null, 2));
