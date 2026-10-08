-- Supabase Free (docs/operations/supabase-free-performance.md): RLS evaluates auth checks once per statement, and
-- the hot-path lookups have their indexes. Behaviour is covered by the RLS suites of each module.
begin;
select plan(5);

select is((
  select count(*)::integer from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and (
    coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
  ) ~ '(?<!SELECT )(auth\.uid\(\)|(public\.)?has_permission\()'
), 0, 'no public policy calls auth.uid() or has_permission() once per row');

select has_index('cohort_data', 'promotion_redemptions', 'promotion_redemptions_sale_id_idx', 'redemptions are found by sale');
select has_index('cohort_data', 'promotion_redemptions', 'promotion_redemptions_reservation_id_idx', 'redemptions are found by reservation');
select has_index('cohort_data', 'raffle_numbers', 'raffle_numbers_sale_id_idx', 'raffle numbers are found by sale');
select is((
  select count(*)::integer from (
    select 1 from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    group by i.indrelid, i.indkey::text, i.indclass::text, coalesce(pg_get_expr(i.indpred, i.indrelid), ''),
      coalesce(pg_get_expr(i.indexprs, i.indrelid), ''), i.indisunique
    having count(*) > 1
  ) duplicates
), 0, 'no table keeps two identical indexes');

select * from finish();
rollback;
