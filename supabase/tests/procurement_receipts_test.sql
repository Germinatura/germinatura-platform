begin;
select plan(34);

select ok(has_table_privilege('authenticated','public.purchase_receipts','SELECT'),'receipt reads pass through RLS');
select ok(not has_table_privilege('authenticated','public.purchase_receipts','INSERT'),'direct receipt inserts denied');
select ok(not has_table_privilege('authenticated','public.inventory_lots','INSERT'),'direct lot inserts denied');
select ok(not has_table_privilege('authenticated','public.purchase_payable_entries','INSERT'),'direct payable inserts denied');
select ok(not has_function_privilege('anon','public.receive_purchase_order_item(uuid,uuid,bigint,date,text,date,date,text,text,uuid)','EXECUTE'),'anonymous receipt command denied');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.receive_purchase_order_item(gen_random_uuid(),gen_random_uuid(),1,(now() at time zone 'America/Sao_Paulo')::date,null,null,null,'Acesso indevido','receipt-consumer',gen_random_uuid())$$,'42501','PROCUREMENT_MANAGE_FORBIDDEN','consumer cannot receive');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table receipt_supplier as select public.save_supplier(null,null,'Fornecedor de recebimentos','Ana',null,null,null,null,true,'Preparar recebimento','receipt-supplier',gen_random_uuid()) result;
create temp table receipt_order as select public.create_purchase_order(
  (select (result->>'id')::uuid from receipt_supplier),(now() at time zone 'America/Sao_Paulo')::date,null,250,50,'PIX após entrega',null,null,
  '[{"productId":"33000000-0000-4000-8000-000000000001","quantity":2,"unitCostCents":625}]'::jsonb,
  'Repor os doces','receipt-order',gen_random_uuid()) result;
create temp table receipt_item as select id from public.purchase_order_items where order_id=(select (result->>'id')::uuid from receipt_order);
select throws_ok($$select public.receive_purchase_order_item((select (result->>'id')::uuid from receipt_order),(select id from receipt_item),1,(now() at time zone 'America/Sao_Paulo')::date-1,'LOTE-ANTERIOR',null,null,'Entrega anterior','receipt-before-order',gen_random_uuid())$$,'22023','INVALID_PURCHASE_RECEIPT','receipt cannot precede its order');
create temp table receipt_balance_before as select on_hand_quantity from public.inventory_balances
  where product_id='33000000-0000-4000-8000-000000000001'
    and location_id=(select id from public.stock_locations where location_type='CENTRAL' and active);
create temp table first_receipt as select public.receive_purchase_order_item(
  (select (result->>'id')::uuid from receipt_order),(select id from receipt_item),1,(now() at time zone 'America/Sao_Paulo')::date,
  'LOTE-DOCE-01',null,null,'Primeira entrega','receipt-one',gen_random_uuid()) result;
select is((select (result->>'quantity')::bigint from first_receipt),1::bigint,'partial receipt accepts one of two units');
select is((select (result->>'baseCostCents')::bigint from first_receipt),625::bigint,'base cost uses order snapshot');
select is((select (result->>'allocatedExtraCents')::bigint from first_receipt),150::bigint,'freight and other costs allocated cumulatively');
select is((select (result->>'totalCostCents')::bigint from first_receipt),775::bigint,'payable includes allocated costs');
select is((select count(*)::integer from public.stock_movements where source_type='purchase_receipt' and source_id=(select result->>'id' from first_receipt)),1,'one immutable stock entry linked to receipt');
reset role;
select is((select count(*)::integer from public.audit_logs where action='inventory.movement.created' and entity_id=(select result->>'movementId' from first_receipt)),1,'stock entry has its own audit evidence');
select is((select count(*)::integer from public.outbox_events where topic='inventory.movement.created' and aggregate_id=(select result->>'movementId' from first_receipt)),1,'stock entry has its own outbox event');
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select is((select on_hand_quantity from public.inventory_balances where product_id='33000000-0000-4000-8000-000000000001'
  and location_id=(select id from public.stock_locations where location_type='CENTRAL' and active)),
  (select coalesce(on_hand_quantity,0)+1 from receipt_balance_before),'central balance increased once');
select is((select lot_code from public.inventory_lots where receipt_id=(select (result->>'id')::uuid from first_receipt)),'LOTE-DOCE-01','lot records supplier code');
select is((select amount_cents from public.purchase_payable_entries where receipt_id=(select (result->>'id')::uuid from first_receipt)),775::bigint,'one payable linked to receipt');
select is((select status from public.purchase_orders where id=(select (result->>'id')::uuid from receipt_order)),'PARTIALLY_RECEIVED','first delivery marks order partial');
select is((select received_quantity from public.purchase_order_item_progress where order_item_id=(select id from receipt_item)),1::bigint,'progress view reports partial receipt');
select results_eq($$select public.receive_purchase_order_item((select (result->>'id')::uuid from receipt_order),(select id from receipt_item),1,(now() at time zone 'America/Sao_Paulo')::date,'LOTE-DOCE-01',null,null,'Primeira entrega','receipt-one',gen_random_uuid())$$,
  $$select result from first_receipt$$,'receipt replay returns original result');
select is((select count(*)::integer from public.purchase_receipts where order_id=(select (result->>'id')::uuid from receipt_order)),1,'replay creates no second receipt');
select throws_ok($$select public.cancel_purchase_order((select (result->>'id')::uuid from receipt_order),'Entrega já recebida','cancel-received',gen_random_uuid())$$,'P0001','PURCHASE_ORDER_NOT_OPEN','received order cannot be cancelled');
select throws_ok($$select public.receive_purchase_order_item((select (result->>'id')::uuid from receipt_order),(select id from receipt_item),2,(now() at time zone 'America/Sao_Paulo')::date,'LOTE-DOCE-02',null,null,'Entrega excedente','receipt-over',gen_random_uuid())$$,'P0001','PURCHASE_QUANTITY_EXCEEDED','overreceipt rejected');
create temp table second_receipt as select public.receive_purchase_order_item(
  (select (result->>'id')::uuid from receipt_order),(select id from receipt_item),1,(now() at time zone 'America/Sao_Paulo')::date,
  'LOTE-DOCE-02',null,null,'Segunda entrega','receipt-two',gen_random_uuid()) result;
select is((select sum(allocated_extra_cents)::bigint from public.purchase_receipts where order_id=(select (result->>'id')::uuid from receipt_order)),300::bigint,'all extras allocated exactly once after full receipt');
select is((select sum(amount_cents)::bigint from public.purchase_payable_entries where receipt_id in
  (select id from public.purchase_receipts where order_id=(select (result->>'id')::uuid from receipt_order))),1550::bigint,'payables reconcile to order total');
select is((select status from public.purchase_orders where id=(select (result->>'id')::uuid from receipt_order)),'RECEIVED','full delivery closes order');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select is((select count(*)::integer from public.purchase_receipts where order_id=(select (result->>'id')::uuid from receipt_order)),0,'consumer cannot read receipts');
select is((select count(*)::integer from public.inventory_lots where receipt_id=(select (result->>'id')::uuid from first_receipt)),0,'consumer cannot read lots');
select is((select count(*)::integer from public.purchase_payable_entries where receipt_id=(select (result->>'id')::uuid from first_receipt)),0,'consumer cannot read obligations');
select is((select count(*)::integer from public.purchase_order_item_progress where order_item_id=(select id from receipt_item)),0,'consumer cannot read progress');

reset role;
insert into public.user_roles(user_id,role_id) values('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000005');
set local role authenticated;
select is((select count(*)::integer from public.purchase_payable_entries where receipt_id=(select (result->>'id')::uuid from first_receipt)),1,'finance role can read linked payable');
select is((select count(*)::integer from public.purchase_receipts where order_id=(select (result->>'id')::uuid from receipt_order)),0,'finance role cannot inspect operational receipt data');

reset role;
update public.products
set tracks_lots=true
where id='33000000-0000-4000-8000-000000000001';
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table tracked_receipt_order as select public.create_purchase_order(
  (select (result->>'id')::uuid from receipt_supplier),(now() at time zone 'America/Sao_Paulo')::date,null,0,0,'PIX',null,null,
  '[{"productId":"33000000-0000-4000-8000-000000000001","quantity":1,"unitCostCents":625}]'::jsonb,
  'Validar lote obrigatório','receipt-tracked-order',gen_random_uuid()) result;
create temp table tracked_receipt_item as select id from public.purchase_order_items
  where order_id=(select (result->>'id')::uuid from tracked_receipt_order);
select throws_ok($$select public.receive_purchase_order_item(
  (select (result->>'id')::uuid from tracked_receipt_order),(select id from tracked_receipt_item),1,
  (now() at time zone 'America/Sao_Paulo')::date,null,null,null,'Entrega sem lote','receipt-tracked-missing',gen_random_uuid())$$,
  '22023','LOT_CODE_REQUIRED','tracked product requires supplier lot code');
select is((select count(*)::integer from public.purchase_receipts
  where order_id=(select (result->>'id')::uuid from tracked_receipt_order)),0,'missing required lot creates no receipt');

select * from finish();
rollback;
