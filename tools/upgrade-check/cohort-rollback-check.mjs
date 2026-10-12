#!/usr/bin/env node
// Phase 5 rollback check (ADR 0011, docs/operations/cohort-cutover-runbook.md, "Fase 5 — reversão"). LOCAL/CI ONLY.
//
// Proves the rollback artifact supabase/rollback/20261023090000_cohort_explicit_context.rollback.sql on the path
// production would take:
//   1. reference: the PR 4 definitions, from a database reset to 20261022090000;
//   2. the schema before the cohorts (--base), populated through the real RPCs (same dataset as the upgrade check);
//   3. the 9 cohort migrations, up to 20261023090000 and no further; final state validated (no loss, integrity, Phase 5);
//   4. the rollback; every reverted function, policy and trigger identical to PR 4 (list_my_share_links keeps its fix);
//   5. compatibility with the application without cohort context: system, worker and ADMIN_MASTER without a cohort
//      operate in the default cohort again (they fail under Phase 5), probes run in transactions that roll back;
//   6. zero loss: every row, value and tuple identical to the state right after the 9 migrations;
//   7. the rollback applied again changes nothing (idempotent), and it refuses a database with a later migration;
//   8. Phase 5 reapplied from its own migration file: definitions and behavior identical to step 3, data unchanged.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cohortAssertions, compareUpgrade, renderComparison } from "./cohort-checks.mjs";
import { fail as refuse, localTarget, psql, run as runStep } from "./local.mjs";
import { BOOTSTRAP_COHORT_ID, columnsOf, compareSnapshots, snapshotSql } from "./snapshot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const option = (name, fallback = null) => {
  const found = process.argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!found) return fallback;
  return found.includes("=") ? found.slice(found.indexOf("=") + 1) : true;
};
const BASE = String(option("base", "20261018090000"));
const PR4 = "20261022090000";
const PHASE5 = "20261023090000";
const ROLLBACK = join(root, "supabase", "rollback", `${PHASE5}_cohort_explicit_context.rollback.sql`);
const fail = (message) => refuse("rollback-check", message);
const run = (label, command, args, env = {}) => runStep(root, label, command, args, { env }).ms;
const snapshot = (target, options) => JSON.parse(psql(target, snapshotSql(options)));

// Everything Phase 5 touched. Reverted: back to PR 4. Added: absent after the rollback. Kept: list_my_share_links.
const REVERTED = ["private.cohort_fallback_enabled", "private.cohort_scope", "private.cohort_readable", "private.guard_cohort_write",
  "private.assign_log_cohort", "private.join_default_cohort", "public.handle_new_auth_user", "public.record_share_visit", "public.set_user_access"];
const ADDED = ["private.guard_default_cohort", "public.set_default_cohort", "public.resolve_public_cohort",
  "public.close_seller_shift_on_behalf", "public.storage_entity_in_scope"];
const KEPT = ["public.list_my_share_links"];
const POLICIES = ["catalog_images_admin_insert", "catalog_images_admin_delete", "event_covers_communications_insert", "stock_loss_photos_read"];

/** Definition fingerprints (line endings normalized: a Windows checkout applies CRLF bodies), privileges included. */
function definitions(target) {
  const functions = [...REVERTED, ...ADDED, ...KEPT].map((name) => `'${name}'`).join(", ");
  return JSON.parse(psql(target, `select jsonb_build_object(
    'functions', (select coalesce(jsonb_object_agg(name, (select md5(regexp_replace(pg_get_functiondef(p.oid), E'\\r', '', 'g') || coalesce(p.proacl::text, ''))
        from pg_proc p where p.pronamespace = split_part(name, '.', 1)::regnamespace and p.proname = split_part(name, '.', 2))), '{}')
      from unnest(array[${functions}]) name),
    'policies', (select jsonb_object_agg(policyname, md5(coalesce(qual, '') || '|' || coalesce(with_check, ''))) from pg_policies
      where schemaname = 'storage' and policyname in (${POLICIES.map((name) => `'${name}'`).join(", ")})),
    'triggers', (select coalesce(jsonb_agg(tgname order by tgname), '[]') from pg_trigger where tgrelid = 'public.cohorts'::regclass and not tgisinternal),
    'fallback', private.cohort_fallback_enabled())::text;`));
}

// Request contexts, as PostgREST and the workers set them. The probes never commit.
const settings = (values) => `select ${Object.entries(values).map(([key, value]) => `set_config('${key}', '${value}', true)`).join(", ")};`;
const contexts = {
  system: settings({ role: "postgres", "request.jwt.claim.sub": "", "request.jwt.claim.role": "", "request.headers": "", "germinatura.system_cohort": "", "germinatura.cohort_scope": "" }),
  service: settings({ role: "postgres", "request.jwt.claim.sub": "", "request.jwt.claim.role": "service_role", "request.headers": "{}", "germinatura.system_cohort": "", "germinatura.cohort_scope": "" }),
  user: (id) => settings({ "request.jwt.claim.sub": id, "request.jwt.claim.role": "authenticated", "request.headers": "{}", "germinatura.cohort_scope": "", role: "authenticated" }),
  // A visitor's claims; the scope function itself runs as its owner (anon has no access to the private schema).
  visitor: settings({ role: "postgres", "request.jwt.claim.sub": "", "request.jwt.claim.role": "anon", "request.headers": "{}", "germinatura.cohort_scope": "" }),
};
function probe(target, context, statements) {
  const result = psql(target, `begin;\n${context}\n${statements}\nrollback;\n`, [], { allowFailure: true });
  if (result.status !== 0) return `erro ${(result.stderr.match(/ERROR:\s+([^\n]+)/) ?? [])[1] ?? result.stderr.trim()}`;
  return result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
}

/** What the application without cohort context does (the version before the multi-cohort Portal/PDV and its workers). */
function compatibility(target, people) {
  const signUp = "5e000000-0000-4000-8000-00000000ab01";
  return {
    "sistema sem turma grava linha por turma": probe(target, contexts.system,
      `insert into public.categories (name, slug, active, sort_order) values ('Sonda rollback', 'sonda-rollback-sys', true, 1);
       select cohort_id from cohort_data.categories where slug = 'sonda-rollback-sys';`),
    "worker (service role) sem turma grava linha por turma": probe(target, contexts.service,
      `insert into public.categories (name, slug, active, sort_order) values ('Sonda rollback', 'sonda-rollback-srv', true, 1);
       select cohort_id from cohort_data.categories where slug = 'sonda-rollback-srv';`),
    "worker sem turma grava evento de outbox": probe(target, contexts.service,
      `insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload) values ('sonda.rollback', 'tipo_sonda', 'x', '{}');
       select coalesce(cohort_id::text, 'global') from cohort_data.outbox_events where topic = 'sonda.rollback';`),
    "ADMIN_MASTER sem turma: sessão": probe(target, contexts.user(people.master),
      `select (public.get_my_session() ->> 'cohort_mode') || ':' || coalesce(public.get_my_session() -> 'cohort' ->> 'id', '-');`),
    "ADMIN_MASTER sem turma grava (link de divulgação)": probe(target, contexts.user(people.master),
      `select public.create_share_campaign('Sonda rollback', 'OUTRO', array[]::uuid[], 'sonda-rollback-master', gen_random_uuid()) is not null;
       reset role;
       select cohort_id from cohort_data.share_campaigns where title = 'Sonda rollback';`),
    "vendedor de uma turma sem header: sessão": probe(target, contexts.user(people.seller),
      `select (public.get_my_session() ->> 'cohort_mode') || ':' || coalesce(public.get_my_session() -> 'cohort' ->> 'id', '-');`),
    "visitante: escopo": probe(target, contexts.visitor, "select private.cohort_scope()::text;"),
    "cadastro novo: vínculo e papel": probe(target, contexts.system,
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ('00000000-0000-0000-0000-000000000000', '${signUp}', 'authenticated', 'authenticated', 'sonda.rollback@institutojef.org.br',
           extensions.crypt('Sonda123!', extensions.gen_salt('bf')), now(), '{}', '{"name":"Sonda Rollback","username":"sonda.rollback"}', now(), now());
       select (select string_agg(cohort_id::text, ',') from public.user_cohorts where user_id = '${signUp}') || '/'
         || (select string_agg(role.key || '@' || coalesce(user_role.cohort_id::text, '-'), ',') from cohort_data.user_roles user_role
           join public.roles role on role.id = user_role.role_id where user_role.user_id = '${signUp}');`),
  };
}
const A = BOOTSTRAP_COHORT_ID;
// Under Phase 5 nothing falls into a cohort by absence of context; after the rollback the PR 4 fallback is back.
const EXPECTED_PHASE5 = {
  "sistema sem turma grava linha por turma": /^erro COHORT_REQUIRED/,
  "worker (service role) sem turma grava linha por turma": /^erro COHORT_REQUIRED/,
  "worker sem turma grava evento de outbox": /^erro COHORT_REQUIRED/,
  "ADMIN_MASTER sem turma: sessão": /^NONE:-$/,
  "ADMIN_MASTER sem turma grava (link de divulgação)": /^erro /,
  "vendedor de uma turma sem header: sessão": new RegExp(`^COHORT:${A}$`),
  "visitante: escopo": new RegExp(`^\\{${A}\\}$`),
  "cadastro novo: vínculo e papel": new RegExp(`^${A}/CONSUMIDOR@${A}$`),
};
const EXPECTED_ROLLBACK = {
  ...EXPECTED_PHASE5,
  "sistema sem turma grava linha por turma": new RegExp(`^${A}$`),
  "worker (service role) sem turma grava linha por turma": new RegExp(`^${A}$`),
  "worker sem turma grava evento de outbox": new RegExp(`^(${A}|global)$`),
  "ADMIN_MASTER sem turma: sessão": new RegExp(`^COHORT:${A}$`),
  "ADMIN_MASTER sem turma grava (link de divulgação)": new RegExp(`^${A}$`),
};
const check = (observed, expected) => Object.entries(expected).filter(([name, pattern]) => !pattern.test(observed[name] ?? "")).map(([name]) => `${name}: ${observed[name]}`);

function compareDefinitions(actual, reference, label) {
  const problems = [];
  for (const name of REVERTED) if (actual.functions[name] !== reference.pr4.functions[name]) problems.push(`${label}: ${name} difere do PR 4`);
  for (const name of KEPT) if (actual.functions[name] !== reference.phase5.functions[name]) problems.push(`${label}: ${name} difere da Fase 5`);
  for (const name of ADDED) if (actual.functions[name] !== null && actual.functions[name] !== undefined) problems.push(`${label}: ${name} ainda existe`);
  if (JSON.stringify(actual.policies) !== JSON.stringify(reference.pr4.policies)) problems.push(`${label}: políticas de Storage diferem do PR 4`);
  if (JSON.stringify(actual.triggers) !== JSON.stringify(reference.pr4.triggers)) problems.push(`${label}: triggers de cohorts diferem do PR 4`);
  if (actual.fallback !== true) problems.push(`${label}: fallback desligado`);
  return problems;
}

function main() {
  const target = localTarget(root, "rollback-check");
  const migrations = readdirSync(join(root, "supabase", "migrations")).filter((name) => name.endsWith(".sql")).sort();
  const cohortMigrations = migrations.filter((name) => name.slice(0, 14) > BASE && name.slice(0, 14) <= PHASE5);
  if (cohortMigrations.length !== 9 || !cohortMigrations.at(-1).startsWith(PHASE5)) fail(`esperadas as 9 migrations de turma até ${PHASE5}.`);

  run(`Referência: banco local até ${PR4} (PR 4)`, process.execPath, [join(root, "tools", "run-supabase.mjs"), "db", "reset", "--version", PR4]);
  const pr4 = definitions(target);

  run(`Banco local até ${BASE} (antes das turmas)`, process.execPath, [join(root, "tools", "run-supabase.mjs"), "db", "reset", "--version", BASE]);
  if (psql(target, "select max(version) from supabase_migrations.schema_migrations;") !== BASE) fail(`o reset não parou em ${BASE}.`);
  run("Dataset sintético rico (8 dias)", process.execPath, [join(root, "tools", "dev-seed", "rich-seed.mjs"), "--days=8"], { DEVSEED_UPGRADE_CHECK: "1" });
  console.log("\n▶ Financeiro e evidência PicPay");
  psql(target, readFileSync(join(here, "fixtures", "finance-picpay.sql"), "utf8"));
  console.log("\n▶ Snapshot antes das 9 migrations");
  const before = snapshot(target, { perRow: true });

  // Exactly the 9 cohort migrations, each in its own transaction and recorded like the CLI does; never a later one.
  for (const name of cohortMigrations) {
    console.log(`▶ Migration ${name}`);
    psql(target, readFileSync(join(root, "supabase", "migrations", name), "utf8"), ["-1"]);
    psql(target, `insert into supabase_migrations.schema_migrations (version, name) values ('${name.slice(0, 14)}', '${name.slice(15, -4)}');`);
  }
  // Production has its bootstrap administrator as ADMIN_MASTER; the synthetic dataset never completes the bootstrap, so
  // its ADMIN takes that place (a new table, outside the pre-existing data the snapshots compare).
  psql(target, `insert into public.admin_masters (user_id, reason, correlation_id)
    select user_role.user_id, 'Teste de reversão: administrador do bootstrap', gen_random_uuid() from cohort_data.user_roles user_role
    join public.roles role on role.id = user_role.role_id where role.key = 'ADMIN' and not exists (select 1 from public.admin_masters)
    order by user_role.user_id limit 1;`);
  const people = {
    master: psql(target, "select user_id from public.admin_masters order by created_at, user_id limit 1;"),
    seller: psql(target, `select user_role.user_id from cohort_data.user_roles user_role join public.roles role on role.id = user_role.role_id
      where role.key = 'VENDEDOR' and user_role.user_id not in (select user_id from public.admin_masters) order by 1 limit 1;`),
  };
  if (!people.master || !people.seller) fail("dataset sem ADMIN_MASTER ou vendedor.");

  console.log("\n▶ Estado final das 9 migrations");
  const after = snapshot(target, { columns: columnsOf(before), perRow: true });
  const { result: upgrade } = compareUpgrade(target, before, after);
  const cohort9 = cohortAssertions(target);
  const phase5 = definitions(target);
  const reference = { pr4, phase5 };
  const probes9 = compatibility(target, people);
  const phase5Problems = [
    ...(phase5.fallback === false ? [] : ["Fase 5: fallback ligado"]),
    ...ADDED.filter((name) => !phase5.functions[name]).map((name) => `Fase 5: ${name} ausente`),
    ...check(probes9, EXPECTED_PHASE5).map((problem) => `Fase 5: ${problem}`),
  ];
  const upgraded = snapshot(target, { perRow: true });

  // Fail-closed: with any migration after Phase 5 the artifact refuses to run (it would restore stale bodies).
  console.log("\n▶ Reversão recusada com uma migration posterior à Fase 5");
  const later = psql(target, `begin;\ninsert into supabase_migrations.schema_migrations (version, name) values ('29991231000000', 'later');\n${readFileSync(ROLLBACK, "utf8")}\nrollback;\n`,
    [], { allowFailure: true });
  const refusedLater = later.status !== 0 && /COHORT_ROLLBACK_PRECHECK: the latest applied migration is 29991231000000/.test(later.stderr)
    && JSON.stringify(definitions(target)) === JSON.stringify(phase5);

  console.log("\n▶ Reversão da Fase 5");
  psql(target, readFileSync(ROLLBACK, "utf8"), ["-1"]);
  const reverted = definitions(target);
  const probesRollback = compatibility(target, people);
  const afterRollback = snapshot(target, { columns: columnsOf(upgraded), perRow: true });
  const rollbackData = compareSnapshots(upgraded, afterRollback, { requireSameTuples: true });
  const cohortRollback = cohortAssertions(target);
  const rollbackProblems = [...compareDefinitions(reverted, reference, "reversão"), ...check(probesRollback, EXPECTED_ROLLBACK).map((problem) => `reversão: ${problem}`)];

  console.log("\n▶ Reversão aplicada de novo (idempotência)");
  psql(target, readFileSync(ROLLBACK, "utf8"), ["-1"]);
  const revertedAgain = definitions(target);
  const againData = compareSnapshots(upgraded, snapshot(target, { columns: columnsOf(upgraded), perRow: true }), { requireSameTuples: true });
  const idempotentProblems = JSON.stringify(revertedAgain) === JSON.stringify(reverted) ? [] : ["segunda reversão mudou definições"];

  console.log("\n▶ Fase 5 reaplicada pela própria migration");
  psql(target, readFileSync(join(root, "supabase", "migrations", cohortMigrations.at(-1)), "utf8"), ["-1"]);
  const reapplied = definitions(target);
  const probesReapplied = compatibility(target, people);
  const reapplyData = compareSnapshots(upgraded, snapshot(target, { columns: columnsOf(upgraded), perRow: true }), { requireSameTuples: true });
  const cohortReapplied = cohortAssertions(target);
  const reapplyProblems = [
    ...(JSON.stringify(reapplied) === JSON.stringify(phase5) ? [] : ["definições diferem da Fase 5 original"]),
    ...check(probesReapplied, EXPECTED_PHASE5),
  ].map((problem) => `reaplicação: ${problem}`);

  const problems = [...(refusedLater ? [] : ["a reversão não recusou um banco com migration posterior à Fase 5"]), ...phase5Problems, ...rollbackProblems, ...idempotentProblems, ...reapplyProblems,
    ...cohort9.problems, ...cohortRollback.problems, ...cohortReapplied.problems];
  const ok = upgrade.ok && rollbackData.ok && againData.ok && reapplyData.ok && problems.length === 0;
  const table = (observed) => Object.entries(observed).map(([name, value]) => `| ${name} | \`${probes9[name]}\` | \`${value}\` |`);
  const report = [
    `# Teste de reversão da Fase 5 — ${ok ? "APROVADO" : "REPROVADO"}`, "",
    `- Base: ${BASE}; dataset de 8 dias + fixture financeira/PicPay; migrations aplicadas: ${cohortMigrations.length} (até ${PHASE5}).`,
    `- Funções revertidas ao PR 4: ${REVERTED.length}; removidas: ${ADDED.length}; mantida: ${KEPT.join(", ")}; políticas de Storage: ${POLICIES.length}.`,
    `- Pessoas das sondas: ADMIN_MASTER ${people.master}, vendedor ${people.seller}.`, "",
    ...problems.map((problem) => `- ❌ ${problem}`), "",
    "| Sonda (app sem contexto de turma) | Fase 5 | Depois da reversão |", "|---|---|---|", ...table(probesRollback), "",
    renderComparison("Antes das turmas → 9 migrations", upgrade), "",
    renderComparison("9 migrations → reversão (dados)", rollbackData), "",
    `### Recusa com migration posterior à Fase 5: ${refusedLater ? "OK, nada mudou" : "FALHOU"}`,
    `### Reversão aplicada de novo: ${againData.ok && idempotentProblems.length === 0 ? "OK, nada mudou" : "FALHOU"}`,
    `### Fase 5 reaplicada: ${reapplyData.ok && reapplyProblems.length === 0 ? "OK, definições e comportamento iguais aos originais, dados intactos" : "FALHOU"}`, "",
  ].join("\n");
  const reportPath = option("report");
  if (reportPath) writeFileSync(String(reportPath), report);
  console.log(`\n${report}`);
  if (!ok) process.exit(2);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
