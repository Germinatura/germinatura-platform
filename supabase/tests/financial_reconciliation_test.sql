begin;
select plan(41);

select has_table('public', 'payment_reconciliations', 'payment reconciliation table exists');
select has_type('public', 'payment_reconciliation_outcome', 'reconciliation outcome type exists');
select has_type('public', 'payment_reconciliation_source', 'reconciliation source type exists');
select has_function(
  'public', 'reconcile_payment_attempt',
  array['uuid', 'bigint', 'bigint', 'text', 'public.payment_reconciliation_source', 'text', 'uuid'],
  'reconciliation RPC exists'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.payment_reconciliations'::regclass),
  'payment reconciliations have RLS enabled'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename = 'payment_reconciliations' and cmd in ('INSERT', 'UPDATE', 'DELETE')$$,
  array[0::bigint],
  'reconciliations expose no direct write policies'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name = 'payment_reconciliations' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint],
  'API roles receive no reconciliation write grants'
);
select ok(
  not has_function_privilege('anon', 'public.reconcile_payment_attempt(uuid,bigint,bigint,text,public.payment_reconciliation_source,text,uuid)', 'EXECUTE'),
  'anonymous reconciliation is not executable'
);

insert into public.inventory_balances (location_id, product_id) values
  ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 4, 'Estoque para conciliação', 'reconciliation-stock-1', '64000000-0000-4000-8000-000000000001')$$,
  'admin prepares stock through the ledger'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table reconciliation_checkout as
select public.checkout_sale(
  'PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
  'reconciliation-checkout-1', '64000000-0000-4000-8000-000000000002'
) as result;
select results_eq(
  $$select result ->> 'status' from reconciliation_checkout$$,
  array['AWAITING_PAYMENT'::text],
  'seller creates a pending sale'
);
create temp table reconciliation_confirmation as
select public.confirm_manual_payment(
  (select (result ->> 'sale_id')::uuid from reconciliation_checkout),
  'PIX_AREA', 'PIX-RECONCILIATION-0001', 'reconciliation-confirm-1',
  '64000000-0000-4000-8000-000000000003'
) as result;
select results_eq(
  $$select result -> 'payment_attempt' ->> 'status' from reconciliation_confirmation$$,
  array['APPROVED'::text],
  'manual payment becomes approved before reconciliation'
);
select throws_ok(
  $$select public.reconcile_payment_attempt((select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation), 2590, 50, 'SETTLEMENT-SELLER-0001', 'MANUAL', 'reconciliation-seller-1', '64000000-0000-4000-8000-000000000004')$$,
  '42501', 'FINANCE_MANAGE_REQUIRED', 'seller cannot reconcile payments'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.reconcile_payment_attempt((select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation), 2590, 50, 'SETTLEMENT-CONSUMER-0001', 'MANUAL', 'reconciliation-consumer-1', '64000000-0000-4000-8000-000000000005')$$,
  '42501', 'FINANCE_MANAGE_REQUIRED', 'consumer cannot reconcile payments'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.reconcile_payment_attempt((select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation), 0, 0, 'SETTLEMENT-ZERO-0001', 'MANUAL', 'reconciliation-zero-1', '64000000-0000-4000-8000-000000000006')$$,
  '22023', 'INVALID_RECONCILIATION_AMOUNTS', 'zero observed amount is rejected'
);
select throws_ok(
  $$select public.reconcile_payment_attempt((select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation), 2590, 2590, 'SETTLEMENT-ZERONET-0001', 'MANUAL', 'reconciliation-zeronet-1', '64000000-0000-4000-8000-000000000007')$$,
  '22023', 'INVALID_RECONCILIATION_AMOUNTS', 'fee cannot consume the full observed amount'
);
select throws_ok(
  $$select public.reconcile_payment_attempt((select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation), 2590, 50, '4111111111111111', 'MANUAL', 'reconciliation-pan-1', '64000000-0000-4000-8000-000000000008')$$,
  '22023', 'INVALID_RECONCILIATION_REFERENCE', 'PAN-like reconciliation reference is rejected'
);
select throws_ok(
  $$select public.reconcile_payment_attempt((select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation), 2590, 50, 'SETTLEMENT-NOSOURCE-0001', null, 'reconciliation-nosource-1', '64000000-0000-4000-8000-000000000015')$$,
  '22023', 'INVALID_RECONCILIATION_SOURCE', 'reconciliation source is mandatory'
);

create temp table divergent_reconciliation as
select public.reconcile_payment_attempt(
  (select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation),
  2500, 50, 'SETTLEMENT-DIVERGENT-0001', 'MANUAL', 'reconciliation-divergent-1',
  '64000000-0000-4000-8000-000000000009'
) as result;
select results_eq(
  $$select result ->> 'outcome', result ->> 'payment_status' from divergent_reconciliation$$,
  $$values ('DIVERGENT'::text, 'RECONCILIATION_PENDING'::text)$$,
  'amount mismatch creates a pending divergence'
);
select results_eq(
  $$select status::text from public.payment_attempts where id = (select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation)$$,
  array['RECONCILIATION_PENDING'::text],
  'divergence advances payment to reconciliation pending'
);
select results_eq(
  $$select expected_amount_cents, observed_amount_cents, fee_amount_cents, net_amount_cents, outcome::text, source::text from public.payment_reconciliations where id = (select (result ->> 'reconciliation_id')::uuid from divergent_reconciliation)$$,
  $$values (2590::bigint, 2500::bigint, 50::bigint, 2450::bigint, 'DIVERGENT'::text, 'MANUAL'::text)$$,
  'divergence preserves expected, observed, fee and net snapshots'
);
select results_eq(
  $$select entry_type::text, amount_cents from public.financial_ledger_entries where reconciliation_id = (select (result ->> 'reconciliation_id')::uuid from divergent_reconciliation)$$,
  $$values ('DIVERGENCE'::text, -90::bigint)$$,
  'divergence appends the signed difference to the ledger'
);
select results_eq(
  $$select count(*)::bigint from public.financial_ledger_entries where reconciliation_id = (select (result ->> 'reconciliation_id')::uuid from divergent_reconciliation) and entry_type in ('FEE', 'SETTLEMENT')$$,
  array[0::bigint],
  'divergence creates no fee or settlement'
);
select results_eq(
  $$select public.reconcile_payment_attempt((select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation), 2500, 50, 'SETTLEMENT-DIVERGENT-0001', 'MANUAL', 'reconciliation-divergent-1', '64000000-0000-4000-8000-000000000099')$$,
  $$select result from divergent_reconciliation$$,
  'same reconciliation key replays the stored result'
);
select results_eq(
  $$select count(*)::bigint from public.payment_reconciliations where external_reference = 'SETTLEMENT-DIVERGENT-0001'$$,
  array[1::bigint],
  'replay creates no duplicate observation'
);
select throws_ok(
  $$select public.reconcile_payment_attempt((select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation), 2590, 50, 'SETTLEMENT-DIVERGENT-0001', 'MANUAL', 'reconciliation-divergent-1', '64000000-0000-4000-8000-000000000010')$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with another amount conflicts'
);

create temp table matched_reconciliation as
select public.reconcile_payment_attempt(
  (select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation),
  2590, 59, 'SETTLEMENT-MATCHED-0001', 'MANUAL', 'reconciliation-matched-1',
  '64000000-0000-4000-8000-000000000011'
) as result;
select results_eq(
  $$select result ->> 'outcome', result ->> 'payment_status' from matched_reconciliation$$,
  $$values ('MATCHED'::text, 'RECONCILED'::text)$$,
  'matching observation resolves the pending payment'
);
select results_eq(
  $$select status::text from public.payment_attempts where id = (select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation)$$,
  array['RECONCILED'::text],
  'matching observation advances payment to reconciled'
);
select results_eq(
  $$select expected_amount_cents, observed_amount_cents, fee_amount_cents, net_amount_cents, outcome::text from public.payment_reconciliations where id = (select (result ->> 'reconciliation_id')::uuid from matched_reconciliation)$$,
  $$values (2590::bigint, 2590::bigint, 59::bigint, 2531::bigint, 'MATCHED'::text)$$,
  'matched reconciliation freezes exact financial values'
);
select results_eq(
  $$select entry_type::text, amount_cents from public.financial_ledger_entries where reconciliation_id = (select (result ->> 'reconciliation_id')::uuid from matched_reconciliation) order by case entry_type when 'FEE' then 1 else 2 end$$,
  $$values ('FEE'::text, -59::bigint), ('SETTLEMENT'::text, 2531::bigint)$$,
  'match appends fee and net settlement entries'
);
select results_eq(
  $$select from_status::text, to_status::text from public.payment_attempt_status_history where attempt_id = (select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from reconciliation_confirmation) and to_status in ('RECONCILIATION_PENDING', 'RECONCILED') order by created_at, id$$,
  $$values ('APPROVED'::text, 'RECONCILIATION_PENDING'::text), ('RECONCILIATION_PENDING'::text, 'RECONCILED'::text)$$,
  'history preserves divergence and resolution transitions'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'finance.payment.reconciled' and metadata ->> 'attempt_id' = (select result -> 'payment_attempt' ->> 'attempt_id' from reconciliation_confirmation)$$,
  array[2::bigint],
  'each new reconciliation is audited once'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where topic = 'finance.payment.reconciled' and payload ->> 'attempt_id' = (select result -> 'payment_attempt' ->> 'attempt_id' from reconciliation_confirmation)$$,
  array[2::bigint],
  'each new reconciliation emits one outbox event'
);

select throws_ok(
  $$update public.payment_reconciliations set observed_amount_cents = 1 where true$$,
  'P0001', 'IMMUTABLE_RECORD', 'reconciliation observations cannot be updated'
);
select throws_ok(
  $$delete from public.payment_reconciliations where true$$,
  'P0001', 'IMMUTABLE_RECORD', 'reconciliation observations cannot be deleted'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select count(*)::bigint from public.payment_reconciliations$$,
  array[0::bigint],
  'seller cannot read reconciliation observations'
);
select results_eq(
  $$select count(*)::bigint from public.financial_ledger_entries$$,
  array[0::bigint],
  'seller cannot read financial entries'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select count(*)::bigint from public.payment_reconciliations$$,
  array[2::bigint],
  'admin can read reconciliation observations'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table second_reconciliation_checkout as
select public.checkout_sale(
  'PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
  'reconciliation-checkout-2', '64000000-0000-4000-8000-000000000012'
) as result;
select results_eq(
  $$select result ->> 'status' from second_reconciliation_checkout$$,
  array['AWAITING_PAYMENT'::text],
  'seller creates a second sale for duplicate reference testing'
);
create temp table second_reconciliation_confirmation as
select public.confirm_manual_payment(
  (select (result ->> 'sale_id')::uuid from second_reconciliation_checkout),
  'MAQUININHA', 'NSU-RECONCILIATION-0002', 'reconciliation-confirm-2',
  '64000000-0000-4000-8000-000000000013'
) as result;
select results_eq(
  $$select result -> 'payment_attempt' ->> 'status' from second_reconciliation_confirmation$$,
  array['APPROVED'::text],
  'second payment is approved'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.reconcile_payment_attempt((select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from second_reconciliation_confirmation), 2590, 59, 'SETTLEMENT-MATCHED-0001', 'MANUAL', 'reconciliation-duplicate-ref-1', '64000000-0000-4000-8000-000000000014')$$,
  'P0001', 'RECONCILIATION_REFERENCE_ALREADY_USED', 'one external reference cannot reconcile two attempts'
);
select results_eq(
  $$select status::text from public.payment_attempts where id = (select (result -> 'payment_attempt' ->> 'attempt_id')::uuid from second_reconciliation_confirmation)$$,
  array['APPROVED'::text],
  'duplicate external reference rolls the second reconciliation back'
);
reset role;

select * from finish();
rollback;
