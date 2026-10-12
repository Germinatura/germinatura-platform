// Shared by the cohort upgrade check and the Phase 5 rollback check: the comparison report and the cohort assertions
// (integrity report clean, every scoped row in Turma 2026, every identity a member, Turma 2026 as bootstrapped).
import { psql } from "./local.mjs";
import { BOOTSTRAP_COHORT_ID, compareSnapshots } from "./snapshot.mjs";
import { catalogueProblems, expectedCatalogue } from "./catalogue.mjs";

// ----------------------------------------------------------------------------------------------------- reporting
export function renderComparison(title, result) {
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

export function cohortAssertions(target) {
  const integrity = psql(target, "select check_name || '|' || subject || '|' || violations from private.cohort_integrity_report() order by check_name, subject;")
    .split("\n").filter(Boolean).map((line) => { const [check, subject, violations] = line.split("|"); return { check, subject, violations: Number(violations) }; });
  // Required tables: every row in Turma 2026. Attribution/log tables: NULL (global/not attributed) or Turma 2026.
  const attribution = psql(target, `select t.table_name || '|' || (xpath('/row/n/text()', query_to_xml(format(
      case when t.mode = 'REQUIRED' then 'select count(*) as n from %s where cohort_id is distinct from %L::uuid'
        else 'select count(*) as n from %s where cohort_id is not null and cohort_id <> %L::uuid' end,
      coalesce(to_regclass(format('cohort_data.%I', t.table_name)), to_regclass(format('public.%I', t.table_name))), '${BOOTSTRAP_COHORT_ID}'), false, true, '')))[1]::text
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

/**
 * Before the cohort migrations → after the migrations this check applied (versions after `base`): only the expected
 * cohort columns, rewrites and catalogue rows may differ. The catalogue rows are those of the migrations actually
 * applied (catalogue.mjs), checked by count and by content: each permission exactly once, granted to exactly the
 * expected roles.
 */
export function compareUpgrade(target, before, after, base) {
  if (!/^\d{14}$/.test(String(base))) throw new Error(`compareUpgrade: base inválida (${base})`);
  const applied = psql(target, `select name from supabase_migrations.schema_migrations where version > '${base}' order by version;`).split("\n").filter(Boolean);
  const catalogue = expectedCatalogue(applied);
  const scoped = psql(target, "select table_name from private.cohort_scoped_tables order by 1;").split("\n").filter(Boolean);
  // New columns allowed on pre-existing tables: cohort_id on every classified table, the scope of the flag catalogue and
  // the cohort of PDV handoff codes (PR 3).
  // Table legitimately rewritten: the four global flags get their scope (pre-existing values unchanged).
  const result = compareSnapshots(before, after, {
    expectedNewColumns: { ...Object.fromEntries(scoped.map((name) => [name, ["cohort_id"]])), feature_flags: ["scope"], pdv_handoff_codes: ["cohort_id"] },
    requireSameTuples: true,
    rewrittenTables: ["feature_flags"],
    // Only the catalogue rows of the migrations applied here (cohorts.manage; sales.surcharge.waive → ADMIN with PR D).
    expectedNewRows: catalogue.expectedNewRows,
  });
  const keys = Object.keys(catalogue.permissions);
  const actual = Object.fromEntries(keys.map((key) => [key, { count: 0, roles: [] }]));
  if (keys.length > 0) {
    const list = keys.map((key) => `'${key.replaceAll("'", "''")}'`).join(", ");
    for (const line of psql(target, `select permission.key || '|' || count(distinct permission.id) || '|' || coalesce(string_agg(distinct role.key, ',' order by role.key), '')
        from public.permissions permission left join public.role_permissions grant_row on grant_row.permission_id = permission.id
        left join public.roles role on role.id = grant_row.role_id where permission.key in (${list}) group by permission.key;`).split("\n").filter(Boolean)) {
      const [key, count, roles] = line.split("|");
      actual[key] = { count: Number(count), roles: roles ? roles.split(",") : [] };
    }
  }
  const problems = catalogueProblems(catalogue, actual);
  if (problems.length > 0) {
    result.problems.push(...problems);
    result.ok = false;
  }
  return { scoped, result, catalogue: { applied, ...catalogue, actual } };
}
