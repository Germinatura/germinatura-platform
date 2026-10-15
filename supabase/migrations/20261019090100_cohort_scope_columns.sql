-- Expand: every table classified as cohort-scoped (private.cohort_scoped_tables) receives a nullable cohort_id.
--
-- The column is added with the constant default of Turma 2026. On PostgreSQL 11+ a non-volatile default is stored
-- in the catalogue only: no row is rewritten and no UPDATE runs, so immutable ledgers keep their tuples untouched
-- and every existing row reads as Turma 2026. New rows written by the current application get the same cohort,
-- which keeps the behavior identical until the cohort authorization context replaces this default.
--
-- The foreign key starts NOT VALID (no scan while holding the table lock) and is validated by the next migration.

set local lock_timeout = '5s';

do $$
declare
  v_table text;
  v_constraint text;
begin
  for v_table in select table_name from private.cohort_scoped_tables order by table_name loop
    if to_regclass(format('public.%I', v_table)) is null then
      raise exception 'COHORT_SCOPE_TABLE_MISSING: public.%', v_table;
    end if;

    execute format(
      'alter table public.%I add column if not exists cohort_id uuid default %L::uuid',
      v_table, private.bootstrap_cohort_id()
    );

    v_constraint := v_table || '_cohort_id_fkey';
    if not exists (
      select 1 from pg_constraint
      where conname = v_constraint and conrelid = format('public.%I', v_table)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (cohort_id) references public.cohorts (id) not valid',
        v_table, v_constraint
      );
    end if;
  end loop;
end;
$$;
