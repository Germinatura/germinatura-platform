-- The outbox batch RPC processes many events per call, isolating failures into the retry path.
begin;
select plan(7);

-- A clean slate: earlier fixtures may have queued events.
update public.outbox_events set status = 'PUBLISHED', locked_at = null, locked_by = null, published_at = now()
where status in ('PENDING', 'PROCESSING');

insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
select 'tests.batch.noop', 'test', gen_random_uuid()::text, '{}'::jsonb from generate_series(1, 120);
-- A malformed event the processor rejects (the reservation id is not a uuid).
insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
values ('reservations.created', 'commercial_reservation', 'not-a-uuid', '{}'::jsonb);

select throws_ok($$select public.worker_process_outbox_batch('batch-anon', 10)$$, '42501', 'WORKER_SERVICE_ROLE_REQUIRED', 'only the worker role may process batches');

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select throws_ok($$select public.worker_process_outbox_batch('batch-worker', 101)$$, '22023', 'INVALID_OUTBOX_BATCH', 'a batch is at most 100 events');
create temp table first_batch as select public.worker_process_outbox_batch('batch-worker', 100) as result;
create temp table second_batch as select public.worker_process_outbox_batch('batch-worker', 100) as result;
reset role;

select is((select (result ->> 'claimed')::integer from first_batch), 100, 'one call claims up to 100 events');
select is((select (result ->> 'claimed')::integer + (select (result ->> 'claimed')::integer from first_batch) from second_batch), 121, 'the next call takes the rest');
select is((select sum((result ->> 'published')::integer + (result ->> 'retried')::integer)::integer from (select result from first_batch union all select result from second_batch) batches), 121,
  'every claimed event is either published or sent back for retry');
select is((select count(*)::integer from public.outbox_events where status = 'PROCESSING'), 0, 'nothing stays stuck in processing');
select ok(exists (select 1 from public.outbox_events where aggregate_id = 'not-a-uuid' and status = 'PENDING' and attempts = 1 and last_error = 'OUTBOX_PROCESSING_FAILED'),
  'the malformed event goes back to the queue with a generic error');

select * from finish();
rollback;
