#!/usr/bin/env node
// Staging stability harness. Usage (inside the load-staging workflow, which provides the environment):
//   node tests/load/run.mjs --scenarios=A,B,C,D [--minutes-a=10] [--minutes-d=30] [--rate-d=8]
// Refuses anything but the staging hosts (lib/guard.mjs). Creates isolated run fixtures first, retires them last.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualUser } from "./lib/client.mjs";
import { stagingTarget } from "./lib/guard.mjs";
import { stagingSql } from "./lib/staging-sql.mjs";
import { browsing, contention, loginLog, operating, soak } from "./scenarios.mjs";

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
  // Direct Supabase Auth check for a refused login: tells a rate limit from a credential or profile problem.
  const emails = new Map([...fixtures.consumers, ...fixtures.sellers, fixtures.admin].map((person) => [person.username, person.email]));
  const diagnose = async (username) => target.publishableKey ? fetch(`${target.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: target.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: emails.get(username), password }),
  }).then(async (response) => ({ status: response.status, code: (await response.json().catch(() => ({}))).error_code ?? null })).catch(() => ({ status: 0 })) : null;
  const context = { target, fixtures, password, sql, run, diagnose };
  const results = { run, startedAt: new Date().toISOString(), stagingVersion: sha ?? null, scenarios: {} };
  const save = () => writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));

  try {
    await preflight(target, fixtures, password, sql);
    // Preflight only: hold long enough for the per-minute Jobs cron to run under the tail, then report the outbox.
    if (!scenarios.some((name) => ["A", "B", "C", "D"].includes(name))) {
      await outboxSnapshot(sql, "antes");
      await new Promise((resolve) => setTimeout(resolve, 150_000));
      await outboxSnapshot(sql, "depois de 150 s");
    }
    if (scenarios.includes("A")) { console.log("A — 50 consumidores navegando…"); results.scenarios.A = await browsing({ ...context, minutes: Number(option("minutes-a", 10)) }); save(); }
    if (scenarios.includes("B")) { console.log("B — 15 vendedores no PDV…"); results.scenarios.B = await operating({ ...context, minutes: Number(option("minutes-b", 10)) }); save(); }
    if (scenarios.includes("C")) { console.log("C — concorrência controlada…"); results.scenarios.C = await contention(context); save(); }
    if (scenarios.includes("D")) { console.log("D — soak…"); results.scenarios.D = await soak({ ...context, minutes: Number(option("minutes-d", 30)), rate: Number(option("rate-d", 0)) || null }); save(); }
    results.logins = summarizeLogins();
    results.finalInvariants = (await sql(`select check_name, violations from loadtest.check('${run}')`)).map((row) => ({ check: row.check_name, violations: Number(row.violations) }));
  } finally {
    results.retired = await sql(`select loadtest.retire('${run}') as retired`).then(([row]) => row?.retired ?? null).catch((error) => ({ error: error.message }));
    results.finishedAt = new Date().toISOString();
    save();
  }
  console.log(JSON.stringify({ logins: { ...results.logins, timeline: undefined }, ...digest(results) }, null, 2));
  const violations = (results.finalInvariants ?? []).reduce((sum, row) => sum + row.violations, 0);
  if (violations > 0) process.exit(2);
}

// One user before the load: Supabase Auth directly, then the Portal login, with only statuses and error codes.
async function preflight(target, fixtures, password, sql) {
  const consumer = fixtures.consumers[0];
  const [profile] = await sql(`select profile.active, profile.onboarding_completed_at is not null as onboarded, profile.username,
    users.email_confirmed_at is not null as confirmed, left(users.encrypted_password, 4) as hash_prefix,
    (select count(*) from auth.identities identity where identity.user_id = users.id)::int as identities
    from public.profiles profile join auth.users users on users.id = profile.id where profile.id = '${consumer.id}'`);
  const auth = target.publishableKey ? await fetch(`${target.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: target.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: consumer.email, password }),
  }).then(async (response) => ({ status: response.status, code: (await response.json().catch(() => ({}))).error_code ?? null })) : null;
  const portal = await fetch(`${target.portal}/api/auth/login`, {
    method: "POST", headers: { Origin: target.portal, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: consumer.username, password }),
  }).then(async (response) => ({ status: response.status, code: (await response.json().catch(() => ({}))).code ?? null }));
  console.log(`Preflight: perfil ${JSON.stringify(profile)}; Auth ${JSON.stringify(auth)}; Portal ${JSON.stringify(portal)}`);
  if (portal.status !== 200) throw new Error("Preflight: o login de carga falhou; veja os códigos acima.");
  await adminPreflight(target, fixtures.admin, password);
}

// Outbox state, counts and ages only: whether the Jobs Worker is draining events.
async function outboxSnapshot(sql, label) {
  const [row] = await sql(`select count(*) filter (where status = 'PENDING')::int as pending,
    count(*) filter (where status = 'PROCESSING')::int as processing, count(*) filter (where status = 'FAILED')::int as failed,
    coalesce(extract(epoch from now() - min(created_at) filter (where status = 'PENDING')), 0)::int as oldest_pending_seconds,
    coalesce(extract(epoch from now() - max(published_at)), -1)::int as last_published_seconds_ago
    from public.outbox_events`).catch(() => [null]);
  console.log(`Outbox (${label}): ${JSON.stringify(row ?? { error: true })}`);
}

// The run's administrator signs in and opens the finance screens and their APIs; only statuses are printed.
async function adminPreflight(target, admin, password) {
  const user = new VirtualUser(target.portal, null);
  const login = await user.request("auth.login", "POST", "/api/auth/login", { body: { identifier: admin.username, password } });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const checks = { login: login.status };
  for (const [label, path] of [
    ["tela extrato", "/admin/financeiro/extrato"],
    ["tela extrato PicPay", "/admin/financeiro/importar-extrato"],
    ["tela indicadores", "/admin/financeiro/indicadores"],
    ["API extrato", `/api/v1/admin/finance/statement?from=${today}&to=${today}`],
    ["API lançamentos", `/api/v1/admin/finance/entries?from=${today}&to=${today}`],
    ["API importações PicPay", "/api/v1/admin/finance/statement-imports"],
    ["API indicadores", `/api/v1/admin/finance/indicators?from=${today}&to=${today}`],
  ]) {
    if (login.status !== 200) break;
    checks[label] = (await user.request(`preflight ${label}`, "GET", path)).status;
  }
  console.log(`Preflight administrativo: ${JSON.stringify(checks)}`);
  if (Object.values(checks).some((status) => status !== 200)) {
    throw new Error("Preflight: o administrador de carga não abriu o financeiro; veja os códigos acima.");
  }
}

function summarizeLogins() {
  const attempts = loginLog.attempts;
  const refused = attempts.filter((attempt) => attempt.status !== 200);
  return { attempts: attempts.length, succeeded: attempts.length - refused.length, refused: refused.length,
    refusedStatuses: refused.reduce((counts, attempt) => ({ ...counts, [`${attempt.status}:${attempt.code}`]: (counts[`${attempt.status}:${attempt.code}`] ?? 0) + 1 }), {}),
    firstRefusalAfter: refused.length ? attempts.findIndex((attempt) => attempt.status !== 200) : null,
    diagnostics: loginLog.diagnostics, timeline: attempts };
}

// Compact view for the job log: per route counts and percentiles, per case outcome.
function digest(results) {
  return Object.fromEntries(Object.entries(results.scenarios).map(([name, scenario]) => [name, {
    durationSeconds: scenario.durationSeconds,
    routes: scenario.routes.map((route) => `${route.label}: ${route.requests} req, ok ${route.ok}, 4xx esperado ${route.expected4xx}, 4xx ${route.unexpected4xx}, 5xx ${route.server5xx}, rede ${route.network}, p50 ${route.p50} p95 ${route.p95} p99 ${route.p99} ms, ${route.throughputPerSecond}/s`),
    failures: scenario.routes.filter((route) => route.samples?.length).map((route) => ({ route: route.label, samples: route.samples })),
    ...(scenario.cases ? { cases: scenario.cases.map((item) => `${item.name}: ${item.successes} sucesso(s) de ${item.attempts} (${item.expectation}); violações ${item.invariants.reduce((sum, row) => sum + row.violations, 0)}${item.redemptions !== undefined ? `; resgates ${item.redemptions} de ${item.reservations} reservas` : ""}`) } : {}),
    ...(scenario.throughput ? { throughput: scenario.throughput } : {}),
    ...(scenario.trends ? { trends: scenario.trends, outbox: scenario.outbox } : {}),
  }]));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
