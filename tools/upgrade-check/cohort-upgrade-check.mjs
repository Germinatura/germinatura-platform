#!/usr/bin/env node
// Cohort upgrade check (ADR 0011, docs/operations/cohort-cutover-runbook.md). LOCAL/CI ONLY.
//
// Proves what production will go through: the schema before the cohort migrations, populated through the real RPCs,
// is upgraded by the new migrations, and every pre-existing row survives unchanged and attributed to Turma 2026.
//
//   1. reset the local database to the last migration before the cohorts (--base);
//   2. populate it: rich synthetic dataset (sales, payments, cash, stock, procurement, reservations, raffles...) plus
//      the finance/PicPay fixture (opening position, three PicPay sources, reconciliation, manual entries, balance check);
//   3. snapshot (read-only): per table, rows, hash over the pre-existing columns, per-row hashes, tuple versions,
//      plus business totals;
//   4. apply the pending migrations (supabase migration up) and time them;
//   5. snapshot again over the same columns and compare: no table, column, row or value lost or changed, no tuple
//      rewritten, only cohort_id added and only to the cohort-scoped tables;
//   6. cohort assertions: integrity report clean, every scoped row in Turma 2026, every identity a member;
//   7. re-run the re-runnable migrations and compare again (idempotency).
//
// Other modes, for the production runbook (no database access by this tool):
//   --emit-sql [--columns=<before.json>] [--per-row]  prints the read-only snapshot SQL
//   --compare=<before.json>,<after.json> [--live]     compares two snapshots; --live accepts rows added by traffic
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const DAYS = Number(option("days", "8"));
const COHORT_MIGRATIONS_FROM = "20261019090000";

const fail = (message) => refuse("upgrade-check", message);

// ------------------------------------------------------------------------------------------------ offline modes
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
if (option("emit-sql")) {
  const columnsFile = option("columns");
  process.stdout.write(`${snapshotSql({ columns: columnsFile ? columnsOf(readJson(columnsFile)) : null, perRow: Boolean(option("per-row")) })}\n`);
  process.exit(0);
}
if (option("compare")) {
  const [beforePath, afterPath] = String(option("compare")).split(",");
  const before = readJson(beforePath);
  const after = readJson(afterPath);
  const expected = Object.fromEntries(Object.keys(after.tables).filter((name) => after.tables[name].current_columns.includes("cohort_id")
    && !(before.tables[name]?.current_columns ?? []).includes("cohort_id")).map((name) => [name, ["cohort_id"]]));
  const result = compareSnapshots(before, after, { expectedNewColumns: expected, allowNewRows: Boolean(option("live")) });
  console.log(renderComparison("Comparação", result));
  process.exit(result.ok ? 0 : 2);
}

const run = (label, command, args, env = {}) => runStep(root, label, command, args, { env }).ms;
const snapshot = (target, options) => JSON.parse(psql(target, snapshotSql(options)));

// ----------------------------------------------------------------------------------------------------- reporting
function renderComparison(title, result) {
  const lines = [`### ${title}: ${result.ok ? "OK" : "FALHOU"}`, ""];
  if (result.problems.length) lines.push(...result.problems.map((problem) => `- ❌ ${problem}`), "");
  const touched = result.tables.filter((table) => table.added.length || table.rowsBefore || table.rowsAfter);
  lines.push("| Tabela | Linhas antes | Linhas depois | Hash (colunas preexistentes) | Tuplas intactas | Colunas novas |", "|---|---:|---:|:-:|:-:|---|");
  for (const table of touched) {
    lines.push(`| ${table.name} | ${table.rowsBefore} | ${table.rowsAfter} | ${table.hashEqual ? "igual" : "DIFERENTE"} | ${table.tuplesEqual ? "sim" : "não"} | ${table.added.join(", ")} |`);
  }
  lines.push("", `Tabelas sem linhas e sem colunas novas: ${result.tables.length - touched.length}. Tabelas novas: ${result.newTables.join(", ") || "nenhuma"}.`, "");
  lines.push("| Total de domínio | Antes | Depois | Igual |", "|---|---|---|:-:|");
  for (const aggregate of result.aggregates) lines.push(`| ${aggregate.name} | ${aggregate.before ?? "∅"} | ${aggregate.after ?? "∅"} | ${aggregate.equal ? "sim" : "NÃO"} |`);
  return lines.join("\n");
}

function cohortAssertions(target) {
  const integrity = psql(target, "select check_name || '|' || subject || '|' || violations from private.cohort_integrity_report() order by check_name, subject;")
    .split("\n").filter(Boolean).map((line) => { const [check, subject, violations] = line.split("|"); return { check, subject, violations: Number(violations) }; });
  const attribution = psql(target, `select t.table_name || '|' || (xpath('/row/n/text()', query_to_xml(format(
      'select count(*) as n from public.%I where cohort_id is distinct from %L::uuid', t.table_name, '${BOOTSTRAP_COHORT_ID}'), false, true, '')))[1]::text
    from private.cohort_scoped_tables t order by 1;`).split("\n").filter(Boolean).map((line) => { const [table, outside] = line.split("|"); return { table, outside: Number(outside) }; });
  const membership = psql(target, `select (select count(*) from public.profiles) || '|' || (select count(*) from public.user_cohorts where cohort_id = '${BOOTSTRAP_COHORT_ID}' and status = 'ACTIVE');`).split("|").map(Number);
  const cohort = psql(target, `select name || '|' || year || '|' || slug || '|' || status || '|' || is_default from public.cohorts where id = '${BOOTSTRAP_COHORT_ID}';`);
  const problems = [
    ...integrity.filter((row) => row.violations !== 0).map((row) => `integridade ${row.check} ${row.subject}: ${row.violations}`),
    ...attribution.filter((row) => row.outside !== 0).map((row) => `${row.table}: ${row.outside} linhas fora da Turma 2026`),
    ...(membership[0] === membership[1] ? [] : [`perfis ${membership[0]} ≠ vínculos ativos na Turma 2026 ${membership[1]}`]),
    ...(cohort === "Turma 2026|2026|2026|ACTIVE|true" ? [] : [`Turma 2026 inesperada: ${cohort || "ausente"}`]),
  ];
  return { ok: problems.length === 0, problems, integrity, attribution, membership, cohort };
}

// ---------------------------------------------------------------------------------------------------------- main
function main() {
  const target = localTarget(root, "upgrade-check");
  const migrations = readdirSync(join(root, "supabase", "migrations")).filter((name) => name.endsWith(".sql")).sort();
  const pending = migrations.filter((name) => name.slice(0, 14) > BASE);
  if (!pending.some((name) => name.startsWith(COHORT_MIGRATIONS_FROM))) fail(`nenhuma migration de turmas depois de ${BASE}.`);

  run(`Banco local até ${BASE} (supabase db reset --version)`, process.execPath, [join(root, "tools", "run-supabase.mjs"), "db", "reset", "--version", BASE]);
  const applied = psql(target, "select max(version) from supabase_migrations.schema_migrations;");
  if (applied !== BASE) fail(`o reset parou em ${applied}, não em ${BASE}.`);
  run(`Dataset sintético rico (${DAYS} dias)`, process.execPath, [join(root, "tools", "dev-seed", "rich-seed.mjs"), `--days=${DAYS}`], { DEVSEED_UPGRADE_CHECK: "1" });
  console.log("\n▶ Financeiro e evidência PicPay");
  psql(target, readFileSync(join(here, "fixtures", "finance-picpay.sql"), "utf8"));

  console.log("\n▶ Snapshot antes");
  const before = snapshot(target, { perRow: true });

  const migrationMs = run(`Migrations pendentes (${pending.length})`, process.execPath, [join(root, "tools", "run-supabase.mjs"), "migration", "up", "--local"]);

  console.log("\n▶ Snapshot depois");
  const after = snapshot(target, { columns: columnsOf(before), perRow: true });
  const scoped = psql(target, "select table_name from private.cohort_scoped_tables order by 1;").split("\n").filter(Boolean);
  const upgrade = compareSnapshots(before, after, { expectedNewColumns: Object.fromEntries(scoped.map((name) => [name, ["cohort_id"]])), requireSameTuples: true });
  const cohort = cohortAssertions(target);
  // Full snapshot (cohort_id included) as the reference for the re-run.
  const upgraded = snapshot(target, { perRow: true });

  console.log("\n▶ Reexecução das migrations reexecutáveis (idempotência)");
  const rerunnable = pending.filter((name) => name >= `${COHORT_MIGRATIONS_FROM}_` && !name.startsWith(COHORT_MIGRATIONS_FROM));
  for (const name of rerunnable) psql(target, readFileSync(join(root, "supabase", "migrations", name), "utf8"), ["-1"]);
  psql(target, `insert into public.cohorts (id, name, year, slug, status, is_default)
      values ('${BOOTSTRAP_COHORT_ID}', 'Turma 2026', 2026, '2026', 'ACTIVE', true) on conflict (id) do nothing;
    insert into public.user_cohorts (user_id, cohort_id, status, joined_at)
      select profile.id, '${BOOTSTRAP_COHORT_ID}', 'ACTIVE', profile.created_at from public.profiles profile
      on conflict (user_id, cohort_id) do nothing;`, ["-1"]);
  const again = snapshot(target, { columns: columnsOf(upgraded), perRow: true });
  const rerun = compareSnapshots(upgraded, again, { requireSameTuples: true });
  const cohortAgain = cohortAssertions(target);

  const ok = upgrade.ok && cohort.ok && rerun.ok && cohortAgain.ok;
  const lines = [
    `# Teste de upgrade das turmas — ${ok ? "APROVADO" : "REPROVADO"}`, "",
    `- Base: ${BASE} (${before.migrations.length} migrations), dataset: ${DAYS} dias + fixture financeira/PicPay.`,
    `- Migrations aplicadas: ${pending.join(", ")}.`,
    `- Duração de \`supabase migration up\`: ${(migrationMs / 1000).toFixed(1)} s.`,
    `- Tamanho do banco: ${before.database_bytes} → ${after.database_bytes} bytes.`,
    `- Linhas no schema public antes: ${Object.values(before.tables).reduce((sum, table) => sum + table.rows, 0)}.`,
    `- Tabelas por turma: ${scoped.length}; todas as linhas na Turma 2026: ${cohort.attribution.every((row) => row.outside === 0) ? "sim" : "NÃO"}.`,
    `- Perfis/vínculos ativos na Turma 2026: ${cohort.membership.join("/")}.`,
    `- Relatório de integridade: ${cohort.integrity.length} verificações, ${cohort.integrity.filter((row) => row.violations !== 0).length} com violação.`, "",
    ...cohort.problems.map((problem) => `- ❌ ${problem}`),
    renderComparison("Upgrade (antes → depois)", upgrade), "",
    `### Reexecução (${rerunnable.join(", ")} + inserts do bootstrap): ${rerun.ok && cohortAgain.ok ? "OK, nada mudou" : "FALHOU"}`,
    ...rerun.problems.map((problem) => `- ❌ ${problem}`), ...cohortAgain.problems.map((problem) => `- ❌ ${problem}`), "",
  ];
  const report = lines.join("\n");
  const reportPath = option("report");
  if (reportPath) writeFileSync(String(reportPath), report);
  if (option("snapshots")) {
    writeFileSync(join(String(option("snapshots")), "before.json"), JSON.stringify(before));
    writeFileSync(join(String(option("snapshots")), "after.json"), JSON.stringify(after));
  }
  console.log(`\n${report}`);
  if (!ok) process.exit(2);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
