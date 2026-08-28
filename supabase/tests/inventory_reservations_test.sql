begin;
select plan(43);

select has_table('public', 'stock_reservations', 'stock reservations table exists');
select has_table('public', 'stock_reservation_items', 'stock reservation items table exists');
select has_type('public', 'stock_reservation_status', 'reservation status type exists');
select has_function('public', 'reserve_stock', array['uuid', 'jsonb', 'text', 'text', 'text', 'uuid'], 'reserve stock RPC exists');
select has_function('public', 'release_stock_reservation', array['uuid', 'text', 'uuid'], 'release reservation RPC exists');
select has_function('private', 'expire_stock_reservation', array['uuid', 'uuid'], 'internal expiration function exists');
select results_eq(
  $$select count(*)::bigint from pg_class where oid in ('public.stock_reservations'::regclass, 'public.stock_reservation_items'::regclass) and relrowsecurity$$,
  array[2::bigint],
  'reservation tables have RLS enabled'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename in ('stock_reservations', 'stock_reservation_items') and cmd in ('INSERT', 'UPDATE', 'DELETE')$$,
  array[0::bigint],
  'reservation tables have no direct write policies'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name in ('stock_reservations', 'stock_reservation_items') and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint],
  'API roles receive no reservation write grants'
);

insert into public.products (
  id, category_id, sku, slug, name, active, published, reservable
) values (
  '33000000-0000-4000-8000-000000000002',
  '23000000-0000-4000-8000-000000000001',
  'RESERVATION-SECOND',
  'reservation-second',
  'Segundo item de reserva',
  true, false, false
);
insert into public.inventory_balances (location_id, product_id, on_hand_quantity)
values ('50000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000002', 1);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 5, 'Estoque para reserva', 'reservation-stock-1', '61000000-0000-4000-8000-000000000001')$$,
  'manager prepares stock through the ledger'
);

create temp table reservation_result as
select public.reserve_stock(
  '50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33000000-0000-4000-8000-000000000001","quantity":2}]'::jsonb,
  'test_order', 'order-1', 'reservation-create-1',
  '61000000-0000-4000-8000-000000000002'
) as result;

select results_eq(
  $$select reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '33000000-0000-4000-8000-000000000001'$$,
  array[2::bigint],
  'reservation increases reserved quantity'
);
select results_eq(
  $$select available_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '33000000-0000-4000-8000-000000000001'$$,
  array[3::bigint],
  'reservation decreases available quantity without consuming physical stock'
);
select results_eq(
  $$select on_hand_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '33000000-0000-4000-8000-000000000001'$$,
  array[5::bigint],
  'reservation preserves physical stock'
);
select results_eq(
  $$select status::text from public.stock_reservations where id = (select (result ->> 'reservation_id')::uuid from reservation_result)$$,
  array['ACTIVE'::text],
  'new reservation is active'
);
select ok(
  (select expires_at between created_at + interval '9 minutes 50 seconds' and created_at + interval '10 minutes 10 seconds'
   from public.stock_reservations where id = (select (result ->> 'reservation_id')::uuid from reservation_result)),
  'reservation TTL is set by the server to ten minutes'
);
select results_eq(
  $$select count(*)::bigint from public.stock_movement_items where movement_id = (select (result ->> 'reservation_movement_id')::uuid from reservation_result)$$,
  array[1::bigint],
  'reservation creates ledger items'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'inventory.reservation.created'$$,
  array[1::bigint],
  'reservation creates an audit record'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where topic = 'inventory.reservation.created'$$,
  array[1::bigint],
  'reservation creates an outbox event'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select public.reserve_stock('50000000-0000-4000-8000-000000000001', '[{"quantity":2,"product_id":"33000000-0000-4000-8000-000000000001"}]'::jsonb, 'test_order', 'order-1', 'reservation-create-1', '61000000-0000-4000-8000-000000000099')$$,
  $$select result from reservation_result$$,
  'same key replays the canonical reservation result'
);
select results_eq($$select count(*)::bigint from public.stock_reservations$$, array[1::bigint], 'reservation replay creates no duplicate');
select throws_ok(
  $$select public.reserve_stock('50000000-0000-4000-8000-000000000001', '[{"product_id":"33000000-0000-4000-8000-000000000001","quantity":3}]'::jsonb, 'test_order', 'order-1', 'reservation-create-1', '61000000-0000-4000-8000-000000000003')$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with different quantity conflicts'
);

select throws_ok(
  $$select public.reserve_stock('50000000-0000-4000-8000-000000000001', '[{"product_id":"33000000-0000-4000-8000-000000000001","quantity":1},{"product_id":"33000000-0000-4000-8000-000000000002","quantity":2}]'::jsonb, 'test_order', 'order-atomic', 'reservation-atomic-fail', '61000000-0000-4000-8000-000000000004')$$,
  'P0001', 'STOCK_CONFLICT', 'inventory hold accepts an active non-reservable product but fails atomically when stock is insufficient'
);
select results_eq($$select count(*)::bigint from public.stock_reservations$$, array[1::bigint], 'failed cart creates no partial reservation');
select results_eq(
  $$select reserved_quantity from public.inventory_balances where product_id = '33000000-0000-4000-8000-000000000002' and location_id = '50000000-0000-4000-8000-000000000001'$$,
  array[0::bigint],
  'failed cart reserves none of its items'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.idempotency_keys where key = 'reservation-atomic-fail'$$,
  array[0::bigint],
  'failed cart leaves no orphan idempotency record'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table release_result as
select public.release_stock_reservation(
  (select (result ->> 'reservation_id')::uuid from reservation_result),
  'reservation-release-1',
  '61000000-0000-4000-8000-000000000005'
) as result;
select results_eq(
  $$select reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '33000000-0000-4000-8000-000000000001'$$,
  array[0::bigint],
  'release restores available stock'
);
select results_eq(
  $$select status::text from public.stock_reservations where id = (select (result ->> 'reservation_id')::uuid from reservation_result)$$,
  array['RELEASED'::text],
  'released reservation reaches terminal state'
);
select results_eq(
  $$select public.release_stock_reservation((select (result ->> 'reservation_id')::uuid from reservation_result), 'reservation-release-1', '61000000-0000-4000-8000-000000000098')$$,
  $$select result from release_result$$,
  'release replay returns the stored result'
);
select lives_ok(
  $$select public.release_stock_reservation((select (result ->> 'reservation_id')::uuid from reservation_result), 'reservation-release-2', '61000000-0000-4000-8000-000000000006')$$,
  'release with another key remains a no-op after terminal state'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.stock_movements where movement_type = 'LIBERACAO_RESERVA'$$,
  array[1::bigint],
  'repeated release creates one release movement'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table expiring_result as
select public.reserve_stock(
  '50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
  'test_order', 'order-expire', 'reservation-expire-create',
  '61000000-0000-4000-8000-000000000007'
) as result;
reset role;
update public.stock_reservations
set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
where id = (select (result ->> 'reservation_id')::uuid from expiring_result);
create temp table expiration_result as
select private.expire_stock_reservation(
  (select (result ->> 'reservation_id')::uuid from expiring_result),
  '61000000-0000-4000-8000-000000000008'
) as result;
select results_eq(
  $$select status::text from public.stock_reservations where id = (select (result ->> 'reservation_id')::uuid from expiring_result)$$,
  array['EXPIRED'::text],
  'expiration marks the reservation as expired'
);
select results_eq(
  $$select private.expire_stock_reservation((select (result ->> 'reservation_id')::uuid from expiring_result), '61000000-0000-4000-8000-000000000009')$$,
  $$select result from expiration_result$$,
  'expiration is idempotent after terminal state'
);
select results_eq(
  $$select count(*)::bigint from public.stock_movements where movement_type = 'LIBERACAO_RESERVA'$$,
  array[2::bigint],
  'expiration creates exactly one additional release movement'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000001', 2, 'Estoque do vendedor', 'seller-reservation-stock', '61000000-0000-4000-8000-000000000010')$$,
  'manager prepares seller stock through the ledger'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select lives_ok(
  $$select public.reserve_stock('50000000-0000-4000-8000-000000000002', '[{"product_id":"33000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'seller_operation', 'seller-1', 'seller-reservation-own', '61000000-0000-4000-8000-000000000011')$$,
  'seller can reserve stock at their own location'
);
select throws_ok(
  $$select public.reserve_stock('50000000-0000-4000-8000-000000000001', '[{"product_id":"33000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'seller_operation', 'seller-forbidden', 'seller-reservation-central', '61000000-0000-4000-8000-000000000012')$$,
  '42501', 'RESERVATION_LOCATION_FORBIDDEN', 'seller cannot reserve central stock'
);
select results_eq($$select count(*)::bigint from public.stock_reservations$$, array[1::bigint], 'seller sees only their own reservation');
select results_eq($$select count(*)::bigint from public.stock_reservation_items$$, array[1::bigint], 'seller sees only items from their reservation');
select throws_ok(
  $$update public.stock_reservations set status = 'RELEASED' where true$$,
  '42501', null, 'seller cannot mutate reservation state directly'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.reserve_stock('50000000-0000-4000-8000-000000000001', '[{"product_id":"33000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'consumer', 'consumer-1', 'consumer-reservation', '61000000-0000-4000-8000-000000000013')$$,
  '42501', 'RESERVATION_LOCATION_FORBIDDEN', 'consumer cannot reserve stock directly without checkout authority'
);
select results_eq($$select count(*)::bigint from public.stock_reservations$$, array[0::bigint], 'consumer sees no reservation owned by others');
reset role;

select throws_ok(
  $$delete from public.stock_reservations where true$$,
  'P0001', 'INVENTORY_HARD_DELETE_FORBIDDEN', 'reservation history cannot be hard deleted'
);
select throws_ok(
  $$update public.stock_reservation_items set quantity = 99 where true$$,
  'P0001', 'IMMUTABLE_RECORD', 'reservation items cannot be rewritten'
);

select * from finish();
rollback;
