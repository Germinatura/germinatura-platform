// Read-only preservation snapshot of the physical tables (public, and cohort_data once it exists), used by the upgrade check (CI/local) and by the cutover
// runbook (production, SQL editor or psql). The SQL is a single SELECT: it reads the catalogue, runs one counting
// query per table through query_to_xml and returns one JSON document. It never writes.
//
// Hashes cover only the columns listed in `columns` (the columns that existed before the migration), so adding a
// column such as cohort_id never changes them; any change to a pre-existing value does.

export const BOOTSTRAP_COHORT_ID = "c0000000-0000-4000-8000-000000002026";

// Business totals read by humans in the report; compared exactly when no writes may have happened in between.
export const AGGREGATES = [
  ["sales_by_status", "select string_agg(status || '=' || n || '/' || total, ',' order by status) from (select status::text, count(*) n, sum(total_cents) total from public.sales group by 1) s"],
  ["sale_items", "select count(*) || '/' || coalesce(sum(quantity), 0) || '/' || coalesce(sum(total_cents), 0) from public.sale_items"],
  ["payment_attempts_by_status", "select string_agg(status || '=' || n || '/' || total, ',' order by status) from (select status::text, count(*) n, sum(amount_cents) total from public.payment_attempts group by 1) s"],
  ["ledger_by_type", "select string_agg(entry_type || '=' || n || '/' || total, ',' order by entry_type) from (select entry_type::text, count(*) n, sum(amount_cents) total from public.financial_ledger_entries group by 1) s"],
  ["manual_entries_by_kind", "select string_agg(kind || '=' || n || '/' || total, ',' order by kind) from (select kind::text, count(*) n, sum(amount_cents) total from public.finance_manual_entries group by 1) s"],
  ["payment_reconciliations", "select count(*) || '/' || coalesce(sum(observed_amount_cents), 0) || '/' || coalesce(sum(fee_amount_cents), 0) from public.payment_reconciliations"],
  ["cash_movements_by_type", "select string_agg(movement_type || '=' || n || '/' || total, ',' order by movement_type) from (select movement_type::text, count(*) n, sum(amount_cents) total from public.cash_movements group by 1) s"],
  ["inventory_balances", "select count(*) || '/' || coalesce(sum(on_hand_quantity), 0) || '/' || coalesce(sum(reserved_quantity), 0) from public.inventory_balances"],
  ["inventory_lot_balances", "select count(*) || '/' || coalesce(sum(on_hand_quantity), 0) from public.inventory_lot_balances"],
  ["stock_movements_by_type", "select string_agg(movement_type || '=' || n, ',' order by movement_type) from (select movement_type::text, count(*) n from public.stock_movements group by 1) s"],
  ["stock_movement_items", "select count(*) || '/' || coalesce(sum(quantity), 0) from public.stock_movement_items"],
  ["reservations_by_status", "select string_agg(status || '=' || n || '/' || total, ',' order by status) from (select status::text, count(*) n, sum(total_cents) total from public.commercial_reservations group by 1) s"],
  ["raffle_numbers_by_status", "select string_agg(status || '=' || n, ',' order by status) from (select status::text, count(*) n from public.raffle_numbers group by 1) s"],
  ["payables", "select (select count(*) || '/' || coalesce(sum(amount_cents), 0) from public.purchase_payable_entries) || ' settlements ' || (select count(*) || '/' || coalesce(sum(amount_cents), 0) from public.purchase_payable_settlements)"],
  ["opening_positions", "select count(*) || '/' || coalesce(sum(amount_cents), 0) from public.finance_opening_position_lines"],
  ["picpay_evidence", "select (select count(*) from public.picpay_source_imports) || '/' || (select count(*) from public.picpay_transactions) || '/' || (select count(*) from public.picpay_receivable_installments) || '/' || (select count(*) || ':' || coalesce(sum(amount_cents), 0) from public.picpay_statement_lines)"],
  ["picpay_attribution", "select (select count(*) from public.picpay_transaction_links) || '/' || (select count(*) from public.picpay_statement_line_resolutions) || '/' || (select count(*) from public.picpay_exception_resolutions)"],
  ["balance_checks", "select count(*) || '/' || coalesce(sum(total_difference_cents), 0) from public.finance_balance_checks"],
  ["outbox_by_status", "select string_agg(status || '=' || n, ',' order by status) from (select status::text, count(*) n from public.outbox_events group by 1) s"],
  ["audit_logs", "select count(*)::text from public.audit_logs"],
];

const dollar = (tag, text) => {
  if (text.includes(`$${tag}$`)) throw new Error(`snapshot parameter contains the ${tag} delimiter`);
  return `$${tag}$${text}$${tag}$`;
};

/**
 * @param {{ columns?: Record<string, string[]> | null, perRow?: boolean }} options
 *   columns: restrict each listed table to these columns (the "before" columns); other tables use all columns.
 *   perRow: also return one hash per primary key, so rows added by live traffic can be told apart from changes.
 */
export function snapshotSql({ columns = null, perRow = false } = {}) {
  const params = columns ? `${dollar("cols", JSON.stringify(columns))}::jsonb` : "null::jsonb";
  const rowHashes = perRow
    ? "coalesce(string_agg(k || '':'' || h, '','' order by k), '''')"
    : "''''";
  const aggregates = AGGREGATES.map(([name, sql]) => `'${name}', (${sql})`).join(",\n    ");
  return `with params as (select ${params} as cols),
target as (
  select c.oid, c.relname::text as relname, c.relnamespace::regnamespace::text as nspname,
    (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as current_cols,
    case when p.cols ? c.relname::text
      then (select array_agg(e.value order by e.ord) from jsonb_array_elements_text(p.cols -> c.relname::text) with ordinality e(value, ord))
    end as wanted_cols,
    (select array_agg(a.attname::text order by k.ord) from pg_index i
      cross join unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indrelid = c.oid and i.indisprimary) as pk
  from pg_class c cross join params p
  -- Physical tables of public and, once tables move behind cohort views, of cohort_data (names stay unique).
  where c.relnamespace::regnamespace::text in ('public', 'cohort_data') and c.relkind in ('r', 'p')
),
resolved as (
  select t.*,
    case when t.wanted_cols is null then t.current_cols
      else array(select w from unnest(t.wanted_cols) with ordinality u(w, o) where w = any(t.current_cols) order by o)
    end as used_cols,
    coalesce(array(select w from unnest(t.wanted_cols) w where not (w = any(t.current_cols))), '{}') as missing_cols
  from target t
),
measured as (
  select r.*, query_to_xml(format(
    'select count(*) as n, coalesce(md5(string_agg(h, '''' order by h)), '''') as hash, '
    || 'coalesce(md5(string_agg(ct || ''@'' || xm, '','' order by ct)), '''') as tuples, ${rowHashes} as row_hashes '
    || 'from (select md5(row(%s)::text) as h, md5(row(%s)::text) as k, x.xmin::text as xm, x.ctid::text as ct from %I.%I x) r',
    (select string_agg('x.' || quote_ident(col), ', ') from unnest(r.used_cols) col),
    (select string_agg('x.' || quote_ident(col), ', ') from unnest(coalesce(r.pk, r.used_cols)) col),
    r.nspname, r.relname), false, true, '') as result
  from resolved r
)
select jsonb_build_object(
  'generated_at', now(),
  'database_bytes', pg_database_size(current_database()),
  'migrations', (select coalesce(jsonb_agg(version order by version), '[]') from supabase_migrations.schema_migrations),
  'tables', (select jsonb_object_agg(relname, jsonb_build_object(
    'columns', to_jsonb(used_cols), 'current_columns', to_jsonb(current_cols), 'missing_columns', to_jsonb(missing_cols),
    'pk', to_jsonb(pk),
    'rows', ((xpath('/row/n/text()', result))[1]::text)::bigint,
    'hash', coalesce((xpath('/row/hash/text()', result))[1]::text, ''),
    'tuples', coalesce((xpath('/row/tuples/text()', result))[1]::text, ''),
    'row_hashes', coalesce((xpath('/row/row_hashes/text()', result))[1]::text, '')
  )) from measured),
  'aggregates', jsonb_build_object(
    ${aggregates}
  )
)::text as snapshot;`;
}

/** The columns of every table in a snapshot, to restrict the "after" snapshot to what existed before. */
export function columnsOf(snapshot) {
  return Object.fromEntries(Object.entries(snapshot.tables).map(([name, table]) => [name, table.current_columns]));
}

const rowHashMap = (value) => new Map(value ? value.split(",").map((pair) => pair.split(":")) : []);

/**
 * Compares two snapshots taken with the same columns.
 * @param {object} before
 * @param {object} after
 * @param {{ expectedNewColumns?: Record<string, string[]>, requireSameTuples?: boolean, allowNewRows?: boolean }} options
 *   expectedNewColumns: the only columns the migrations may add to pre-existing tables.
 *   requireSameTuples: no pre-existing tuple may be rewritten (xmin/ctid unchanged), for quiet databases only.
 *   allowNewRows: rows added in between are accepted (live production traffic); existing rows must stay identical,
 *   which requires per-row hashes in both snapshots.
 */
export function compareSnapshots(before, after, { expectedNewColumns = {}, requireSameTuples = false, allowNewRows = false } = {}) {
  const problems = [];
  const tables = [];
  for (const [name, old] of Object.entries(before.tables)) {
    const now = after.tables[name];
    if (!now) {
      problems.push(`${name}: table disappeared`);
      continue;
    }
    if (now.missing_columns.length) problems.push(`${name}: columns disappeared (${now.missing_columns.join(", ")})`);
    const added = now.current_columns.filter((column) => !old.current_columns.includes(column));
    const expected = expectedNewColumns[name] ?? [];
    const unexpected = added.filter((column) => !expected.includes(column));
    const absent = expected.filter((column) => !added.includes(column) && !old.current_columns.includes(column));
    if (unexpected.length) problems.push(`${name}: unexpected new columns (${unexpected.join(", ")})`);
    if (absent.length) problems.push(`${name}: expected new columns missing (${absent.join(", ")})`);

    const hashEqual = now.hash === old.hash;
    const tuplesEqual = now.tuples === old.tuples;
    let missingRows = 0;
    let changedRows = 0;
    if (allowNewRows) {
      if (!old.row_hashes && old.rows > 0) problems.push(`${name}: per-row hashes are required to accept new rows`);
      const nowRows = rowHashMap(now.row_hashes);
      for (const [key, hash] of rowHashMap(old.row_hashes)) {
        if (!nowRows.has(key)) missingRows += 1;
        else if (nowRows.get(key) !== hash) changedRows += 1;
      }
      if (now.rows < old.rows) problems.push(`${name}: ${old.rows - now.rows} rows fewer`);
    } else {
      if (now.rows !== old.rows) problems.push(`${name}: rows ${old.rows} → ${now.rows}`);
      else if (!hashEqual) problems.push(`${name}: content of pre-existing columns changed`);
    }
    if (missingRows) problems.push(`${name}: ${missingRows} pre-existing rows missing`);
    if (changedRows) problems.push(`${name}: ${changedRows} pre-existing rows changed`);
    if (requireSameTuples && !tuplesEqual) problems.push(`${name}: pre-existing tuples were rewritten`);
    tables.push({ name, rowsBefore: old.rows, rowsAfter: now.rows, hashEqual, tuplesEqual, added });
  }
  const newTables = Object.keys(after.tables).filter((name) => !before.tables[name]).sort();
  const aggregates = Object.keys(before.aggregates).map((name) => ({
    name, before: before.aggregates[name], after: after.aggregates[name], equal: before.aggregates[name] === after.aggregates[name],
  }));
  if (!allowNewRows) for (const aggregate of aggregates) if (!aggregate.equal) problems.push(`aggregate ${aggregate.name} changed`);
  return { ok: problems.length === 0, problems, tables, newTables, aggregates };
}
