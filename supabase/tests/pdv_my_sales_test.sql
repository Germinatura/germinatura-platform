-- Spec 6.10: "Minhas vendas" lists only the seller's own PDV sales, with status, method and pending highlight.
begin;
select plan(17);

select ok(not has_function_privilege('anon','public.list_my_sales(text,uuid,integer)','EXECUTE'),'anonymous cannot list sales');

insert into public.inventory_balances(location_id,product_id)
values('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001')
on conflict (location_id,product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',6,'Estoque minhas vendas','my-sales-stock','69000000-0000-4000-8000-000000000001')$$,'admin prepares seller stock');

-- Seller: a cash sale, a card sale that ends awaiting reconciliation, a pending sale and a cancelled sale.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select lives_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000002',0,'my-sales-shift','69000000-0000-4000-8000-000000000002')$$,'seller opens a shift');
create temp table my_sales(label text primary key, sale_id uuid);
insert into my_sales select label, (public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'my-sales-'||label,gen_random_uuid())->>'sale_id')::uuid
from unnest(array['cash','card','pending','cancelled']) label;
select lives_ok($$select public.confirm_cash_payment((select sale_id from my_sales where label='cash'),2590,'my-sales-cash',gen_random_uuid())$$,'cash sale confirmed');
select lives_ok($$select public.confirm_manual_payment((select sale_id from my_sales where label='card'),'MAQUININHA','NSU-MYSALES-01', 'CREDITO', null,'my-sales-card',gen_random_uuid())$$,'card sale confirmed');
select lives_ok($$select public.cancel_sale((select sale_id from my_sales where label='cancelled'),'my-sales-cancel',gen_random_uuid())$$,'pending sale cancelled');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.reconcile_payment_attempt((select id from public.payment_attempts where sale_id=(select sale_id from my_sales where label='card')),2500,0,'EXTRATO-MYSALES-01','MANUAL','my-sales-reconcile',gen_random_uuid())$$,'finance flags a divergent settlement');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table listed as select item from jsonb_array_elements(public.list_my_sales(null,null,50)->'items') item
where (item->>'sale_id')::uuid in (select sale_id from my_sales);
select is((select count(*)::integer from listed),4,'seller sees the four own sales');
select is((select item->'payment'->>'integration_channel' from listed where item->>'sale_id'=(select sale_id::text from my_sales where label='cash')),'DINHEIRO','list shows the payment method');
select is((select item->>'pending_reason' from listed where item->>'sale_id'=(select sale_id::text from my_sales where label='pending')),'AWAITING_PAYMENT','an unpaid sale is pending');
select ok((select item->>'reservation_expires_at' from listed where item->>'sale_id'=(select sale_id::text from my_sales where label='pending')) is not null,'a pending sale shows when its reservation expires');
select is((select item->>'pending_reason' from listed where item->>'sale_id'=(select sale_id::text from my_sales where label='card')),'RECONCILIATION_PENDING','a divergent settlement is highlighted for reconciliation');
select is((select array_agg(label order by label) from my_sales where sale_id::text in (select item->>'sale_id' from jsonb_array_elements(public.list_my_sales('PENDING',null,50)->'items') item)),array['card','pending'],'pending filter keeps unpaid and unreconciled sales');
select is((public.list_my_sales(null,(select (public.list_my_sales(null,null,1)->>'next_cursor')::uuid),1)->'items'->0->>'sale_id') <> (public.list_my_sales(null,null,1)->'items'->0->>'sale_id'),true,'keyset cursor moves to the next page');
select throws_ok($$select public.list_my_sales('ALL',null,20)$$,'22023','INVALID_SALES_FILTER','unknown filters are rejected');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select is((select count(*)::integer from jsonb_array_elements(public.list_my_sales(null,null,50)->'items') item where (item->>'sale_id')::uuid in (select sale_id from my_sales)),0,'another operator never sees the seller''s sales here');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.list_my_sales()$$,'42501','SELLER_REQUIRED','a consumer cannot use the PDV sales list');
reset role;

select * from finish();
rollback;
