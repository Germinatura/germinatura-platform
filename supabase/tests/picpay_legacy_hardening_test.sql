-- Spec 5.8 (FIN-001, FIN-003, FIN-007): before the first real PicPay import, the statement-only import is gone and card
-- payments (Maquininha, Tap) are never settled by the manual reconciliation; other channels keep working.
begin;
select plan(17);

-- The statement-only import and preview no longer exist; the private parser and planner are not executable by API roles.
select ok(to_regprocedure('public.import_picpay_statement(text,text,boolean,text,uuid)') is null, 'the legacy statement import is gone');
select ok(to_regprocedure('public.preview_picpay_statement(text)') is null, 'the legacy statement preview is gone');
select ok(not has_function_privilege('authenticated', 'private.parse_picpay_statement(text)', 'EXECUTE'), 'the statement parser is private');
select ok(not has_function_privilege('authenticated', 'private.plan_picpay_statement(text)', 'EXECUTE'), 'the statement planner is private');
select ok(has_function_privilege('authenticated', 'public.import_picpay_file(text,text,text,uuid)', 'EXECUTE'),
  'the PicPay reconciliation import is the supported path');
select ok(has_function_privilege('authenticated', 'public.list_picpay_statement_imports(bigint,integer)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.list_picpay_statement_lines(uuid,boolean,integer,integer)', 'EXECUTE'),
  'statement imports already recorded stay readable');

-- Sales: one paid on the Maquininha, one on the Área Pix.
insert into public.inventory_balances (location_id, product_id)
values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001') on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 3, 'Estoque do hardening', 'hardening-stock', gen_random_uuid())$$,
  'admin prepares stock');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table hardening_sales as select label, (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'hardening-' || label, gen_random_uuid()) ->> 'sale_id')::uuid as sale_id
from unnest(array['card', 'tap', 'pix']) label;
select lives_ok($$select public.confirm_manual_payment(sale_id, (case when label = 'pix' then 'PIX_AREA' else 'MAQUININHA' end)::public.payment_integration_channel,
  'HARDENING-' || upper(label), (case when label = 'pix' then null else 'CREDITO' end)::public.card_payment_method, null, 'hardening-pay-' || label, gen_random_uuid())
  from hardening_sales$$,
  'the three payments are confirmed');
reset role;
create temp table hardening_attempts as select label, attempt.id from hardening_sales join public.payment_attempts attempt using (sale_id);
grant select on hardening_attempts to authenticated;
-- No public command records Tap yet: the test turns one confirmed card payment into Tap to exercise the rule.
set local session_replication_role = replica;
update public.payment_attempts set integration_channel = 'TAP', confirmation_source = 'WEBHOOK', proof_reference = null
  where id = (select id from hardening_attempts where label = 'tap');
set local session_replication_role = origin;
create temp table ledger_before as select count(*) as entries from public.financial_ledger_entries;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.reconcile_payment_attempt((select id from hardening_attempts where label = 'card'), 2590, 59, 'SETTLEMENT-HARDENING-CARD', 'MANUAL', 'hardening-settle-card', gen_random_uuid())$$,
  'P0001', 'PAYMENT_RECONCILIATION_PICPAY_ONLY', 'a Maquininha payment cannot be settled by the manual reconciliation');
select throws_ok($$select public.reconcile_payment_attempt((select id from hardening_attempts where label = 'card'), 2590, 59, 'SETTLEMENT-HARDENING-IMPORT', 'IMPORT', 'hardening-settle-import', gen_random_uuid())$$,
  'P0001', 'PAYMENT_RECONCILIATION_PICPAY_ONLY', 'nor by an import through the same function');
select throws_ok($$select public.reconcile_payment_attempt((select id from hardening_attempts where label = 'tap'), 2590, 59, 'SETTLEMENT-HARDENING-TAP', 'MANUAL', 'hardening-settle-tap', gen_random_uuid())$$,
  'P0001', 'PAYMENT_RECONCILIATION_PICPAY_ONLY', 'a Tap payment cannot be settled by the manual reconciliation');
reset role;
select is((select count(*) from public.payment_reconciliations where payment_attempt_id in (select id from hardening_attempts where label in ('card', 'tap'))),
  0::bigint, 'the refusals record no reconciliation');
select is((select count(*) from public.financial_ledger_entries), (select entries from ledger_before), 'the refusals write no ledger entry');
select is((select string_agg(status::text, ',' order by label) from public.payment_attempts join hardening_attempts using (id) where label in ('card', 'tap')),
  'APPROVED,APPROVED', 'the card payments stay approved, waiting for the PicPay reconciliation');
select is((select count(*) from public.idempotency_keys where key in ('hardening-settle-card', 'hardening-settle-import', 'hardening-settle-tap')),
  0::bigint, 'a refused key is not kept, nothing to replay');

-- The Área Pix still settles through the same function.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is((public.reconcile_payment_attempt((select id from hardening_attempts where label = 'pix'), 2590, 0, 'SETTLEMENT-HARDENING-PIX', 'MANUAL', 'hardening-pix', gen_random_uuid()) ->> 'outcome'),
  'MATCHED', 'an Área Pix payment is still reconciled');
reset role;
select is((select status::text from public.payment_attempts where id = (select id from hardening_attempts where label = 'pix')), 'RECONCILED', 'and reaches RECONCILED');

select * from finish();
rollback;
