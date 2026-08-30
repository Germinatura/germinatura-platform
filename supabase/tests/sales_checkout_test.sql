begin;
select plan(72);

select has_table('public', 'payment_attempts', 'payment attempts table exists');
select has_table('public', 'payment_attempt_status_history', 'payment attempt history table exists');
select has_type('public', 'payment_attempt_status', 'payment attempt status type exists');
select has_type('public', 'payment_integration_channel', 'payment channel type exists');
select has_type('public', 'payment_confirmation_source', 'confirmation source type exists');
select has_function(
  'public', 'checkout_sale',
  array['public.promotion_channel', 'uuid', 'jsonb', 'text', 'uuid'],
  'transactional checkout RPC exists'
);
select has_function(
  'public', 'cancel_sale', array['uuid', 'text', 'uuid'],
  'pending sale cancellation RPC exists'
);
select has_function(
  'private', 'transition_payment_attempt',
  array['uuid', 'public.payment_attempt_status', 'uuid', 'uuid', 'text'],
  'payment attempt transition helper exists'
);
select has_function(
  'private', 'price_sale_items', array['public.promotion_channel', 'jsonb'],
  'database pricing snapshot helper exists'
);
select has_function(
  'private', 'reserve_stock_for_sale', array['uuid', 'uuid', 'jsonb', 'uuid', 'uuid'],
  'sale reservation helper exists'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.payment_attempts'::regclass),
  'payment attempts have RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.payment_attempt_status_history'::regclass),
  'payment attempt history has RLS enabled'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename = 'payment_attempts' and cmd in ('INSERT', 'UPDATE', 'DELETE')$$,
  array[0::bigint],
  'payment attempts expose no direct write policies'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name = 'payment_attempts' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint],
  'API roles receive no payment attempt write grants'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename = 'payment_attempt_status_history' and cmd in ('INSERT', 'UPDATE', 'DELETE')$$,
  array[0::bigint],
  'payment attempt history exposes no direct write policies'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name = 'payment_attempt_status_history' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint],
  'API roles receive no payment attempt history write grants'
);
select ok(
  not has_function_privilege('anon', 'public.checkout_sale(public.promotion_channel,uuid,jsonb,text,uuid)', 'EXECUTE'),
  'anonymous checkout is not executable'
);
select ok(
  not has_function_privilege('anon', 'public.cancel_sale(uuid,text,uuid)', 'EXECUTE'),
  'anonymous cancellation is not executable'
);

insert into public.inventory_balances (location_id, product_id) values
  ('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;

insert into public.promotions (
  id, code, name, active, publicable, priority, valid_from, valid_to
) values (
  '61000000-0000-4000-8000-000000000010', 'CHECKOUT-QTY', 'Duas por quarenta',
  true, true, 100, now() - interval '1 day', now() + interval '1 day'
);
insert into public.promotion_products (promotion_id, product_id) values
  ('61000000-0000-4000-8000-000000000010', '33f00000-0000-4000-8000-000000000001');
insert into public.promotion_channels (promotion_id, channel) values
  ('61000000-0000-4000-8000-000000000010', 'PDV'),
  ('61000000-0000-4000-8000-000000000010', 'PORTAL');
insert into public.promotion_quantity_price_rules (
  promotion_id, group_quantity, group_price_cents
) values ('61000000-0000-4000-8000-000000000010', 2, 4000);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001', 10, 'Checkout central', 'checkout-stock-central', '62000000-0000-4000-8000-000000000001')$$,
  'admin prepares central stock through the ledger'
);
select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 10, 'Checkout vendedor', 'checkout-stock-seller', '62000000-0000-4000-8000-000000000002')$$,
  'admin prepares seller stock through the ledger'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table seller_checkout as
select public.checkout_sale(
  'PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":3}]'::jsonb,
  'checkout-seller-1', '62000000-0000-4000-8000-000000000003'
) as result;
select results_eq(
  $$select (result #>> '{quote,total_cents}')::bigint from seller_checkout$$,
  array[6590::bigint],
  'checkout recalculates the quantity promotion in integer cents'
);
select results_eq(
  $$select status::text from public.sales where id = (select (result ->> 'sale_id')::uuid from seller_checkout)$$,
  array['AWAITING_PAYMENT'::text],
  'checkout advances the sale only to awaiting payment'
);
select results_eq(
  $$select promotion_id, discount_cents from public.sale_items where sale_id = (select (result ->> 'sale_id')::uuid from seller_checkout)$$,
  $$values ('61000000-0000-4000-8000-000000000010'::uuid, 1180::bigint)$$,
  'sale item freezes the selected promotion and discount'
);
select results_eq(
  $$select reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000002' and product_id = '33f00000-0000-4000-8000-000000000001'$$,
  array[3::bigint],
  'checkout reserves seller stock without consuming on-hand quantity'
);
select results_eq(
  $$select status::text, amount_cents from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from seller_checkout)$$,
  $$values ('CREATED'::text, 6590::bigint)$$,
  'provider-neutral payment attempt uses the authoritative total'
);
select results_eq(
  $$select count(*)::bigint from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from seller_checkout) and integration_channel is null and confirmation_source is null$$,
  array[1::bigint],
  'checkout does not invent a PicPay channel or confirmation source'
);
select results_eq(
  $$select count(*)::bigint from public.sale_status_history where sale_id = (select (result ->> 'sale_id')::uuid from seller_checkout)$$,
  array[2::bigint],
  'checkout records draft and awaiting-payment history'
);
select results_eq(
  $$select from_status::text, to_status::text from public.payment_attempt_status_history where attempt_id = (select id from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from seller_checkout))$$,
  $$values (null::text, 'CREATED'::text)$$,
  'checkout records the initial provider-neutral payment state'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'payments.attempt.created'$$,
  array[1::bigint],
  'payment attempt creation is audited'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where topic = 'payments.attempt.created'$$,
  array[1::bigint],
  'payment attempt creation emits an outbox event'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002', '[{"quantity":3,"product_id":"33f00000-0000-4000-8000-000000000001"}]'::jsonb, 'checkout-seller-1', '62000000-0000-4000-8000-000000000099')$$,
  $$select result from seller_checkout$$,
  'same key replays the complete checkout result'
);
select results_eq($$select count(*)::bigint from public.sales$$, array[1::bigint], 'checkout replay creates no sale duplicate');
select results_eq($$select count(*)::bigint from public.stock_reservations where origin_type = 'sale'$$, array[1::bigint], 'checkout replay creates no reservation duplicate');
select results_eq($$select count(*)::bigint from public.payment_attempts$$, array[1::bigint], 'checkout replay creates no payment attempt duplicate');
select throws_ok(
  $$select public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002', '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]'::jsonb, 'checkout-seller-1', '62000000-0000-4000-8000-000000000004')$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with a different quantity conflicts'
);
select throws_ok(
  $$select public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002', '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":100}]'::jsonb, 'checkout-no-stock', '62000000-0000-4000-8000-000000000005')$$,
  'P0001', 'STOCK_CONFLICT', 'insufficient stock aborts the checkout'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.idempotency_keys where key = 'checkout-no-stock'$$,
  array[0::bigint],
  'failed checkout leaves no orphan idempotency record'
);
select results_eq($$select count(*)::bigint from public.sales$$, array[1::bigint], 'failed checkout rolls back the sale');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000001', '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'checkout-seller-central', '62000000-0000-4000-8000-000000000006')$$,
  '42501', 'SALE_LOCATION_FORBIDDEN', 'seller cannot checkout against central stock'
);
select throws_ok(
  $$select public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002', '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1,"total_cents":1}]'::jsonb, 'checkout-tampered', '62000000-0000-4000-8000-000000000007')$$,
  '22023', 'INVALID_SALE_ITEMS', 'database rejects extra financial fields inside an item'
);
reset role;

select throws_ok(
  $$insert into public.payment_attempts (sale_id, status, amount_cents, operator_id, idempotency_key, correlation_id) values ((select (result ->> 'sale_id')::uuid from seller_checkout), 'APPROVED', 6590, '10000000-0000-4000-8000-000000000002', 'illegal-attempt', '62000000-0000-4000-8000-000000000008')$$,
  'P0001', 'PAYMENT_ATTEMPT_MUST_START_CREATED', 'attempt cannot be inserted as approved'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.checkout_sale('PORTAL', '50000000-0000-4000-8000-000000000002', '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'checkout-consumer-seller', '62000000-0000-4000-8000-000000000009')$$,
  '42501', 'SALE_LOCATION_FORBIDDEN', 'consumer cannot checkout against seller stock'
);
create temp table consumer_checkout as
select public.checkout_sale(
  'PORTAL', '50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]'::jsonb,
  'checkout-consumer-1', '62000000-0000-4000-8000-000000000010'
) as result;
select results_eq(
  $$select result ->> 'status' from consumer_checkout$$,
  array['AWAITING_PAYMENT'::text],
  'consumer checkout reaches awaiting payment'
);
reset role;
select results_eq(
  $$select reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000001' and product_id = '33f00000-0000-4000-8000-000000000001'$$,
  array[2::bigint],
  'consumer checkout reserves central stock'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select results_eq($$select count(*)::bigint from public.sales$$, array[1::bigint], 'consumer sees only their own sale');
select results_eq($$select count(*)::bigint from public.payment_attempts$$, array[1::bigint], 'consumer sees only their own payment attempt');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq($$select count(*)::bigint from public.sales$$, array[1::bigint], 'seller still sees only their own sale');
select results_eq($$select count(*)::bigint from public.payment_attempts$$, array[1::bigint], 'seller still sees only their own payment attempt');
select throws_ok(
  $$update public.payment_attempts set status = 'APPROVED' where true$$,
  '42501', null, 'seller cannot update a payment attempt directly'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq($$select count(*)::bigint from public.sales$$, array[2::bigint], 'admin can read both checkouts');
reset role;

select results_eq(
  $$select count(*)::bigint from public.stock_reservations where origin_type = 'sale'$$,
  array[2::bigint],
  'successful checkouts create exactly one reservation each'
);
select throws_ok(
  $$delete from public.payment_attempts where true$$,
  'P0001', 'PAYMENT_ATTEMPT_HARD_DELETE_FORBIDDEN', 'payment attempts cannot be hard deleted'
);
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'payments.attempt.created'$$,
  array[2::bigint],
  'both payment attempts remain audited'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where topic = 'payments.attempt.created'$$,
  array[2::bigint],
  'both payment attempts remain in the outbox'
);
select results_eq(
  $$select amount_cents from public.payment_attempts order by amount_cents$$,
  array[4000::bigint, 6590::bigint],
  'attempt amounts match server pricing for both channels'
);
select results_eq(
  $$select count(*)::bigint from public.idempotency_keys where scope like 'sales.checkout:%' and status = 'SUCCEEDED'$$,
  array[2::bigint],
  'each successful checkout has one completed outer idempotency record'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.cancel_sale((select (result ->> 'sale_id')::uuid from seller_checkout), 'cancel-foreign-sale', '62000000-0000-4000-8000-000000000011')$$,
  'P0001', 'SALE_NOT_FOUND', 'consumer cannot cancel another operator sale'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.release_stock_reservation((select (result #>> '{reservation,reservation_id}')::uuid from seller_checkout), 'release-sale-directly', '62000000-0000-4000-8000-000000000017')$$,
  'P0001', 'SALE_RESERVATION_RELEASE_REQUIRES_CANCELLATION', 'sale holds cannot bypass aggregate cancellation'
);
create temp table seller_cancel as
select public.cancel_sale(
  (select (result ->> 'sale_id')::uuid from seller_checkout),
  'cancel-seller-1', '62000000-0000-4000-8000-000000000012'
) as result;
select results_eq(
  $$select result ->> 'status' from seller_cancel$$,
  array['CANCELLED'::text],
  'seller can cancel their own pending sale'
);
select results_eq(
  $$select reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000002' and product_id = '33f00000-0000-4000-8000-000000000001'$$,
  array[0::bigint],
  'pending cancellation releases reserved inventory'
);
select results_eq(
  $$select status::text, (release_movement_id is not null)::text from public.stock_reservations where origin_type = 'sale' and origin_id = (select result ->> 'sale_id' from seller_checkout)$$,
  $$values ('RELEASED'::text, 'true'::text)$$,
  'sale reservation records one terminal release'
);
select results_eq(
  $$select status::text from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from seller_checkout)$$,
  array['CANCELLED'::text],
  'pending payment attempt is cancelled atomically'
);
select results_eq(
  $$select coalesce(from_status::text, 'NULL'), to_status::text from public.payment_attempt_status_history where attempt_id = (select id from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from seller_checkout)) order by from_status nulls first$$,
  $$values ('NULL'::text, 'CREATED'::text), ('CREATED'::text, 'CANCELLED'::text)$$,
  'payment history preserves the complete cancellation transition'
);
select results_eq(
  $$select coalesce(from_status::text, 'NULL'), to_status::text from public.sale_status_history where sale_id = (select (result ->> 'sale_id')::uuid from seller_checkout) order by from_status nulls first$$,
  $$values ('NULL'::text, 'DRAFT'::text), ('DRAFT'::text, 'AWAITING_PAYMENT'::text), ('AWAITING_PAYMENT'::text, 'CANCELLED'::text)$$,
  'sale history preserves draft, awaiting and cancelled states'
);
select results_eq(
  $$select public.cancel_sale((select (result ->> 'sale_id')::uuid from seller_checkout), 'cancel-seller-1', '62000000-0000-4000-8000-000000000099')$$,
  $$select result from seller_cancel$$,
  'same cancellation key replays the complete result'
);
select results_eq(
  $$select count(*)::bigint from public.stock_movements where source_type = 'stock_reservation' and source_id = (select id::text from public.stock_reservations where origin_type = 'sale' and origin_id = (select result ->> 'sale_id' from seller_checkout)) and movement_type = 'LIBERACAO_RESERVA'$$,
  array[1::bigint],
  'cancellation replay creates no duplicate inventory release'
);
select results_eq(
  $$select public.cancel_sale((select (result ->> 'sale_id')::uuid from seller_checkout), 'cancel-seller-2', '62000000-0000-4000-8000-000000000013') ->> 'status'$$,
  array['CANCELLED'::text],
  'a new cancellation key remains an effect-free terminal no-op'
);
select results_eq(
  $$select count(*)::bigint from public.payment_attempt_status_history where attempt_id = (select id from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from seller_checkout))$$,
  array[2::bigint],
  'terminal cancellation creates no duplicate payment history'
);
select results_eq(
  $$select count(*)::bigint from public.sale_status_history where sale_id = (select (result ->> 'sale_id')::uuid from seller_checkout)$$,
  array[3::bigint],
  'terminal cancellation creates no duplicate sale history'
);
reset role;

select throws_ok(
  $$delete from public.payment_attempt_status_history where true$$,
  'P0001', 'IMMUTABLE_RECORD', 'payment attempt history cannot be deleted'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table confirmed_checkout as
select public.checkout_sale(
  'PDV', '50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
  'checkout-confirmed-1', '62000000-0000-4000-8000-000000000014'
) as result;
reset role;
select lives_ok(
  $$select private.transition_sale_state((select (result ->> 'sale_id')::uuid from confirmed_checkout), 'CONFIRMED', '10000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000015', 'Fixture de venda confirmada')$$,
  'confirmed fixture reaches the protected terminal state'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.cancel_sale((select (result ->> 'sale_id')::uuid from confirmed_checkout), 'cancel-confirmed-1', '62000000-0000-4000-8000-000000000016')$$,
  'P0001', 'CONFIRMED_SALE_REVERSAL_REQUIRED', 'confirmed sale cancellation remains fail closed'
);
reset role;

select * from finish();
rollback;
