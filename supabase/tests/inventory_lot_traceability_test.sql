begin;
select plan(33);

select has_table('public','inventory_lot_balances','lot balances exist');
select has_table('public','stock_movement_lot_allocations','movement allocations exist');
select ok(not has_table_privilege('authenticated','public.inventory_lot_balances','INSERT'),'lot balances deny direct writes');
select ok(not has_table_privilege('authenticated','public.stock_movement_lot_allocations','INSERT'),'allocations deny direct writes');
select ok(not has_function_privilege('anon','public.search_inventory_lot_positions(text,uuid,uuid,integer)','EXECUTE'),'anonymous lot search denied');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table trace_supplier as select public.save_supplier(null,null,'Fornecedor rastreável','Equipe',null,null,null,null,true,'Validar origem do lote','trace-supplier',gen_random_uuid()) result;
create temp table trace_order as select public.create_purchase_order(
  (select (result->>'id')::uuid from trace_supplier),(now() at time zone 'America/Sao_Paulo')::date,null,1,0,'PIX',null,null,
  '[{"productId":"33f00000-0000-4000-8000-000000000001","quantity":3,"unitCostCents":625}]'::jsonb,
  'Comprar lote rastreável','trace-order',gen_random_uuid()) result;
create temp table trace_item as select id from public.purchase_order_items where order_id=(select (result->>'id')::uuid from trace_order);
create temp table trace_receipt as select public.receive_purchase_order_item(
  (select (result->>'id')::uuid from trace_order),(select id from trace_item),3,(now() at time zone 'America/Sao_Paulo')::date,
  'LOTE-TRACE-01',null,(now() at time zone 'America/Sao_Paulo')::date+30,'Entrega rastreável','trace-receipt',gen_random_uuid()) result;
create temp table trace_lot as select id from public.inventory_lots where receipt_id=(select (result->>'id')::uuid from trace_receipt);

select is((select on_hand_quantity from public.inventory_lot_balances where lot_id=(select id from trace_lot) and location_id='50000000-0000-4000-8000-000000000001'),3::bigint,'receipt initializes central lot balance');
select results_eq($$select quantity,allocated_cost_cents from public.stock_movement_lot_allocations where lot_id=(select id from trace_lot)$$,
  $$select 3::bigint,1876::bigint$$,'receipt allocation preserves full real cost');
select is((select consumed_quantity from public.inventory_lot_cost_states where lot_id=(select id from trace_lot)),0::bigint,'receipt recognizes no consumed cost');

create temp table trace_distribution as select public.distribute_stock(
  '50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',2,
  'Distribuir lote rastreável','trace-distribution',gen_random_uuid()) result;
select is((select on_hand_quantity from public.inventory_lot_balances where lot_id=(select id from trace_lot) and location_id='50000000-0000-4000-8000-000000000001'),1::bigint,'transfer decrements exact central lot');
select is((select on_hand_quantity from public.inventory_lot_balances where lot_id=(select id from trace_lot) and location_id='50000000-0000-4000-8000-000000000002'),2::bigint,'transfer preserves lot at seller');
select is((select lot_id from public.stock_movement_lot_allocations where movement_item_id=(select id from public.stock_movement_items where movement_id=(select (result->>'movement_id')::uuid from trace_distribution))),(select id from trace_lot),'transfer allocation identifies original lot');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table trace_checkout as select public.checkout_sale(
  'PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]'::jsonb,
  'trace-checkout',gen_random_uuid()) result;
create temp table trace_payment as select public.confirm_manual_payment(
  (select (result->>'sale_id')::uuid from trace_checkout),'MAQUININHA','NSU-TRACE-0001','trace-payment',gen_random_uuid()) result;
create temp table trace_sale_movement as select id from public.stock_movements where source_type='sale' and source_id=(select result->>'sale_id' from trace_checkout);
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select is((select on_hand_quantity from public.inventory_lot_balances where lot_id=(select id from trace_lot) and location_id='50000000-0000-4000-8000-000000000002'),0::bigint,'confirmed sale consumes seller lot');
select results_eq($$select quantity,allocated_cost_cents from public.stock_movement_lot_allocations where movement_item_id=(select id from public.stock_movement_items where movement_id=(select id from trace_sale_movement))$$,
  $$select 2::bigint,1250::bigint$$,'sale receives deterministic real cost in cents');
select results_eq($$select consumed_quantity,consumed_cost_cents from public.inventory_lot_cost_states where lot_id=(select id from trace_lot)$$,
  $$select 2::bigint,1250::bigint$$,'lot cost state reconciles sale consumption');
select is((select source_id from public.inventory_lot_history where lot_id=(select id from trace_lot) and movement_type='VENDA'),(select result->>'sale_id' from trace_checkout),'history links lot to sale');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table trace_reversal as select public.reverse_confirmed_sale(
  (select (result->>'sale_id')::uuid from trace_checkout),'Cliente devolveu todos os itens','ESTORNO-TRACE-0001','trace-reversal',gen_random_uuid()) result;
select is((select on_hand_quantity from public.inventory_lot_balances where lot_id=(select id from trace_lot) and location_id='50000000-0000-4000-8000-000000000002'),2::bigint,'sale reversal restores exact seller lot');
select results_eq($$select consumed_quantity,consumed_cost_cents from public.inventory_lot_cost_states where lot_id=(select id from trace_lot)$$,
  $$select 0::bigint,0::bigint$$,'sale reversal restores recognized cost');
select is((select lot_id from public.stock_movement_lot_allocations where movement_item_id=(select id from public.stock_movement_items where movement_id=(select (result#>>'{reversal,stock_movement_id}')::uuid from trace_reversal))),(select id from trace_lot),'reversal allocation preserves original lot');

create temp table trace_adjustment as select public.adjust_stock(
  '50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',1,'Ajuste rastreável sem custo inventado','trace-adjustment',gen_random_uuid()) result;
select is((select count(*)::integer from public.inventory_lots where origin_type='STOCK_MOVEMENT_ITEM' and product_id='33f00000-0000-4000-8000-000000000001'),1,'positive adjustment creates explicit internal lot');
select is((select total_cost_cents from public.inventory_lots where origin_type='STOCK_MOVEMENT_ITEM' and product_id='33f00000-0000-4000-8000-000000000001'),null::bigint,'adjustment lot keeps unknown cost honest');
select is((select count(*)::integer from public.search_inventory_lot_positions('LOTE-TRACE-01',null,null,21)),2,'search finds both positions even when supplier lot is optional');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select is((select count(*)::integer from public.inventory_lot_positions),0,'consumer cannot inspect lot positions');
select is((select count(*)::integer from public.inventory_lot_history),0,'consumer cannot inspect lot history');
select throws_ok($$insert into public.stock_movement_lot_allocations(movement_item_id,lot_id,quantity) values(gen_random_uuid(),gen_random_uuid(),1)$$,'42501','permission denied for table stock_movement_lot_allocations','consumer cannot write allocations');

reset role;
select is((select count(*)::integer from public.inventory_lot_positions where lot_id=(select id from trace_lot)),2,'manager view exposes current lot across both locations');
select is((select count(*)::integer from public.inventory_lot_history where lot_id=(select id from trace_lot)),4,'history exposes receipt, transfer, sale and reversal');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table trace_depletion as select public.adjust_stock(
  '50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',-3,
  'Consumir posição antes da reversão antiga','trace-depletion',gen_random_uuid()) result;
create temp table trace_replenishment as select public.adjust_stock(
  '50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',1,
  'Repor para compensação tardia','trace-replenishment',gen_random_uuid()) result;
create temp table trace_late_reversal as select public.reverse_stock_movement(
  (select (result->>'movement_id')::uuid from trace_adjustment),'Reverter ajuste após consumo',
  'trace-late-reversal',gen_random_uuid()) result;
select is((select allocation.lot_id from public.stock_movement_lot_allocations allocation
  join public.stock_movement_items item on item.id=allocation.movement_item_id
  where item.movement_id=(select (result->>'movement_id')::uuid from trace_late_reversal)),
  (select allocation.lot_id from public.stock_movement_lot_allocations allocation
  join public.stock_movement_items item on item.id=allocation.movement_item_id
  where item.movement_id=(select (result->>'movement_id')::uuid from trace_replenishment)),
  'late reversal consumes the lot actually on hand');
select public.reverse_stock_movement((select (result->>'movement_id')::uuid from trace_depletion),
  'Repor consumo de teste','trace-depletion-reversal',gen_random_uuid());
select is((select consumed_quantity from public.inventory_lot_cost_states where lot_id=(select id from trace_lot)),
  0::bigint,'compensating negative adjustment restores cost state on reversal');
reset role;

-- A later consumption may remain after an earlier one is reversed. Cost must
-- still be nonnegative and all original cents must be recoverable.
select is(private.consume_lot_cost((select id from trace_lot),2),1250::bigint,'first cost allocation consumes two units');
select is(private.consume_lot_cost((select id from trace_lot),1),626::bigint,'last unit receives the remaining cent');
select lives_ok($$select private.restore_lot_cost((select id from trace_lot),2,1250)$$,'older allocation can be reversed out of order');
select is(private.consume_lot_cost((select id from trace_lot),1),625::bigint,'new allocation after reversal stays nonnegative');
select results_eq($$select consumed_quantity,consumed_cost_cents from public.inventory_lot_cost_states where lot_id=(select id from trace_lot)$$,
  $$select 2::bigint,1251::bigint$$,'remaining consumed cost reconciles after out-of-order reversal');

select * from finish();
rollback;
