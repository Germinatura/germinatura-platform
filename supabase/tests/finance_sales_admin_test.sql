-- Etapa 6: finance lists every sale and opens a detail that mirrors the reversal guards.
begin;
select plan(20);

select ok(not has_function_privilege('anon','public.list_sales_admin(text,text,boolean,date,date,uuid,integer)','EXECUTE'),'anonymous cannot list sales');

insert into public.inventory_balances(location_id,product_id)
values('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001')
on conflict (location_id,product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',6,'Estoque vendas financeiro','fin-sales-stock','6b000000-0000-4000-8000-000000000001')$$,'admin prepares seller stock');

-- Seller: a cash sale, a card sale, a pending sale and a sale that finance reverses by another means.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select lives_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000002',0,'fin-sales-shift',gen_random_uuid())$$,'seller opens a shift');
create temp table fin_sales(label text primary key, sale_id uuid);
insert into fin_sales select label, (public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'fin-sales-'||label,gen_random_uuid())->>'sale_id')::uuid
from unnest(array['cash','card','pending','reversed']) label;
select lives_ok($$select public.confirm_cash_payment((select sale_id from fin_sales where label='cash'),2590,'fin-sales-cash',gen_random_uuid())$$,'cash sale confirmed');
select lives_ok($$select public.confirm_manual_payment((select sale_id from fin_sales where label=label_name),'MAQUININHA','NSU-FIN-'||upper(label_name),'CREDITO',null,'fin-sales-'||label_name||'-card',gen_random_uuid()) from (values ('card'),('reversed')) labels(label_name)$$,'card sales confirmed');
select throws_ok($$select public.list_sales_admin()$$,'42501','SALES_READ_ALL_REQUIRED','a seller cannot list every sale');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.reverse_confirmed_sale((select sale_id from fin_sales where label='reversed'),'Cliente desistiu da compra','EST-FIN-REV',null,'fin-sales-reverse',gen_random_uuid())$$,'finance reverses one sale by another means');

create temp table listed as select item from jsonb_array_elements(public.list_sales_admin(null,null,false,null,null,null,100)->'items') item
where (item->>'sale_id')::uuid in (select sale_id from fin_sales);
select is((select count(*)::integer from listed),4,'finance sees every seller sale');
select is((select item->>'seller_name' from listed limit 1) is not null,true,'list names the seller');
select is((select array_agg(label order by label) from fin_sales where sale_id::text in (select item->>'sale_id' from jsonb_array_elements(public.list_sales_admin(null,null,true,null,null,null,100)->'items') item)),array['pending'],'pending filter keeps the unpaid sale');
select is((select array_agg(label order by label) from fin_sales where sale_id::text in (select item->>'sale_id' from jsonb_array_elements(public.list_sales_admin('CANCELLED','PDV',false,null,null,null,100)->'items') item)),array['reversed'],'status and channel filters combine');
select is((select count(*)::integer from jsonb_array_elements(public.list_sales_admin(null,null,false,(now() at time zone 'America/Sao_Paulo')::date + 1,null,null,100)->'items') item where (item->>'sale_id')::uuid in (select sale_id from fin_sales)),0,'period starts at the São Paulo day');
select is((select count(*)::integer from jsonb_array_elements(public.list_sales_admin(null,null,false,(now() at time zone 'America/Sao_Paulo')::date,(now() at time zone 'America/Sao_Paulo')::date,null,100)->'items') item where (item->>'sale_id')::uuid in (select sale_id from fin_sales)),4,'a single-day period includes the whole day');
select throws_ok($$select public.list_sales_admin(null,null,false,'2026-09-30','2026-09-29',null,25)$$,'22023','INVALID_SALES_FILTER','an inverted period is rejected');
select is((public.list_sales_admin(null,null,false,null,null,(select (public.list_sales_admin(null,null,false,null,null,null,1)->>'next_cursor')::uuid),1)->'items'->0->>'sale_id') <> (public.list_sales_admin(null,null,false,null,null,null,1)->'items'->0->>'sale_id'),true,'keyset cursor moves to the next page');

select is((public.get_sale_admin((select sale_id from fin_sales where label='cash'))->'reversal'),'{"allowed": true, "blocked_reason": null, "cash_payout_allowed": true}'::jsonb,'a cash sale can be refunded from a drawer');
select is((public.get_sale_admin((select sale_id from fin_sales where label='cash'))->'cash_movements'->0->>'movement_type'),'SALE_RECEIPT','detail shows the drawer receipt');
select is((public.get_sale_admin((select sale_id from fin_sales where label='pending'))->'reversal'->>'blocked_reason'),'SALE_NOT_CONFIRMED','an unpaid sale is not reversible');
select is((select entry->>'refund_method' from jsonb_array_elements(public.get_sale_admin((select sale_id from fin_sales where label='reversed'))->'ledger') entry where entry->>'entry_type'='REFUND'),'OTHER','detail shows how the refund went back');
select throws_ok($$select public.get_sale_admin(gen_random_uuid())$$,'P0001','SALE_NOT_FOUND','unknown sales are not found');
reset role;

select * from finish();
rollback;
