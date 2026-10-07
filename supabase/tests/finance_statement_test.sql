-- Spec 5.8 (FIN-006): the statement classifies automatic and manual entries on categories and accounts.
begin;
select plan(15);

create function pg_temp.account_total(p_statement jsonb, p_account text) returns bigint language sql as $$
  select coalesce((p_statement->'totals'->'by_account'->>p_account)::bigint, 0) $$;
create function pg_temp.category_total(p_statement jsonb, p_category text) returns bigint language sql as $$
  select coalesce((p_statement->'totals'->'by_category'->>p_category)::bigint, 0) $$;

select ok(not has_function_privilege('anon','public.finance_statement(date,date)','EXECUTE'),'anonymous cannot read the statement');

insert into public.inventory_balances(location_id,product_id)
values('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001')
on conflict (location_id,product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table period as select (now() at time zone 'America/Sao_Paulo')::date as day;
create temp table baseline as select public.finance_statement((select day from period),(select day from period)) result;
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',6,'Estoque extrato','statement-stock',gen_random_uuid())$$,'admin prepares seller stock');

-- Seller: two cash sales and one Área Pix sale (label card) of R$ 25,90 each.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table shift as select public.open_seller_shift('50000000-0000-4000-8000-000000000002',5000,'statement-shift',gen_random_uuid()) result;
create temp table st_sales(label text primary key, sale_id uuid);
insert into st_sales select label, (public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'statement-'||label,gen_random_uuid())->>'sale_id')::uuid
from unnest(array['cash','refunded','card']) label;
select lives_ok($$select public.confirm_cash_payment(sale_id,2590,'statement-cash-'||label,gen_random_uuid()) from st_sales where label in ('cash','refunded')$$,'cash sales confirmed');
select lives_ok($$select public.confirm_manual_payment((select sale_id from st_sales where label='card'),'PIX_AREA','PIX-STATEMENT-1',null,null,'statement-card',gen_random_uuid())$$,'Área Pix sale confirmed');

-- Finance: settle the Área Pix sale with a fee, refund one cash sale from the drawer, and record manual entries.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.reconcile_payment_attempt((select id from public.payment_attempts where sale_id=(select sale_id from st_sales where label='card')),2590,59,'EXTRATO-STATEMENT-1','MANUAL','statement-reconcile',gen_random_uuid())$$,'card sale settled with a fee');
select lives_ok($$select public.reverse_confirmed_sale((select sale_id from st_sales where label='refunded'),'Cliente devolveu o produto','EST-STATEMENT-1',(select (result->>'shift_id')::uuid from shift),'statement-reverse',gen_random_uuid())$$,'cash sale refunded from the drawer');
select lives_ok($$select public.record_finance_entry('EXPENSE','TRANSPORTE','PICPAY_EMPRESAS',null,5000,(select day from period),'Frete do evento',null,'statement-expense',gen_random_uuid())$$,'manual expense recorded');
select lives_ok($$select public.record_finance_entry('TRANSFER',null,'DINHEIRO_FISICO','PICPAY_EMPRESAS',1000,(select day from period),'Depósito do caixa',null,'statement-transfer',gen_random_uuid())$$,'treasury transfer recorded');

create temp table after_ as select public.finance_statement((select day from period),(select day from period)) result;
create temp table delta as select
  (select pg_temp.account_total(result,'DINHEIRO_FISICO') from after_) - (select pg_temp.account_total(result,'DINHEIRO_FISICO') from baseline) as cash,
  (select pg_temp.account_total(result,'RECEBIVEIS_PICPAY') from after_) - (select pg_temp.account_total(result,'RECEBIVEIS_PICPAY') from baseline) as receivables,
  (select pg_temp.account_total(result,'PICPAY_EMPRESAS') from after_) - (select pg_temp.account_total(result,'PICPAY_EMPRESAS') from baseline) as picpay,
  (select pg_temp.category_total(result,'VENDA_PDV') from after_) - (select pg_temp.category_total(result,'VENDA_PDV') from baseline) as pdv_revenue,
  (select pg_temp.category_total(result,'TAXAS') from after_) - (select pg_temp.category_total(result,'TAXAS') from baseline) as fees,
  (select pg_temp.category_total(result,'REEMBOLSO') from after_) - (select pg_temp.category_total(result,'REEMBOLSO') from baseline) as refunds,
  (select (result->'totals'->>'inflow_cents')::bigint from after_) - (select (result->'totals'->>'inflow_cents')::bigint from baseline) as inflow;

select is((select cash from delta),2590::bigint + 2590 - 2590 - 1000,'physical cash: two receipts, one drawer refund and the deposit');
select is((select receivables from delta),0::bigint,'the card receivable is fully settled after the fee');
select is((select picpay from delta),2531::bigint - 5000 + 1000,'PicPay: net settlement, the expense and the deposit');
select is((select pdv_revenue from delta),3::bigint * 2590,'PDV revenue counts every sale');
select is((select fees from delta),-59::bigint,'the fee is its own category');
select is((select refunds from delta),-2590::bigint,'the refund is its own category');
select is((select inflow from delta),3::bigint * 2590,'transfers and settlements are not inflow');
reset role;

select * from finish();
rollback;
