-- Backfill and validate the cohort expansion (20261019090100), then prove integrity before the migration commits.
--
-- 1. Backfill: explicit and idempotent. Rows created before the expansion already read as Turma 2026 through the
--    column default, so this UPDATE normally matches nothing and no trigger fires. It only exists to fail loudly
--    (immutable tables refuse the UPDATE) if a row without cohort ever appears.
-- 2. Validate: every cohort foreign key is validated against public.cohorts.
-- 3. Report: private.cohort_integrity_report() lists every check with its number of violations. The migration aborts
--    when any check fails. The same report backs the pgTAP tests, the upgrade check and the cutover runbook.
-- NOT NULL is deliberately left for the cohort authorization migration, after staging and production validate this.

set local lock_timeout = '5s';

do $$
declare
  v_table text;
begin
  for v_table in select table_name from private.cohort_scoped_tables order by table_name loop
    execute format(
      'update public.%I set cohort_id = %L::uuid where cohort_id is null',
      v_table, private.bootstrap_cohort_id()
    );
    execute format('alter table public.%I validate constraint %I', v_table, v_table || '_cohort_id_fkey');
  end loop;
end;
$$;

create or replace function private.cohort_integrity_report()
returns table (check_name text, subject text, violations bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_table text;
  v_fk record;
  v_join text;
begin
  check_name := 'single_default_cohort';
  subject := 'cohorts';
  select abs(count(*) - 1) into violations from public.cohorts where is_default;
  return next;

  check_name := 'bootstrap_cohort_present';
  subject := 'cohorts';
  select case when exists (select 1 from public.cohorts where id = private.bootstrap_cohort_id()) then 0 else 1 end
  into violations;
  return next;

  check_name := 'profile_without_membership';
  subject := 'user_cohorts';
  select count(*) into violations
  from public.profiles profile
  where not exists (select 1 from public.user_cohorts membership where membership.user_id = profile.id);
  return next;

  for v_table in select table_name from private.cohort_scoped_tables order by table_name loop
    if not exists (
      select 1 from pg_attribute
      where attrelid = format('public.%I', v_table)::regclass and attname = 'cohort_id' and not attisdropped
    ) then
      check_name := 'scoped_column_missing';
      subject := v_table;
      violations := 1;
      return next;
      continue;
    end if;

    check_name := 'scoped_row_without_cohort';
    subject := v_table;
    execute format('select count(*) from public.%I where cohort_id is null', v_table) into violations;
    return next;

    check_name := 'scoped_foreign_key_not_validated';
    subject := v_table;
    select case when exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', v_table)::regclass and conname = v_table || '_cohort_id_fkey' and convalidated
    ) then 0 else 1 end into violations;
    return next;
  end loop;

  -- A row and the scoped row it references must belong to the same cohort.
  for v_fk in
    select constraint_row.conname, child.relname as child_table, parent.relname as parent_table,
      constraint_row.conrelid, constraint_row.confrelid, constraint_row.conkey, constraint_row.confkey
    from pg_constraint constraint_row
    join pg_class child on child.oid = constraint_row.conrelid
    join pg_class parent on parent.oid = constraint_row.confrelid
    where constraint_row.contype = 'f'
      and child.relnamespace = 'public'::regnamespace
      and parent.relnamespace = 'public'::regnamespace
      and child.relname in (select table_name from private.cohort_scoped_tables)
      and parent.relname in (select table_name from private.cohort_scoped_tables)
    order by child.relname, constraint_row.conname
  loop
    select string_agg(format('parent_row.%I = child_row.%I', parent_column.attname, child_column.attname), ' and ')
    into v_join
    from unnest(v_fk.conkey, v_fk.confkey) as key_pair(child_attnum, parent_attnum)
    join pg_attribute child_column on child_column.attrelid = v_fk.conrelid and child_column.attnum = key_pair.child_attnum
    join pg_attribute parent_column on parent_column.attrelid = v_fk.confrelid and parent_column.attnum = key_pair.parent_attnum;

    check_name := 'cross_cohort_reference';
    subject := v_fk.child_table || '.' || v_fk.conname;
    execute format(
      'select count(*) from public.%I child_row join public.%I parent_row on %s '
      'where child_row.cohort_id is distinct from parent_row.cohort_id',
      v_fk.child_table, v_fk.parent_table, v_join
    ) into violations;
    return next;
  end loop;
end;
$$;

revoke all on function private.cohort_integrity_report() from public, anon, authenticated;

comment on function private.cohort_integrity_report() is
  'Checks of the cohort foundation; every row must report 0 violations (docs/operations/cohort-cutover-runbook.md).';

do $$
declare
  v_failures text;
begin
  select string_agg(check_name || ' ' || subject || '=' || violations, ', ' order by check_name, subject)
  into v_failures
  from private.cohort_integrity_report()
  where violations <> 0;
  if v_failures is not null then
    raise exception 'COHORT_INTEGRITY_FAILED: %', v_failures;
  end if;
end;
$$;
