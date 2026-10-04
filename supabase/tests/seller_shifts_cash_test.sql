-- PAY-009: seller shift, cash payment with change in cents and counted close.
begin;
select plan(30);

select has_table('public','seller_shifts','seller shifts exist');
select has_table('public','cash_movements','drawer ledger exists');
select ok(not has_function_privilege('anon','public.confirm_cash_payment(uuid,bigint,text,uuid)','EXECUTE'),'anonymous cannot confirm cash');
select ok(not has_table_privilege('authenticated','public.cash_movements','INSERT'),'drawer ledger denies direct insert');
select ok(not has_table_privilege('authenticated','public.seller_shifts','UPDATE'),'shifts deny direct update');

insert into public.inventory_balances(location_id,product_id)
values('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001')
on conflict (location_id,product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',5,'Estoque turno','shift-stock','67000000-0000-4000-8000-000000000001')$$,'admin prepares seller stock');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000002',0,'shift-consumer','67000000-0000-4000-8000-000000000002')$$,'42501','SELLER_REQUIRED','consumer cannot open a shift');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000001',0,'shift-central','67000000-0000-4000-8000-000000000003')$$,'42501','SELLER_SHIFT_LOCATION_FORBIDDEN','seller cannot open a shift at the central location');
create temp table sale_before as select public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'shift-sale-0','67000000-0000-4000-8000-000000000004') result;
select throws_ok($$select public.confirm_cash_payment((select (result->>'sale_id')::uuid from sale_before),3000,'shift-cash-0','67000000-0000-4000-8000-000000000005')$$,'P0001','SELLER_SHIFT_REQUIRED','cash needs an open shift');
create temp table shift as select public.open_seller_shift('50000000-0000-4000-8000-000000000002',1000,'shift-open','67000000-0000-4000-8000-000000000006') result;
select is((select result->>'status' from shift),'OPEN','seller opens a shift');
select is((select (result->>'expected_cash_cents')::bigint from shift),1000::bigint,'opening float starts the drawer');
select is((public.open_seller_shift('50000000-0000-4000-8000-000000000002',1000,'shift-open','67000000-0000-4000-8000-000000000006')->>'shift_id'),(select result->>'shift_id' from shift),'opening replay is idempotent');
select throws_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000002',0,'shift-open-2','67000000-0000-4000-8000-000000000007')$$,'P0001','SELLER_SHIFT_ALREADY_OPEN','only one open shift per seller');

select throws_ok($$select public.confirm_cash_payment((select (result->>'sale_id')::uuid from sale_before),2000,'shift-cash-short','67000000-0000-4000-8000-000000000008')$$,'P0001','CASH_TENDERED_INSUFFICIENT','tendered cash must cover the total');
-- R$ 25,90 paid with R$ 50,00: change R$ 24,10.
create temp table cash as select public.confirm_cash_payment((select (result->>'sale_id')::uuid from sale_before),5000,'shift-cash-1','67000000-0000-4000-8000-000000000009') result;
select is((select result->>'sale_status' from cash),'CONFIRMED','cash confirms the sale');
select is((select (result->'cash'->>'change_cents')::bigint from cash),2410::bigint,'change is computed in cents');
select is((select result->'payment_attempt'->>'integration_channel' from cash),'DINHEIRO','cash is an internal channel');
select is((public.confirm_cash_payment((select (result->>'sale_id')::uuid from sale_before),5000,'shift-cash-1','67000000-0000-4000-8000-000000000009')->>'financial_ledger_entry_id'),
  (select result->>'financial_ledger_entry_id' from cash),'cash confirmation replay is idempotent');
select is((public.get_my_seller_shift()->>'expected_cash_cents')::bigint,3590::bigint,'drawer expects float plus the sale total, not the tendered amount');
select is((public.get_my_seller_shift()->>'cash_sales_count')::integer,1,'shift counts the cash sale');
reset role;

select is((select entry_type::text||':'||amount_cents from public.financial_ledger_entries where id=(select (result->>'financial_ledger_entry_id')::uuid from cash)),'CASH_RECEIPT:2590','ledger records a cash receipt, not a PicPay receivable');
select is((select proof_reference from public.payment_attempts where id=(select (result->'payment_attempt'->>'attempt_id')::uuid from cash)),null,'cash needs no proof reference');
select is((select status::text from public.sales where id=(select (result->>'sale_id')::uuid from cash)),'CONFIRMED','sale is confirmed');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select is((select count(*)::integer from public.seller_shifts),0,'consumer cannot read shifts');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.close_seller_shift((select (result->>'shift_id')::uuid from shift),3500,null,'shift-close-bad','67000000-0000-4000-8000-000000000010')$$,'P0001','SELLER_SHIFT_JUSTIFICATION_REQUIRED','a divergence needs a justification');
create temp table closed as select public.close_seller_shift((select (result->>'shift_id')::uuid from shift),3500,'Troco dado a mais em uma venda','shift-close','67000000-0000-4000-8000-000000000011') result;
select is((select (result->>'difference_cents')::bigint from closed),-90::bigint,'close records the counted difference');
select is(public.get_my_seller_shift(),null,'no open shift after closing');
create temp table sale_after as select public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'shift-sale-2','67000000-0000-4000-8000-000000000012') result;
select throws_ok($$select public.confirm_cash_payment((select (result->>'sale_id')::uuid from sale_after),3000,'shift-cash-2','67000000-0000-4000-8000-000000000013')$$,'P0001','SELLER_SHIFT_REQUIRED','no cash after the shift is closed');
reset role;

select throws_ok($$update public.seller_shifts set counted_cash_cents=3590 where id=(select (result->>'shift_id')::uuid from shift)$$,'P0001','SELLER_SHIFT_TRANSITION_INVALID','a closed shift cannot be rewritten');
select throws_ok($$delete from public.cash_movements where shift_id=(select (result->>'shift_id')::uuid from shift)$$,'P0001','IMMUTABLE_RECORD','drawer ledger is immutable');

select * from finish();
rollback;
