begin;
select plan(34);

select has_table('public', 'commercial_reservations', 'commercial reservations table exists');
select has_type('public', 'commercial_reservation_status', 'commercial reservation status exists');
select has_function('public', 'create_commercial_reservation', array['uuid', 'jsonb', 'text', 'uuid'], 'create RPC exists');
select has_function('public', 'cancel_commercial_reservation', array['uuid', 'text', 'uuid'], 'cancel RPC exists');
select has_function('public', 'convert_commercial_reservation', array['uuid', 'text', 'uuid'], 'convert RPC exists');
select ok((select relrowsecurity from pg_class where oid = 'public.commercial_reservations'::regclass), 'RLS is enabled');
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename = 'commercial_reservations' and cmd in ('INSERT','UPDATE','DELETE')$$,
  array[0::bigint], 'no direct write policy exists'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name = 'commercial_reservations' and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint], 'API roles receive no table write grant'
);
select ok(not has_function_privilege('anon', 'public.create_commercial_reservation(uuid,jsonb,text,uuid)', 'EXECUTE'), 'anonymous create is denied');
select ok(not has_function_privilege('anon', 'public.cancel_commercial_reservation(uuid,text,uuid)', 'EXECUTE'), 'anonymous cancel is denied');
select ok(not has_function_privilege('anon', 'public.convert_commercial_reservation(uuid,text,uuid)', 'EXECUTE'), 'anonymous convert is denied');

insert into public.inventory_balances (location_id, product_id) values
  ('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001', 8, 'Reserva comercial', 'commercial-reservation-stock', '72000000-0000-4000-8000-000000000001')$$,
  'admin prepares central stock through the ledger'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
create temp table created_reservation as
select public.create_commercial_reservation(
  '50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]'::jsonb,
  'commercial-create-1', '72000000-0000-4000-8000-000000000002'
) as result;
select results_eq($$select result ->> 'status' from created_reservation$$, array['ACTIVE'::text], 'reservation starts active');
select results_eq(
  $$select extract(epoch from (expires_at - created_at))::integer from public.commercial_reservations where id = (select (result ->> 'reservation_id')::uuid from created_reservation)$$,
  array[600], 'server applies the current ten-minute TTL'
);
reset role;
select results_eq(
  $$select reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '33f00000-0000-4000-8000-000000000001'$$,
  array[2::bigint], 'commercial reservation uses the stock hold balance'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select results_eq(
  $$select origin_type from public.stock_reservations where id = (select (result #>> '{stock_reservation,reservation_id}')::uuid from created_reservation)$$,
  array['commercial_reservation'::text], 'stock hold records its commercial origin'
);
select results_eq(
  $$select public.create_commercial_reservation('50000000-0000-4000-8000-000000000001', '[{"quantity":2,"product_id":"33f00000-0000-4000-8000-000000000001"}]'::jsonb, 'commercial-create-1', '72000000-0000-4000-8000-000000000099')$$,
  $$select result from created_reservation$$, 'same key replays the complete creation result'
);
select throws_ok(
  $$select public.create_commercial_reservation('50000000-0000-4000-8000-000000000001', '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'commercial-create-1', '72000000-0000-4000-8000-000000000003')$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with a different payload conflicts'
);
select throws_ok(
  $$select public.create_commercial_reservation('50000000-0000-4000-8000-000000000001', '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1,"total_cents":1}]'::jsonb, 'commercial-tamper', '72000000-0000-4000-8000-000000000004')$$,
  '22023', 'INVALID_COMMERCIAL_RESERVATION_ITEMS', 'client totals are rejected'
);
create temp table converted_reservation as
select public.convert_commercial_reservation(
  (select (result ->> 'reservation_id')::uuid from created_reservation),
  'commercial-convert-1', '72000000-0000-4000-8000-000000000005'
) as result;
select results_eq($$select result ->> 'status' from converted_reservation$$, array['CONVERTED'::text], 'active reservation converts once');
select results_eq(
  $$select sale.total_cents from public.sales sale join public.commercial_reservations reservation on reservation.converted_sale_id = sale.id where reservation.id = (select (result ->> 'reservation_id')::uuid from created_reservation)$$,
  $$select (result #>> '{quote,total_cents}')::bigint from created_reservation$$, 'conversion uses the frozen quote total'
);
select results_eq(
  $$select origin_type from public.stock_reservations where id = (select (result #>> '{stock_reservation,reservation_id}')::uuid from created_reservation)$$,
  array['sale'::text], 'conversion transfers the existing hold to the sale'
);
select results_eq(
  $$select count(*)::bigint from public.stock_reservations$$, array[1::bigint], 'conversion creates no second stock hold'
);
select results_eq(
  $$select status::text from public.payment_attempts where id = (select (result ->> 'payment_attempt_id')::uuid from converted_reservation)$$,
  array['CREATED'::text], 'conversion creates one provider-neutral payment attempt'
);
select results_eq(
  $$select public.convert_commercial_reservation((select (result ->> 'reservation_id')::uuid from created_reservation), 'commercial-convert-1', '72000000-0000-4000-8000-000000000006')$$,
  $$select result from converted_reservation$$, 'conversion replay is idempotent'
);
select throws_ok(
  $$select public.cancel_commercial_reservation((select (result ->> 'reservation_id')::uuid from created_reservation), 'commercial-cancel-converted', '72000000-0000-4000-8000-000000000007')$$,
  'P0001', 'COMMERCIAL_RESERVATION_ALREADY_CONVERTED', 'converted reservation cannot be cancelled'
);

create temp table cancellable_reservation as
select public.create_commercial_reservation(
  '50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
  'commercial-create-2', '72000000-0000-4000-8000-000000000008'
) as result;
create temp table cancelled_reservation as
select public.cancel_commercial_reservation(
  (select (result ->> 'reservation_id')::uuid from cancellable_reservation),
  'commercial-cancel-1', '72000000-0000-4000-8000-000000000009'
) as result;
select results_eq($$select result ->> 'status' from cancelled_reservation$$, array['CANCELLED'::text], 'active reservation cancels');
reset role;
select results_eq(
  $$select reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '33f00000-0000-4000-8000-000000000001'$$,
  array[2::bigint], 'cancellation releases only its own quantity'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select results_eq(
  $$select public.cancel_commercial_reservation((select (result ->> 'reservation_id')::uuid from cancellable_reservation), 'commercial-cancel-1', '72000000-0000-4000-8000-000000000010')$$,
  $$select result from cancelled_reservation$$, 'cancellation replay is idempotent'
);
reset role;
select results_eq($$select count(*)::bigint from public.audit_logs where action = 'reservations.created'$$, array[2::bigint], 'creation is audited once per reservation');
select results_eq($$select count(*)::bigint from public.outbox_events where topic = 'reservations.converted'$$, array[1::bigint], 'conversion emits one outbox event');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.convert_commercial_reservation((select (result ->> 'reservation_id')::uuid from created_reservation), 'commercial-other-user', '72000000-0000-4000-8000-000000000011')$$,
  'P0001', 'COMMERCIAL_RESERVATION_NOT_FOUND', 'another user cannot convert the reservation'
);
select results_eq($$select count(*)::bigint from public.commercial_reservations$$, array[0::bigint], 'another user cannot read consumer reservations');
reset role;

select throws_ok(
  $$delete from public.commercial_reservations where true$$,
  'P0001', 'INVENTORY_HARD_DELETE_FORBIDDEN', 'commercial reservations cannot be hard deleted'
);

select * from finish();
rollback;
