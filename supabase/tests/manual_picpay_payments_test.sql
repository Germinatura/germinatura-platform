begin;
select plan(35);

select has_table('public', 'financial_ledger_entries', 'financial ledger table exists');
select has_type('public', 'financial_ledger_entry_type', 'financial ledger entry type exists');
select has_function(
  'public', 'confirm_manual_payment',
  array['uuid', 'public.payment_integration_channel', 'text', 'text', 'uuid'],
  'manual payment confirmation RPC exists'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.financial_ledger_entries'::regclass),
  'financial ledger has RLS enabled'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename = 'financial_ledger_entries' and cmd in ('INSERT', 'UPDATE', 'DELETE')$$,
  array[0::bigint],
  'financial ledger exposes no direct write policies'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name = 'financial_ledger_entries' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint],
  'API roles receive no financial ledger write grants'
);
select ok(
  not has_function_privilege('anon', 'public.confirm_manual_payment(uuid,public.payment_integration_channel,text,text,uuid)', 'EXECUTE'),
  'anonymous confirmation is not executable'
);

insert into public.inventory_balances (location_id, product_id) values
  ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 5, 'Estoque para pagamento manual', 'manual-stock-1', '63000000-0000-4000-8000-000000000001')$$,
  'admin prepares seller stock through the ledger'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table manual_checkout as
select public.checkout_sale(
  'PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]'::jsonb,
  'manual-checkout-1', '63000000-0000-4000-8000-000000000002'
) as result;
select results_eq(
  $$select result ->> 'status' from manual_checkout$$,
  array['AWAITING_PAYMENT'::text],
  'seller creates a pending own sale'
);
select throws_ok(
  $$select public.confirm_manual_payment((select (result ->> 'sale_id')::uuid from manual_checkout), 'TAP', 'TAP-TEST-1', 'manual-confirm-tap', '63000000-0000-4000-8000-000000000003')$$,
  '22023', 'MANUAL_PAYMENT_CHANNEL_UNSUPPORTED', 'Tap remains fail closed'
);
select throws_ok(
  $$select public.confirm_manual_payment((select (result ->> 'sale_id')::uuid from manual_checkout), 'MAQUININHA', '4111111111111111', 'manual-confirm-pan', '63000000-0000-4000-8000-000000000004')$$,
  '22023', 'INVALID_NON_SENSITIVE_PROOF_REFERENCE', 'PAN-like proof reference is rejected'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.confirm_manual_payment((select (result ->> 'sale_id')::uuid from manual_checkout), 'MAQUININHA', 'NSU-FOREIGN-1', 'manual-confirm-foreign', '63000000-0000-4000-8000-000000000005')$$,
  '42501', 'SELLER_REQUIRED', 'consumer cannot confirm a seller payment'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table manual_confirmation as
select public.confirm_manual_payment(
  (select (result ->> 'sale_id')::uuid from manual_checkout),
  'MAQUININHA', 'NSU-MANUAL-0001', 'manual-confirm-1',
  '63000000-0000-4000-8000-000000000006'
) as result;
select results_eq(
  $$select result ->> 'sale_status' from manual_confirmation$$,
  array['CONFIRMED'::text],
  'manual confirmation returns a confirmed sale'
);
select results_eq(
  $$select status::text from public.sales where id = (select (result ->> 'sale_id')::uuid from manual_checkout)$$,
  array['CONFIRMED'::text],
  'sale reaches confirmed state atomically'
);
select results_eq(
  $$select status::text, amount_cents, integration_channel::text, confirmation_source::text, proof_reference, (confirmed_at is not null)::text from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from manual_checkout)$$,
  $$values ('APPROVED'::text, 5180::bigint, 'MAQUININHA'::text, 'MANUAL'::text, 'NSU-MANUAL-0001'::text, 'true'::text)$$,
  'attempt records exact amount, manual source, allowed channel and server instant'
);
select results_eq(
  $$select on_hand_quantity, reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000002' and product_id = '33f00000-0000-4000-8000-000000000001'$$,
  $$values (3::bigint, 0::bigint)$$,
  'confirmation consumes on-hand and reserved stock together'
);
select results_eq(
  $$select status::text, (consumed_at is not null)::text from public.stock_reservations where origin_type = 'sale' and origin_id = (select result ->> 'sale_id' from manual_checkout)$$,
  $$values ('CONSUMED'::text, 'true'::text)$$,
  'sale reservation becomes consumed'
);
select results_eq(
  $$select count(*)::bigint from public.stock_movements where movement_type = 'VENDA' and source_type = 'sale' and source_id = (select result ->> 'sale_id' from manual_checkout)$$,
  array[1::bigint],
  'confirmation creates one final sale movement'
);
select results_eq(
  $$select quantity from public.stock_movement_items where movement_id = (select id from public.stock_movements where source_type = 'sale' and source_id = (select result ->> 'sale_id' from manual_checkout))$$,
  array[2::bigint],
  'sale movement preserves the consumed quantity'
);
reset role;
select results_eq(
  $$select entry_type::text, amount_cents from public.financial_ledger_entries where sale_id = (select (result ->> 'sale_id')::uuid from manual_checkout)$$,
  $$values ('RECEIVABLE_PICPAY'::text, 5180::bigint)$$,
  'manual approval creates the exact PicPay receivable'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select coalesce(from_status::text, 'NULL'), to_status::text from public.payment_attempt_status_history where attempt_id = (select id from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from manual_checkout)) order by from_status nulls first$$,
  $$values ('NULL'::text, 'CREATED'::text), ('CREATED'::text, 'AWAITING_EXTERNAL_CONFIRMATION'::text), ('AWAITING_EXTERNAL_CONFIRMATION'::text, 'APPROVED'::text)$$,
  'payment history labels the external manual confirmation explicitly'
);
select results_eq(
  $$select count(*)::bigint from public.sale_status_history where sale_id = (select (result ->> 'sale_id')::uuid from manual_checkout)$$,
  array[3::bigint],
  'sale history contains draft, awaiting and confirmed states'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'payments.manual.confirmed' and entity_id = (select id::text from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from manual_checkout))$$,
  array[1::bigint],
  'manual confirmation is audited once'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where topic = 'payments.manual.confirmed' and aggregate_id = (select id::text from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from manual_checkout))$$,
  array[1::bigint],
  'manual confirmation emits one outbox event'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select public.confirm_manual_payment((select (result ->> 'sale_id')::uuid from manual_checkout), 'MAQUININHA', 'NSU-MANUAL-0001', 'manual-confirm-1', '63000000-0000-4000-8000-000000000099')$$,
  $$select result from manual_confirmation$$,
  'same confirmation key replays the complete result'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.financial_ledger_entries where sale_id = (select (result ->> 'sale_id')::uuid from manual_checkout)$$,
  array[1::bigint],
  'confirmation replay creates no ledger duplicate'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.confirm_manual_payment((select (result ->> 'sale_id')::uuid from manual_checkout), 'PIX_AREA', 'PIX-MANUAL-0001', 'manual-confirm-1', '63000000-0000-4000-8000-000000000007')$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with another channel conflicts'
);

create temp table second_checkout as
select public.checkout_sale(
  'PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
  'manual-checkout-2', '63000000-0000-4000-8000-000000000008'
) as result;
select results_eq(
  $$select result ->> 'status' from second_checkout$$,
  array['AWAITING_PAYMENT'::text],
  'a second pending sale is available for duplicate-proof abuse testing'
);
select throws_ok(
  $$select public.confirm_manual_payment((select (result ->> 'sale_id')::uuid from second_checkout), 'MAQUININHA', 'NSU-MANUAL-0001', 'manual-confirm-2', '63000000-0000-4000-8000-000000000009')$$,
  'P0001', 'PROOF_REFERENCE_ALREADY_USED', 'one manual proof cannot approve two sales'
);
select results_eq(
  $$select status::text from public.sales where id = (select (result ->> 'sale_id')::uuid from second_checkout)$$,
  array['AWAITING_PAYMENT'::text],
  'duplicate proof rolls the second sale back to pending'
);
select results_eq(
  $$select status::text from public.stock_reservations where origin_type = 'sale' and origin_id = (select result ->> 'sale_id' from second_checkout)$$,
  array['ACTIVE'::text],
  'duplicate proof leaves the second reservation active'
);
select results_eq(
  $$select count(*)::bigint from public.financial_ledger_entries$$,
  array[0::bigint],
  'seller cannot read the financial ledger'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select count(*)::bigint from public.financial_ledger_entries$$,
  array[1::bigint],
  'admin can read the financial ledger'
);
reset role;

select throws_ok(
  $$update public.financial_ledger_entries set amount_cents = 1 where true$$,
  'P0001', 'IMMUTABLE_RECORD', 'financial ledger cannot be updated'
);
select throws_ok(
  $$delete from public.financial_ledger_entries where true$$,
  'P0001', 'IMMUTABLE_RECORD', 'financial ledger cannot be deleted'
);

select * from finish();
rollback;
