begin;
select plan(34);

select has_function(
  'public', 'reverse_confirmed_sale',
  array['uuid', 'text', 'text', 'text', 'uuid'],
  'confirmed sale reversal RPC exists'
);
select ok(
  not has_function_privilege('anon', 'public.reverse_confirmed_sale(uuid,text,text,text,uuid)', 'EXECUTE'),
  'anonymous reversal is denied'
);
select has_index(
  'public', 'financial_ledger_entries', 'financial_ledger_refund_attempt_unique',
  'one refund per payment attempt is enforced'
);

insert into public.inventory_balances (location_id, product_id) values
  ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 5, 'Estoque para testar reversão', 'reversal-stock-1', '65000000-0000-4000-8000-000000000001')$$,
  'admin prepares seller stock through the ledger'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table reversal_checkout as
select public.checkout_sale(
  'PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]'::jsonb,
  'reversal-checkout-1', '65000000-0000-4000-8000-000000000002'
) as result;
create temp table reversal_confirmation as
select public.confirm_manual_payment(
  (select (result ->> 'sale_id')::uuid from reversal_checkout),
  'MAQUININHA', 'NSU-REVERSAL-0001', 'reversal-confirm-1',
  '65000000-0000-4000-8000-000000000003'
) as result;
select results_eq(
  $$select result ->> 'sale_status' from reversal_confirmation$$,
  array['CONFIRMED'::text],
  'seller creates a confirmed sale before reversal'
);
select throws_ok(
  $$select public.reverse_confirmed_sale((select (result ->> 'sale_id')::uuid from reversal_checkout), 'Cliente solicitou estorno integral', 'ESTORNO-SELLER-0001', 'reversal-seller-1', '65000000-0000-4000-8000-000000000004')$$,
  '42501', 'FINANCE_MANAGE_REQUIRED', 'seller cannot reverse a confirmed sale'
);
select throws_ok(
  $$select public.cancel_sale((select (result ->> 'sale_id')::uuid from reversal_checkout), 'reversal-generic-seller', '65000000-0000-4000-8000-000000000005')$$,
  'P0001', 'CONFIRMED_SALE_REVERSAL_REQUIRED', 'seller generic cancellation remains fail closed'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.reverse_confirmed_sale((select (result ->> 'sale_id')::uuid from reversal_checkout), 'Cliente solicitou estorno integral', 'ESTORNO-CONSUMER-0001', 'reversal-consumer-1', '65000000-0000-4000-8000-000000000006')$$,
  '42501', 'FINANCE_MANAGE_REQUIRED', 'consumer cannot reverse a confirmed sale'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.reverse_confirmed_sale((select (result ->> 'sale_id')::uuid from reversal_checkout), 'curto', 'ESTORNO-ADMIN-0001', 'reversal-short-1', '65000000-0000-4000-8000-000000000007')$$,
  '22023', 'INVALID_REVERSAL_REASON', 'short reversal reason is rejected'
);
select throws_ok(
  $$select public.reverse_confirmed_sale((select (result ->> 'sale_id')::uuid from reversal_checkout), 'Cliente solicitou estorno integral', '4111111111111111', 'reversal-pan-1', '65000000-0000-4000-8000-000000000008')$$,
  '22023', 'INVALID_REFUND_REFERENCE', 'PAN-like refund reference is rejected'
);
select lives_ok(
  $$select public.reconcile_payment_attempt((select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reversal_confirmation), 5180, 80, 'SETTLEMENT-REVERSAL-0001', 'MANUAL', 'reversal-reconcile-1', '65000000-0000-4000-8000-000000000009')$$,
  'a reconciled payment remains eligible for a later manual refund'
);

create temp table confirmed_reversal as
select public.reverse_confirmed_sale(
  (select (result ->> 'sale_id')::uuid from reversal_checkout),
  'Cliente solicitou estorno integral', 'ESTORNO-ADMIN-0001',
  'reversal-admin-1', '65000000-0000-4000-8000-000000000010'
) as result;
select results_eq(
  $$select result ->> 'status' from confirmed_reversal$$,
  array['CANCELLED'::text],
  'confirmed reversal returns a cancelled sale'
);
select results_eq(
  $$select result -> 'payment_attempt' ->> 'status' from confirmed_reversal$$,
  array['REFUNDED'::text],
  'confirmed reversal returns a refunded payment'
);
select results_eq(
  $$select status::text from public.sales where id = (select (result ->> 'sale_id')::uuid from reversal_checkout)$$,
  array['CANCELLED'::text],
  'sale becomes cancelled atomically'
);
select results_eq(
  $$select status::text from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from reversal_checkout)$$,
  array['REFUNDED'::text],
  'payment attempt becomes refunded atomically'
);
select results_eq(
  $$select on_hand_quantity, reserved_quantity from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000002' and product_id = '33f00000-0000-4000-8000-000000000001'$$,
  $$values (5::bigint, 0::bigint)$$,
  'reversal restores on-hand stock without recreating a hold'
);
select results_eq(
  $$select status::text from public.stock_reservations where origin_type = 'sale' and origin_id = (select result ->> 'sale_id' from reversal_checkout)$$,
  array['CONSUMED'::text],
  'consumed reservation history is not rewritten'
);
select results_eq(
  $$select count(*)::bigint from public.stock_movements where source_type = 'sale_reversal' and source_id = (select result ->> 'sale_id' from reversal_checkout) and movement_type = 'CANCELAMENTO_VENDA'$$,
  array[1::bigint],
  'reversal creates one compensating stock movement'
);
select results_eq(
  $$select original.movement_type::text, reversal.movement_type::text from public.stock_movements reversal join public.stock_movements original on original.id = reversal.reversal_of where reversal.source_type = 'sale_reversal' and reversal.source_id = (select result ->> 'sale_id' from reversal_checkout)$$,
  $$values ('VENDA'::text, 'CANCELAMENTO_VENDA'::text)$$,
  'stock reversal remains linked to the original sale movement'
);
select results_eq(
  $$select item.quantity from public.stock_movement_items item join public.stock_movements movement on movement.id = item.movement_id where movement.source_type = 'sale_reversal' and movement.source_id = (select result ->> 'sale_id' from reversal_checkout)$$,
  array[2::bigint],
  'stock reversal copies the immutable sold quantity'
);
select results_eq(
  $$select entry_type::text, amount_cents from public.financial_ledger_entries where sale_id = (select (result ->> 'sale_id')::uuid from reversal_checkout) order by case entry_type when 'RECEIVABLE_PICPAY' then 1 when 'FEE' then 2 when 'SETTLEMENT' then 3 when 'REFUND' then 4 else 5 end$$,
  $$values ('RECEIVABLE_PICPAY'::text, 5180::bigint), ('FEE'::text, -80::bigint), ('SETTLEMENT'::text, 5100::bigint), ('REFUND'::text, -5180::bigint)$$,
  'refund is appended without editing receivable, fee or settlement'
);
select results_eq(
  $$select metadata ->> 'refund_reference' from public.financial_ledger_entries where sale_id = (select (result ->> 'sale_id')::uuid from reversal_checkout) and entry_type = 'REFUND'$$,
  array['ESTORNO-ADMIN-0001'::text],
  'refund keeps only the non-sensitive reference'
);
select results_eq(
  $$select from_status::text, to_status::text from public.sale_status_history where sale_id = (select (result ->> 'sale_id')::uuid from reversal_checkout) and from_status = 'CONFIRMED' and to_status = 'CANCELLED'$$,
  $$values ('CONFIRMED'::text, 'CANCELLED'::text)$$,
  'sale history records the confirmed cancellation'
);
select results_eq(
  $$select from_status::text, to_status::text from public.payment_attempt_status_history where attempt_id = (select id from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from reversal_checkout)) and from_status = 'RECONCILED' and to_status = 'REFUNDED'$$,
  $$values ('RECONCILED'::text, 'REFUNDED'::text)$$,
  'payment history records refund after reconciliation'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'sales.confirmed.reversed' and entity_id = (select result ->> 'sale_id' from reversal_checkout)$$,
  array[1::bigint],
  'confirmed reversal is audited once'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where topic = 'sales.confirmed.reversed' and aggregate_id = (select result ->> 'sale_id' from reversal_checkout)$$,
  array[1::bigint],
  'confirmed reversal emits one outbox event'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select public.reverse_confirmed_sale((select (result ->> 'sale_id')::uuid from reversal_checkout), 'Cliente solicitou estorno integral', 'ESTORNO-ADMIN-0001', 'reversal-admin-1', '65000000-0000-4000-8000-000000000099')$$,
  $$select result from confirmed_reversal$$,
  'same key replays the complete reversal result'
);
select results_eq(
  $$select count(*)::bigint from public.stock_movements where source_type = 'sale_reversal' and source_id = (select result ->> 'sale_id' from reversal_checkout)$$,
  array[1::bigint],
  'replay creates no duplicate stock movement'
);
select results_eq(
  $$select count(*)::bigint from public.financial_ledger_entries where sale_id = (select (result ->> 'sale_id')::uuid from reversal_checkout) and entry_type = 'REFUND'$$,
  array[1::bigint],
  'replay creates no duplicate refund'
);
select throws_ok(
  $$select public.reverse_confirmed_sale((select (result ->> 'sale_id')::uuid from reversal_checkout), 'Cliente solicitou estorno integral', 'ESTORNO-ADMIN-0002', 'reversal-admin-1', '65000000-0000-4000-8000-000000000011')$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with another refund reference conflicts'
);
create temp table terminal_replay as
select public.reverse_confirmed_sale(
  (select (result ->> 'sale_id')::uuid from reversal_checkout),
  'Reconsulta administrativa do estorno', 'ESTORNO-ADMIN-0002',
  'reversal-admin-2', '65000000-0000-4000-8000-000000000012'
) as result;
select results_eq(
  $$select result ->> 'status' from terminal_replay$$,
  array['CANCELLED'::text],
  'a new key observes the terminal cancellation without new effects'
);
select results_eq(
  $$select result -> 'reversal' ->> 'refund_reference' from terminal_replay$$,
  array['ESTORNO-ADMIN-0001'::text],
  'terminal replay returns the originally recorded refund reference'
);
reset role;

select throws_ok(
  $$update public.financial_ledger_entries set amount_cents = -1 where entry_type = 'REFUND'$$,
  'P0001', 'IMMUTABLE_RECORD', 'refund ledger entry cannot be edited'
);
select throws_ok(
  $$update public.stock_movements set reason = 'alterado' where movement_type = 'CANCELAMENTO_VENDA'$$,
  'P0001', 'IMMUTABLE_RECORD', 'stock reversal cannot be edited'
);

select * from finish();
rollback;
