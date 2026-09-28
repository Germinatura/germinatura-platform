-- PAY-009a: physical cash refunds are new negative drawer movements; closed shifts never change.
begin;
select plan(30);

select has_function('public','reverse_confirmed_sale',array['uuid','text','text','uuid','text','uuid'],'reversal accepts a payout shift');
select ok(not has_function_privilege('anon','public.reverse_confirmed_sale(uuid,text,text,uuid,text,uuid)','EXECUTE'),'anonymous cannot reverse');

insert into public.inventory_balances(location_id,product_id)
values('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001')
on conflict (location_id,product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',5,'Estoque estorno em dinheiro','payout-stock','68000000-0000-4000-8000-000000000001')$$,'admin prepares seller stock');

-- Seller: shift A with R$ 10,00 float and three cash sales of R$ 25,90.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table shift_a as select public.open_seller_shift('50000000-0000-4000-8000-000000000002',1000,'payout-open-a','68000000-0000-4000-8000-000000000002') result;
create temp table payout_sales(label text primary key, sale_id uuid);
insert into payout_sales select label, (public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'payout-sale-'||label,gen_random_uuid())->>'sale_id')::uuid
from unnest(array['a','b','c']) label;
select lives_ok($$select public.confirm_cash_payment(sale_id,3000,'payout-cash-'||label,gen_random_uuid()) from payout_sales order by label$$,'three sales are paid in cash');
select is((public.get_my_seller_shift()->>'expected_cash_cents')::bigint,8770::bigint,'drawer holds float plus three receipts');
select throws_ok($$select public.reverse_confirmed_sale((select sale_id from payout_sales where label='a'),'Cliente desistiu da compra','EST-CASH-A',(select (result->>'shift_id')::uuid from shift_a),'payout-seller','68000000-0000-4000-8000-000000000003')$$,'42501','FINANCE_MANAGE_REQUIRED','a seller cannot reverse a sale');

-- Finance: sale A refunded in cash from the open shift A.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table reversal_a as select public.reverse_confirmed_sale((select sale_id from payout_sales where label='a'),'Cliente desistiu da compra','EST-CASH-A',(select (result->>'shift_id')::uuid from shift_a),'payout-reverse-a','68000000-0000-4000-8000-000000000004') result;
select is((select (result->'reversal'->'cash_payout'->>'amount_cents')::bigint from reversal_a),2590::bigint,'reversal reports the physical payout');
select is((select result->'reversal'->'cash_payout'->>'shift_id' from reversal_a),(select result->>'shift_id' from shift_a),'payout belongs to the drawer that handed the cash');
select is(public.reverse_confirmed_sale((select sale_id from payout_sales where label='a'),'Cliente desistiu da compra','EST-CASH-A',(select (result->>'shift_id')::uuid from shift_a),'payout-reverse-a','68000000-0000-4000-8000-000000000004'),
  (select result from reversal_a),'replay returns the stored reversal');
select is((public.reverse_confirmed_sale((select sale_id from payout_sales where label='a'),'Cliente desistiu da compra','EST-CASH-A',(select (result->>'shift_id')::uuid from shift_a),'payout-reverse-a-2','68000000-0000-4000-8000-000000000005')->'reversal'->'cash_payout'->>'movement_id'),
  (select result->'reversal'->'cash_payout'->>'movement_id' from reversal_a),'a new key reports the same single payout');
select throws_ok($$select public.reverse_confirmed_sale((select sale_id from payout_sales where label='a'),'Cliente desistiu da compra','EST-CASH-A',gen_random_uuid(),'payout-reverse-a-3','68000000-0000-4000-8000-000000000006')$$,'P0001','SALE_ALREADY_REVERSED','an already reversed sale cannot pay out from another drawer');

-- Finance: sale B refunded by another means leaves the drawer untouched.
create temp table reversal_b as select public.reverse_confirmed_sale((select sale_id from payout_sales where label='b'),'Reembolso feito por transferencia','EST-OTHER-B',null,'payout-reverse-b','68000000-0000-4000-8000-000000000007') result;
select is((select result->'reversal'->'cash_payout' from reversal_b),'null'::jsonb,'refund by another means has no payout');
reset role;

select is((select count(*)::integer from public.cash_movements where movement_type='REFUND_PAYOUT' and sale_id in (select sale_id from payout_sales)),1,'only the cash refund moved the drawer, exactly once');
select is((select amount_cents from public.cash_movements where movement_type='SALE_RECEIPT' and sale_id=(select sale_id from payout_sales where label='a')),2590::bigint,'original receipt is preserved');
select is((select refund_entry_id::text from public.cash_movements where movement_type='REFUND_PAYOUT' and sale_id=(select sale_id from payout_sales where label='a')),(select result->'reversal'->>'refund_entry_id' from reversal_a),'payout is linked to the refund entry');
select is((select string_agg(metadata->>'refund_method',',' order by metadata->>'refund_reference') from public.financial_ledger_entries where entry_type='REFUND' and sale_id in (select sale_id from payout_sales)),'CASH_DRAWER,OTHER','refund entries record how the money went back');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select is((public.get_my_seller_shift()->>'expected_cash_cents')::bigint,6180::bigint,'expected = float + receipts - physical refunds');
select is((public.get_my_seller_shift()->>'cash_refunds_total_cents')::bigint,2590::bigint,'shift shows the physical refunds');
create temp table closed_a as select public.close_seller_shift((select (result->>'shift_id')::uuid from shift_a),6180,null,'payout-close-a','68000000-0000-4000-8000-000000000008') result;
select is((select (result->>'difference_cents')::bigint from closed_a),0::bigint,'close after a correct physical refund has no divergence');

-- After the close, sale C is refunded: the closed shift A can no longer pay out.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.reverse_confirmed_sale((select sale_id from payout_sales where label='c'),'Cliente voltou no dia seguinte','EST-CASH-C',(select (result->>'shift_id')::uuid from shift_a),'payout-reverse-c-closed','68000000-0000-4000-8000-000000000009')$$,'P0001','SELLER_SHIFT_NOT_OPEN','a closed shift never takes a later payout');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table shift_b as select public.open_seller_shift('50000000-0000-4000-8000-000000000002',0,'payout-open-b','68000000-0000-4000-8000-000000000010') result;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.reverse_confirmed_sale((select sale_id from payout_sales where label='c'),'Cliente voltou no dia seguinte','EST-CASH-C',(select (result->>'shift_id')::uuid from shift_b),'payout-reverse-c-empty','68000000-0000-4000-8000-000000000011')$$,'P0001','CASH_DRAWER_INSUFFICIENT','an empty drawer cannot pay a refund');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select lives_ok($$select public.close_seller_shift((select (result->>'shift_id')::uuid from shift_b),0,null,'payout-close-b','68000000-0000-4000-8000-000000000012')$$,'empty shift closes');
create temp table shift_c as select public.open_seller_shift('50000000-0000-4000-8000-000000000002',5000,'payout-open-c','68000000-0000-4000-8000-000000000013') result;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.reverse_confirmed_sale((select sale_id from payout_sales where label='c'),'Cliente voltou no dia seguinte','EST-CASH-C',(select (result->>'shift_id')::uuid from shift_c),'payout-reverse-c','68000000-0000-4000-8000-000000000014')$$,'a later refund is paid from the shift open when the cash leaves');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select is((public.get_my_seller_shift()->>'expected_cash_cents')::bigint,2410::bigint,'the later payout lowers the current drawer');
reset role;

select is((select expected_cash_cents from public.seller_shifts where id=(select (result->>'shift_id')::uuid from shift_a)),6180::bigint,'closed shift keeps its expected cash');
select is((select coalesce(sum(amount_cents),0)::bigint from public.cash_movements where shift_id=(select (result->>'shift_id')::uuid from shift_a)),6180::bigint,'closed shift ledger is unchanged');
select throws_ok($$insert into public.cash_movements(shift_id,movement_type,amount_cents,actor_id,correlation_id) values((select (result->>'shift_id')::uuid from shift_a),'OPENING_FLOAT',100,'10000000-0000-4000-8000-000000000002',gen_random_uuid())$$,'P0001','SELLER_SHIFT_NOT_OPEN','nothing enters a closed drawer');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.list_seller_shifts()$$,'42501','FINANCE_MANAGE_REQUIRED','a seller cannot review every shift');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select is((public.list_seller_shifts('OPEN')->0->>'shift_id'),(select result->>'shift_id' from shift_c),'finance sees the open drawer');
select is((select (item->>'cash_refunds_total_cents')::bigint from jsonb_array_elements(public.list_seller_shifts('CLOSED',200)) item where item->>'shift_id'=(select result->>'shift_id' from shift_a)),2590::bigint,'finance reviews the closed shift with its physical refunds');
reset role;

select * from finish();
rollback;
