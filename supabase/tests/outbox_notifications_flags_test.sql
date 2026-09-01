begin;
select plan(52);

select has_table('public', 'notifications', 'notifications table exists');
select has_table('public', 'feature_flags', 'feature flags table exists');
select has_function('public', 'worker_claim_outbox_events', array['text','integer','integer'], 'worker claim RPC exists');
select has_function('public', 'worker_expire_due_reservations', array['integer'], 'worker expiration RPC exists');
select has_function('public', 'worker_process_outbox_event', array['uuid','text'], 'worker process RPC exists');
select has_function('public', 'worker_retry_outbox_event', array['uuid','text','text','integer','integer'], 'worker retry RPC exists');
select has_function('public', 'worker_outbox_metrics', array[]::text[], 'worker metrics RPC exists');
select ok((select relrowsecurity from pg_class where oid = 'public.notifications'::regclass), 'notifications have RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.feature_flags'::regclass), 'feature flags have RLS');
select results_eq($$select count(*)::bigint from public.feature_flags$$, array[11::bigint], 'all launch flags are seeded');
select results_eq($$select count(*)::bigint from public.feature_flags where enabled$$, array[5::bigint], 'five launch capabilities start enabled');
select results_eq($$select count(*)::bigint from public.feature_flags where not enabled$$, array[6::bigint], 'six remote or post-MVP capabilities start disabled');
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name = 'feature_flags' and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint], 'API roles cannot write feature flags directly'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name = 'notifications' and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint], 'API roles cannot write notifications directly'
);
select ok(has_function_privilege('service_role', 'public.worker_claim_outbox_events(text,integer,integer)', 'EXECUTE'), 'service role can claim jobs');
select ok(not has_function_privilege('authenticated', 'public.worker_claim_outbox_events(text,integer,integer)', 'EXECUTE'), 'authenticated users cannot claim jobs');
select ok(not has_function_privilege('anon', 'public.worker_claim_outbox_events(text,integer,integer)', 'EXECUTE'), 'anonymous users cannot claim jobs');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.update_feature_flag('reservations', false, 'Tentativa sem permissão', gen_random_uuid())$$,
  '42501', 'FEATURE_FLAG_MANAGE_FORBIDDEN', 'consumer cannot change flags'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select public.update_feature_flag('reservations', false, 'Pausa operacional de teste', '93000000-0000-4000-8000-000000000001') ->> 'enabled'$$,
  array['false'::text], 'admin can disable a flag'
);
reset role;
select results_eq($$select count(*)::bigint from public.audit_logs where action = 'features.flag.changed'$$, array[1::bigint], 'flag change is audited');
select results_eq($$select count(*)::bigint from public.outbox_events where topic = 'features.flag.changed'$$, array[1::bigint], 'flag change emits an outbox event');

insert into public.inventory_balances (location_id, product_id)
values ('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001', 10, 'Worker test stock', 'worker-stock', '93000000-0000-4000-8000-000000000002')$$,
  'admin prepares stock through the ledger'
);
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.create_commercial_reservation('50000000-0000-4000-8000-000000000001', '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'flag-disabled-reservation', '93000000-0000-4000-8000-000000000003')$$,
  'P0001', 'FEATURE_DISABLED', 'disabled reservation flag fails closed'
);
reset role;
select results_eq(
  $$select reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '33f00000-0000-4000-8000-000000000001'$$,
  array[0::bigint], 'failed flagged operation rolls back its stock hold'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select public.update_feature_flag('reservations', true, 'Retomada operacional de teste', '93000000-0000-4000-8000-000000000004') ->> 'enabled'$$,
  array['true'::text], 'admin can re-enable a flag'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
create temp table expiring_commercial as
select public.create_commercial_reservation(
  '50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]'::jsonb,
  'worker-commercial-expire', '93000000-0000-4000-8000-000000000005'
) as result;
reset role;
alter table public.commercial_reservations disable trigger commercial_reservations_guard;
update public.commercial_reservations
set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
where id = (select (result ->> 'reservation_id')::uuid from expiring_commercial);
alter table public.commercial_reservations enable trigger commercial_reservations_guard;
update public.stock_reservations
set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
where id = (select (result #>> '{stock_reservation,reservation_id}')::uuid from expiring_commercial);

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table expiration_result as select public.worker_expire_due_reservations(100) as result;
reset role;
select results_eq($$select (result ->> 'commercial_reservations')::integer from expiration_result$$, array[1], 'worker expires the due commercial reservation');
select results_eq(
  $$select status::text from public.commercial_reservations where id = (select (result ->> 'reservation_id')::uuid from expiring_commercial)$$,
  array['EXPIRED'::text], 'commercial aggregate becomes expired'
);
select results_eq(
  $$select status::text from public.stock_reservations where id = (select (result #>> '{stock_reservation,reservation_id}')::uuid from expiring_commercial)$$,
  array['EXPIRED'::text], 'underlying stock hold becomes expired'
);
select results_eq(
  $$select reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '33f00000-0000-4000-8000-000000000001'$$,
  array[0::bigint], 'expiration releases reserved stock once'
);
select results_eq($$select count(*)::bigint from public.outbox_events where topic = 'reservations.expired'$$, array[1::bigint], 'expiration emits a notification-ready event');

insert into public.outbox_events (id, topic, aggregate_type, aggregate_id, payload)
values ('94000000-0000-4000-8000-000000000001', 'auth.roles.changed', 'profile',
  '10000000-0000-4000-8000-000000000003', '{"roles":["CONSUMIDOR"]}');
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table first_claim as select * from public.worker_claim_outbox_events('worker-notifications', 100, 300);
select ok(
  exists(select 1 from first_claim where id = '94000000-0000-4000-8000-000000000001'),
  'worker claim leases the event'
);
create temp table processed_auth_event as
select public.worker_process_outbox_event('94000000-0000-4000-8000-000000000001', 'worker-notifications') as result;
reset role;
select results_eq($$select result ->> 'status' from processed_auth_event$$, array['PUBLISHED'::text], 'processing acknowledges the event');
select results_eq(
  $$select count(*)::bigint from public.notifications where source_event_id = '94000000-0000-4000-8000-000000000001'$$,
  array[1::bigint], 'one notification is materialized for the target user'
);
select results_eq(
  $$select status::text from public.outbox_events where id = '94000000-0000-4000-8000-000000000001'$$,
  array['PUBLISHED'::text], 'processed outbox event is terminally published'
);
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select results_eq($$select (public.worker_outbox_metrics() ->> 'failed')::bigint$$, array[0::bigint], 'initial metrics have no dead letters');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select results_eq($$select count(*)::bigint from public.notifications$$, array[1::bigint], 'recipient can list the notification');
create temp table marked_read as
select public.mark_notification_read((select id from public.notifications limit 1)) as result;
select ok((select result ->> 'read_at' is not null from marked_read), 'recipient can mark the notification read');
select ok((select read_at is not null from public.notifications limit 1), 'read timestamp is persisted');
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq($$select count(*)::bigint from public.notifications$$, array[0::bigint], 'another user cannot list the notification');
select throws_ok(
  $$select public.mark_notification_read((select id from public.notifications where recipient_id = '10000000-0000-4000-8000-000000000003'))$$,
  'P0001', 'NOTIFICATION_NOT_FOUND', 'another user cannot mark the notification read'
);
reset role;

insert into public.outbox_events (id, topic, aggregate_type, aggregate_id, payload)
values ('94000000-0000-4000-8000-000000000002', 'test.delivery.failure', 'test_event', 'failure-1', '{}');
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table failure_claim as select * from public.worker_claim_outbox_events('worker-failure', 100, 300);
create temp table failure_retry as select public.worker_retry_outbox_event(
  '94000000-0000-4000-8000-000000000002', 'worker-failure', 'controlled delivery failure', 5, 1
) as result;
reset role;
select results_eq($$select result ->> 'status' from failure_retry$$, array['FAILED'::text], 'max attempts moves the event to logical dead-letter');
select results_eq(
  $$select last_error from public.outbox_events where id = '94000000-0000-4000-8000-000000000002'$$,
  array['controlled delivery failure'::text], 'dead-letter retains a bounded error'
);
select results_eq($$select enabled from public.feature_flags where key = 'reservations'$$, array[true], 'worker failure does not roll back the committed business state');
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select results_eq($$select (public.worker_outbox_metrics() ->> 'failed')::bigint$$, array[1::bigint], 'metrics expose the dead-letter count');
reset role;
insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload, available_at, created_at)
values ('test.delayed', 'test_event', 'delayed-1', '{}', now() - interval '6 minutes', now() - interval '6 minutes');
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select ok((public.worker_outbox_metrics() ->> 'delayed')::bigint >= 1, 'metrics expose delayed pending events');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table expiring_campaign as
select public.create_raffle_campaign(
  'Rifa expirada pelo worker', '33f00000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', 10,
  now() - interval '1 minute', now() + interval '1 day',
  'worker-raffle-campaign', '93000000-0000-4000-8000-000000000006'
) as result;
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
create temp table expiring_raffle as
select public.reserve_raffle_numbers(
  (select (result ->> 'campaign_id')::uuid from expiring_campaign), array[7,8],
  'worker-raffle-reserve', '93000000-0000-4000-8000-000000000007'
) as result;
reset role;
update public.raffle_numbers set expires_at = now() - interval '1 second'
where sale_id = (select (result ->> 'sale_id')::uuid from expiring_raffle);
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table raffle_expiration_result as select public.worker_expire_due_reservations(100) as result;
reset role;
select results_eq($$select (result ->> 'raffles')::integer from raffle_expiration_result$$, array[1], 'worker expires one raffle reservation');
select results_eq(
  $$select status::text from public.sales where id = (select (result ->> 'sale_id')::uuid from expiring_raffle)$$,
  array['CANCELLED'::text], 'expired raffle sale is cancelled'
);
select results_eq(
  $$select status::text from public.payment_attempts where id = (select (result ->> 'payment_attempt_id')::uuid from expiring_raffle)$$,
  array['CANCELLED'::text], 'expired raffle payment attempt is cancelled'
);
select results_eq(
  $$select count(*)::bigint from public.raffle_numbers where campaign_id = (select (result ->> 'campaign_id')::uuid from expiring_campaign) and status = 'AVAILABLE'$$,
  array[10::bigint], 'expired numbers return to availability'
);
select results_eq(
  $$select count(*)::bigint from public.raffle_numbers where campaign_id = (select (result ->> 'campaign_id')::uuid from expiring_campaign) and (sale_id is not null or reserved_by is not null or expires_at is not null)$$,
  array[0::bigint], 'expired numbers retain no stale reservation links'
);
select results_eq($$select count(*)::bigint from public.outbox_events where topic = 'raffles.reservation.expired'$$, array[1::bigint], 'raffle expiration emits one outbox event');
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table final_claim as select * from public.worker_claim_outbox_events('worker-final', 100, 300);
select public.worker_process_outbox_event(id, 'worker-final') from final_claim;
reset role;
select results_eq(
  $$select count(*)::bigint from public.notifications where recipient_id = '10000000-0000-4000-8000-000000000003' and kind = 'RAFFLE_EXPIRED'$$,
  array[1::bigint], 'raffle expiration becomes an in-app notification'
);

select * from finish();
rollback;
