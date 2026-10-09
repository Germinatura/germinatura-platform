-- Supabase Free (docs/operations/supabase-free-performance.md): the outbox claim and metrics the jobs Worker runs
-- every minute reach their rows through partial indexes instead of reading every published event.
begin;
select plan(5);
select set_config('germinatura.system_cohort', 'c0000000-0000-4000-8000-000000002026', true); -- ADR 0011 (PR 5): fixtures name their cohort

insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload, status, attempts, published_at, created_at, available_at)
select 'sales.created', 'sale', gen_random_uuid()::text, '{}'::jsonb, 'PUBLISHED', 1, now() - g * interval '1 second',
  now() - g * interval '1 second', now() - g * interval '1 second'
from generate_series(1, 20000) g;
analyze public.outbox_events;

create function pg_temp.plan_of(p_query text) returns text language plpgsql as $$
declare v_plan json;
begin
  execute 'explain (format json) ' || p_query into v_plan;
  return v_plan::text;
end;
$$;

select has_index('cohort_data', 'outbox_events', 'outbox_events_processing_lease_idx', 'expired leases are found by index');
select has_index('cohort_data', 'outbox_events', 'outbox_events_failed_idx', 'failed events are counted by index');
select ok(pg_temp.plan_of($$select id from public.outbox_events
  where ((status = 'PENDING' and available_at <= now()) or (status = 'PROCESSING' and locked_at < now() - interval '300 seconds'))
  order by available_at, created_at for update skip locked limit 100$$) !~ 'Seq Scan',
  'the claim does not read every published event');
select ok(pg_temp.plan_of($$select count(*) from public.outbox_events where status = 'PROCESSING'$$) !~ 'Seq Scan',
  'counting events in processing does not read every published event');
select ok(pg_temp.plan_of($$select count(*) from public.outbox_events where status = 'FAILED'$$) !~ 'Seq Scan',
  'counting failed events does not read every published event');

select * from finish();
rollback;
