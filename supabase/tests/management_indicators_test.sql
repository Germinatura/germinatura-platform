-- Spec 5.1 and 5.9 (ADMIN-001): period indicators come from the ledgers, with real lot cost, losses and expenses.
-- Scenario: 3 units bought for R$ 18,76; the seller sells 2 (R$ 25,90 each, credit), one sale is refunded,
-- the third unit is lost, and finance records a R$ 10,00 transport expense.
begin;
select plan(20);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table ind_supplier as select public.save_supplier(null, null, 'Fornecedor indicadores', 'Equipe', null, null, null, null, true, 'Custo real para indicadores', 'ind-supplier', gen_random_uuid()) result;
create temp table ind_order as select public.create_purchase_order(
  (select (result ->> 'id')::uuid from ind_supplier), (now() at time zone 'America/Sao_Paulo')::date, null, 1, 0, 'PIX', null, null,
  '[{"productId":"33f00000-0000-4000-8000-000000000001","quantity":3,"unitCostCents":625}]'::jsonb, 'Comprar para indicadores', 'ind-order', gen_random_uuid()) result;
select public.receive_purchase_order_item((select (result ->> 'id')::uuid from ind_order),
  (select id from public.purchase_order_items where order_id = (select (result ->> 'id')::uuid from ind_order)), 3,
  (now() at time zone 'America/Sao_Paulo')::date, 'LOTE-IND-01', null, (now() at time zone 'America/Sao_Paulo')::date + 30, 'Entrega para indicadores', 'ind-receipt', gen_random_uuid());
select public.distribute_stock('50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 3,
  'Distribuir para indicadores', 'ind-distribution', gen_random_uuid());
select public.record_finance_entry('EXPENSE', 'TRANSPORTE', 'PICPAY_EMPRESAS', null, 1000, (now() at time zone 'America/Sao_Paulo')::date,
  'Frete da entrega', 'FRETE-IND-01', 'ind-expense', gen_random_uuid());

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table ind_sales as select label, (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'ind-checkout-' || label, gen_random_uuid()) ->> 'sale_id')::uuid sale_id
from unnest(array['kept', 'refunded']) label;
grant select on ind_sales to authenticated;
select public.confirm_manual_payment(sale_id, 'MAQUININHA', 'NSU-IND-' || label, 'CREDITO', null, 'ind-pay-' || label, gen_random_uuid()) from ind_sales;
create temp table ind_loss as select public.report_stock_loss('33f00000-0000-4000-8000-000000000001', 1, 'DAMAGED', 'Caixa amassada no evento', null, 'ind-loss', gen_random_uuid()) result;
grant select on ind_loss to authenticated;
select throws_ok($$select public.management_indicators(current_date, current_date)$$, '42501', 'FINANCE_MANAGE_REQUIRED', 'sellers do not read management indicators');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.resolve_stock_loss((select (result ->> 'report_id')::uuid from ind_loss), 'APPROVE', 'Perda conferida', 'ind-loss-approve', gen_random_uuid());
select public.reverse_confirmed_sale((select sale_id from ind_sales where label = 'refunded'), 'Cliente desistiu da compra', 'EST-IND-0001', null, 'ind-refund', gen_random_uuid());
select throws_ok($$select public.management_indicators(current_date, current_date - 1)$$, '22023', 'INVALID_INDICATORS_PERIOD', 'the period must be valid');
create temp table ind as select public.management_indicators((now() at time zone 'America/Sao_Paulo')::date, (now() at time zone 'America/Sao_Paulo')::date) result;
grant select on ind to authenticated;
reset role;

select is((select (result #>> '{totals,sale_revenue_cents}')::bigint from ind), 5180::bigint, 'gross sale revenue counts both confirmed sales');
select is((select (result #>> '{totals,refunds_cents}')::bigint from ind), 2590::bigint, 'the refund is deducted');
select is((select (result #>> '{totals,net_revenue_cents}')::bigint from ind), 2590::bigint, 'net revenue is revenue minus refunds and fees');
select is((select (result #>> '{totals,cogs_cents}')::bigint from ind), 625::bigint, 'cost of goods nets the cost restored by the refund');
select is((select (result #>> '{totals,losses_cost_cents}')::bigint from ind), 626::bigint, 'the lost unit carries its real lot cost');
select is((select (result #>> '{totals,operating_expenses_cents}')::bigint from ind), 1000::bigint, 'manual expenses are operating expenses');
select is((select (result #>> '{totals,operating_profit_cents}')::bigint from ind), 339::bigint, 'profit = net revenue − cost − losses − expenses');
select is((select (result #>> '{totals,gross_margin_bps}')::bigint from ind), 7586::bigint, 'gross margin in basis points, rounded down');
select is((select result #>> '{totals,cost_complete}' from ind), 'true', 'every unit has a known cost');
select is((select (result #>> '{totals,average_ticket_cents}')::bigint from ind), 2590::bigint, 'average ticket over confirmed sales');
select is((select (result #>> '{by_channel,PDV}')::bigint from ind), 5180::bigint, 'revenue by channel');
select is((select (result #>> '{by_payment_method,CREDITO}')::bigint from ind), 5180::bigint, 'revenue by payment method');
select is((select (result -> 'top_products' -> 0 ->> 'units')::bigint from ind), 1::bigint, 'product units net of the refund');
select is((select (result -> 'top_products' -> 0 ->> 'margin_cents')::bigint from ind), 1965::bigint, 'product margin uses real cost');
select is((select result -> 'sellers' -> 0 ->> 'seller_id' from ind), '10000000-0000-4000-8000-000000000002', 'the seller is ranked');
select is((select (result -> 'sellers' -> 0 ->> 'revenue_cents')::bigint from ind), 2590::bigint, 'seller revenue nets the refund');
select is((select result -> 'losses' -> 0 ->> 'reason' from ind), 'DAMAGED', 'losses are broken down by reason');
select is((select jsonb_array_length(result -> 'daily') from ind), 1, 'one point per day of the period');

select * from finish();
rollback;
