begin;
select plan(49);

select has_table('public', 'stock_movements', 'stock movements table exists');
select has_table('public', 'stock_movement_items', 'stock movement items table exists');
select has_table('public', 'audit_logs', 'audit log table exists');
select has_table('public', 'outbox_events', 'outbox table exists');
select has_function('public', 'adjust_stock', array['uuid', 'uuid', 'bigint', 'text', 'text', 'uuid'], 'stock adjustment RPC exists');
select has_function('public', 'transfer_stock', array['uuid', 'uuid', 'uuid', 'bigint', 'text', 'text', 'uuid'], 'stock transfer RPC exists');
select has_function('public', 'reverse_stock_movement', array['uuid', 'text', 'text', 'uuid'], 'stock reversal RPC exists');
select results_eq(
  $$select count(*)::bigint from pg_class where oid in ('public.stock_movements'::regclass, 'public.stock_movement_items'::regclass, 'public.audit_logs'::regclass, 'public.outbox_events'::regclass) and relrowsecurity$$,
  array[4::bigint],
  'ledger, audit and outbox tables have RLS enabled'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename in ('stock_movements', 'stock_movement_items', 'audit_logs', 'outbox_events') and cmd in ('INSERT', 'UPDATE', 'DELETE')$$,
  array[0::bigint],
  'ledger foundation has no direct write policies'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name in ('audit_logs', 'outbox_events') and grantee in ('anon', 'authenticated', 'service_role')$$,
  array[0::bigint],
  'audit and outbox have no Data API grants'
);

insert into public.categories (id, name, slug) values
  ('22000000-0000-4000-8000-000000000001', 'Ledger', 'ledger');
insert into public.products (id, category_id, sku, slug, name, active, published) values
  ('32000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'LEDGER-ITEM', 'ledger-item', 'Item do ledger', true, true);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';

create temp table adjustment_result as
select public.adjust_stock(
  '50000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000001',
  10,
  'Carga inicial controlada',
  'ledger-adjust-1',
  '60000000-0000-4000-8000-000000000001'
) as result;

select results_eq(
  $$select on_hand_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '32000000-0000-4000-8000-000000000001'$$,
  array[10::bigint],
  'positive adjustment updates the materialized balance'
);
select results_eq($$select count(*)::bigint from public.stock_movements$$, array[1::bigint], 'adjustment creates one movement');
select results_eq($$select count(*)::bigint from public.stock_movement_items$$, array[1::bigint], 'adjustment creates one movement item');
reset role;
select results_eq($$select count(*)::bigint from public.audit_logs$$, array[1::bigint], 'adjustment creates one audit record');
select results_eq($$select count(*)::bigint from public.outbox_events$$, array[1::bigint], 'adjustment creates one outbox event');
select results_eq(
  $$select count(*)::bigint from public.idempotency_keys where key = 'ledger-adjust-1' and status = 'SUCCEEDED'$$,
  array[1::bigint],
  'adjustment stores a successful idempotency result'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000001', 10, 'Carga inicial controlada', 'ledger-adjust-1', '60000000-0000-4000-8000-000000000099')$$,
  $$select result from adjustment_result$$,
  'same adjustment key and payload replays the stored result'
);
select results_eq($$select count(*)::bigint from public.stock_movements$$, array[1::bigint], 'adjustment replay creates no second movement');
select throws_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000001', 11, 'Carga inicial controlada', 'ledger-adjust-1', '60000000-0000-4000-8000-000000000002')$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with a different adjustment payload conflicts'
);

select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000001', -3, 'Correção de contagem', 'ledger-adjust-2', '60000000-0000-4000-8000-000000000003')$$,
  'negative adjustment succeeds while stock is available'
);
select results_eq(
  $$select on_hand_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '32000000-0000-4000-8000-000000000001'$$,
  array[7::bigint],
  'negative adjustment decreases physical stock'
);

create temp table transfer_result as
select public.transfer_stock(
  '50000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000002',
  '32000000-0000-4000-8000-000000000001',
  4,
  'Distribuição ao vendedor',
  'ledger-transfer-1',
  '60000000-0000-4000-8000-000000000004'
) as result;

select results_eq(
  $$select array_agg(on_hand_quantity order by location_id) from public.inventory_balances where product_id = '32000000-0000-4000-8000-000000000001'$$,
  $$values (array[3::bigint, 4::bigint])$$,
  'transfer debits source and credits destination'
);
select results_eq(
  $$select sum(on_hand_quantity)::bigint from public.inventory_balances where product_id = '32000000-0000-4000-8000-000000000001'$$,
  array[7::bigint],
  'transfer conserves global physical stock'
);
select results_eq(
  $$select public.transfer_stock('50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', '32000000-0000-4000-8000-000000000001', 4, 'Distribuição ao vendedor', 'ledger-transfer-1', '60000000-0000-4000-8000-000000000098')$$,
  $$select result from transfer_result$$,
  'transfer replay returns the stored result'
);
select results_eq($$select count(*)::bigint from public.stock_movements$$, array[3::bigint], 'transfer replay creates no duplicate movement');

select throws_ok(
  $$select public.transfer_stock('50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', '32000000-0000-4000-8000-000000000001', 99, 'Transferência impossível', 'ledger-transfer-fail', '60000000-0000-4000-8000-000000000005')$$,
  'P0001', 'STOCK_CONFLICT', 'transfer above available stock is rejected'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.idempotency_keys where key = 'ledger-transfer-fail'$$,
  array[0::bigint],
  'failed transfer leaves no orphan idempotency record'
);
select results_eq($$select count(*)::bigint from public.audit_logs$$, array[3::bigint], 'failed transfer creates no audit record');
select results_eq($$select count(*)::bigint from public.outbox_events$$, array[3::bigint], 'failed transfer creates no outbox event');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table reversal_result as
select public.reverse_stock_movement(
  (select (result ->> 'movement_id')::uuid from transfer_result),
  'Transferência desfeita',
  'ledger-reverse-1',
  '60000000-0000-4000-8000-000000000006'
) as result;
select results_eq(
  $$select array_agg(on_hand_quantity order by location_id) from public.inventory_balances where product_id = '32000000-0000-4000-8000-000000000001'$$,
  $$values (array[7::bigint, 0::bigint])$$,
  'transfer reversal restores both balances'
);
select results_eq(
  $$select count(*)::bigint from public.stock_movements where reversal_of is not null$$,
  array[1::bigint],
  'reversal links exactly one corrective movement'
);
select results_eq(
  $$select public.reverse_stock_movement((select (result ->> 'movement_id')::uuid from transfer_result), 'Transferência desfeita', 'ledger-reverse-1', '60000000-0000-4000-8000-000000000097')$$,
  $$select result from reversal_result$$,
  'reversal replay returns the stored result'
);
select throws_ok(
  $$select public.reverse_stock_movement((select (result ->> 'movement_id')::uuid from transfer_result), 'Segunda reversão', 'ledger-reverse-2', '60000000-0000-4000-8000-000000000007')$$,
  'P0001', 'MOVEMENT_ALREADY_REVERSED', 'a movement cannot be reversed twice'
);
reset role;
select results_eq($$select count(*)::bigint from public.stock_movements$$, array[4::bigint], 'failed second reversal creates no movement');
select results_eq($$select count(*)::bigint from public.audit_logs$$, array[4::bigint], 'each successful movement has one audit record');
select results_eq($$select count(*)::bigint from public.outbox_events$$, array[4::bigint], 'each successful movement has one outbox event');

select throws_ok(
  $$update public.stock_movements set reason = 'Alterado' where id = (select (result ->> 'movement_id')::uuid from adjustment_result)$$,
  'P0001', 'IMMUTABLE_RECORD', 'movement history cannot be updated'
);
select throws_ok(
  $$delete from public.audit_logs where true$$,
  'P0001', 'IMMUTABLE_RECORD', 'audit history cannot be deleted'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq($$select count(*)::bigint from public.stock_movements$$, array[2::bigint], 'seller sees only transfer movements involving their location');
select results_eq($$select count(*)::bigint from public.stock_movement_items$$, array[2::bigint], 'seller sees only items from visible movements');
select throws_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000002', '32000000-0000-4000-8000-000000000001', 1, 'Sem permissão', 'seller-adjust', '60000000-0000-4000-8000-000000000008')$$,
  '42501', 'INVENTORY_MANAGE_REQUIRED', 'seller cannot call the management adjustment RPC'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select results_eq($$select count(*)::bigint from public.stock_movements$$, array[0::bigint], 'consumer sees no inventory movement');
reset role;

create temp table first_claim as
select id from private.claim_outbox_events('worker-a', 1, interval '5 minutes');
select results_eq(
  $$select status::text from public.outbox_events where id = (select id from first_claim)$$,
  array['PROCESSING'::text],
  'outbox claim marks an event as processing'
);
select results_eq(
  $$select attempts from public.outbox_events where id = (select id from first_claim)$$,
  array[1],
  'outbox claim increments attempts'
);
select throws_ok(
  $$select private.ack_outbox_event((select id from first_claim), 'worker-b')$$,
  'P0001', 'OUTBOX_CLAIM_MISMATCH', 'wrong worker cannot acknowledge an event'
);
select lives_ok(
  $$select private.ack_outbox_event((select id from first_claim), 'worker-a')$$,
  'claiming worker can acknowledge an event'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where status = 'PUBLISHED' and published_at is not null$$,
  array[1::bigint],
  'acknowledged event is published once'
);

create temp table second_claim as
select id from private.claim_outbox_events('worker-a', 1, interval '5 minutes');
select lives_ok(
  $$select private.retry_outbox_event((select id from second_claim), 'worker-a', 'delivery failed', now() + interval '1 minute', 1)$$,
  'claimed event can be failed after reaching max attempts'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where status = 'FAILED' and last_error = 'delivery failed'$$,
  array[1::bigint],
  'outbox preserves terminal delivery failure'
);

select * from finish();
rollback;
