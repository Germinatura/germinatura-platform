#!/usr/bin/env node
// Staging stability harness. Usage (inside the load-staging workflow, which provides the environment):
//   node tests/load/run.mjs --scenarios=A,B,C,D [--minutes-a=10] [--minutes-d=30]
// Refuses anything but the staging hosts (lib/guard.mjs). Creates isolated run fixtures first, retires them last.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stagingTarget } from "./lib/guard.mjs";
import { stagingSql } from "./lib/staging-sql.mjs";
import { browsing, contention, operating, soak } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

async function main() {
  const target = stagingTarget();
  const sql = stagingSql(target);
  const scenarios = option("scenarios", "A,B,C,D").split(",").map((value) => value.trim().toUpperCase());
  const run = `r${new Date().toISOString().replace(/\D/g, "").slice(2, 12)}`;
  // Throwaway password for the run's synthetic accounts; kept in memory only and never printed.
  const password = `Carga-${randomBytes(12).toString("base64url")}9!`;
  const output = join(here, "results", run);
  mkdirSync(output, { recursive: true });

  const health = await Promise.all([target.portal, target.pdv].map(async (origin) => (await fetch(`${origin}/api/v1/health`)).status));
  if (health.some((status) => status !== 200)) throw new Error(`Staging indisponível antes da carga: ${health.join(", ")}`);
  // The workflow checks out the develop commit that Deploy Staging published and passes its SHA.
  const sha = process.env.LOAD_SHA ?? null;

  console.log(`Execução ${run}: preparando dados isolados…`);
  await sql(readFileSync(join(here, "fixtures.sql"), "utf8"));
  const [{ prepare: fixtures }] = await sql(`select loadtest.prepare('${run}', '${password.replaceAll("'", "''")}', 15, 70) as prepare`);
  const context = { target, fixtures, password, sql, run };
  const results = { run, startedAt: new Date().toISOString(), stagingVersion: sha ?? null, scenarios: {} };
  const save = () => writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));

  try {
    if (scenarios.includes("A")) { console.log("A — 50 consumidores navegando…"); results.scenarios.A = await browsing({ ...context, minutes: Number(option("minutes-a", 10)) }); save(); }
    if (scenarios.includes("B")) { console.log("B — 15 vendedores no PDV…"); results.scenarios.B = await operating({ ...context, minutes: Number(option("minutes-b", 10)) }); save(); }
    if (scenarios.includes("C")) { console.log("C — concorrência controlada…"); results.scenarios.C = await contention(context); save(); }
    if (scenarios.includes("D")) { console.log("D — soak…"); results.scenarios.D = await soak({ ...context, minutes: Number(option("minutes-d", 30)) }); save(); }
    results.finalInvariants = (await sql(`select check_name, violations from loadtest.check('${run}')`)).map((row) => ({ check: row.check_name, violations: Number(row.violations) }));
  } finally {
    results.retired = await sql(`select loadtest.retire('${run}') as retired`).then(([row]) => row?.retired ?? null).catch((error) => ({ error: error.message }));
    results.finishedAt = new Date().toISOString();
    save();
  }
  console.log(JSON.stringify(digest(results), null, 2));
  const violations = (results.finalInvariants ?? []).reduce((sum, row) => sum + row.violations, 0);
  if (violations > 0) process.exit(2);
}

// Compact view for the job log: per route counts and percentiles, per case outcome.
function digest(results) {
  return Object.fromEntries(Object.entries(results.scenarios).map(([name, scenario]) => [name, {
    durationSeconds: scenario.durationSeconds,
    routes: scenario.routes.map((route) => `${route.label}: ${route.requests} req, ok ${route.ok}, 4xx esperado ${route.expected4xx}, 4xx ${route.unexpected4xx}, 5xx ${route.server5xx}, rede ${route.network}, p50 ${route.p50} p95 ${route.p95} p99 ${route.p99} ms, ${route.throughputPerSecond}/s`),
    ...(scenario.cases ? { cases: scenario.cases.map((item) => `${item.name}: ${item.successes} sucesso(s) de ${item.attempts} (${item.expectation}); violações ${item.invariants.reduce((sum, row) => sum + row.violations, 0)}`) } : {}),
    ...(scenario.trends ? { trends: scenario.trends, outbox: scenario.outbox } : {}),
  }]));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
