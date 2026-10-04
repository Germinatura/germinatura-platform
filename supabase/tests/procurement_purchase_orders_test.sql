begin;
select plan(26);

select ok(has_table_privilege('authenticated','public.purchase_orders','SELECT'), 'order reads can reach RLS');
select ok(not has_table_privilege('authenticated','public.purchase_orders','INSERT'), 'direct order inserts denied');
select ok(not has_table_privilege('authenticated','public.purchase_order_items','INSERT'), 'direct item inserts denied');
select ok(not has_function_privilege('anon','public.create_purchase_order(uuid,date,date,bigint,bigint,text,text,text,jsonb,text,text,uuid)','EXECUTE'), 'anonymous order command denied');
select ok(not has_function_privilege('anon','public.cancel_purchase_order(uuid,text,text,uuid)','EXECUTE'), 'anonymous cancellation denied');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.create_purchase_order('a2000000-0000-4000-8000-000000000001','2026-09-18',null,100,0,'PIX',null,null,'[]','Testar acesso','consumer-order','a3000000-0000-4000-8000-000000000001')$$,'42501','PROCUREMENT_MANAGE_FORBIDDEN','consumer cannot order');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table order_supplier as select public.save_supplier(null,null,'Fornecedor de compras','Ana',null,null,null,null,true,'Preparar pedido','order-supplier','a3000000-0000-4000-8000-000000000002') result;
create temp table created_order as select public.create_purchase_order(
  (select (result->>'id')::uuid from order_supplier),'2026-09-18','2026-09-20',250,50,'PIX após entrega',null,'Compras do evento',
  '[{"productId":"33000000-0000-4000-8000-000000000001","quantity":2,"unitCostCents":625}]'::jsonb,
  'Repor os doces','order-create','a3000000-0000-4000-8000-000000000003'
) result;
select is((select result->>'status' from created_order),'OPEN','created order is open');
select is((select (result->>'totalCents')::bigint from created_order),1550::bigint,'server calculates items plus freight and other cost');
select is((select items_subtotal_cents from public.purchase_orders where id=(select (result->>'id')::uuid from created_order)),1250::bigint,'subtotal stored in cents');
select is((select product_sku from public.purchase_order_items where order_id=(select (result->>'id')::uuid from created_order)), 'CONCURRENCY-ITEM', 'item snapshots SKU');
select is((select count(*)::integer from public.stock_movements where source_type='purchase_order' and source_id=(select result->>'id' from created_order)),0,'ordering alone creates no stock movement');
select results_eq(
  $$select public.create_purchase_order((select (result->>'id')::uuid from order_supplier),'2026-09-18','2026-09-20',250,50,'PIX após entrega',null,'Compras do evento','[{"productId":"33000000-0000-4000-8000-000000000001","quantity":2,"unitCostCents":625}]'::jsonb,'Repor os doces','order-create','a3000000-0000-4000-8000-000000000099')$$,
  $$select result from created_order$$,'idempotent retry returns original order');
select throws_ok($$select public.create_purchase_order((select (result->>'id')::uuid from order_supplier),'2026-09-18',null,250,50,'PIX',null,null,'[{"productId":"33000000-0000-4000-8000-000000000001","quantity":2,"unitCostCents":625}]'::jsonb,'Outro pedido','order-create','a3000000-0000-4000-8000-000000000004')$$,'P0001','IDEMPOTENCY_CONFLICT','same key with changed order fails');
select throws_ok($$select public.create_purchase_order((select (result->>'id')::uuid from order_supplier),'2026-09-18',null,0,0,'PIX',null,null,'[{"productId":"33000000-0000-4000-8000-000000000001","quantity":1,"unitCostCents":100},{"productId":"33000000-0000-4000-8000-000000000001","quantity":1,"unitCostCents":100}]'::jsonb,'Item duplicado','order-duplicate','a3000000-0000-4000-8000-000000000005')$$,'23505',null,'duplicate products rejected atomically');
select throws_ok($$select public.create_purchase_order((select (result->>'id')::uuid from order_supplier),'2026-09-18',null,0,0,'PIX',null,null,'[{"productId":"33000000-0000-4000-8000-000000000001","quantity":9007199254740991,"unitCostCents":2}]'::jsonb,'Custo excessivo','order-overflow','a3000000-0000-4000-8000-000000000006')$$,'22023','INVALID_PURCHASE_ITEM','overflow rejected');
select throws_ok($$select public.create_purchase_order((select (result->>'id')::uuid from order_supplier),'2026-09-18','2026-09-17',0,0,'PIX',null,null,'[{"productId":"33000000-0000-4000-8000-000000000001","quantity":1,"unitCostCents":100}]'::jsonb,'Data inválida','order-dates','a3000000-0000-4000-8000-000000000007')$$,'22023','INVALID_PURCHASE_ORDER','invalid expected date rejected');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select is((select count(*)::integer from public.purchase_orders where id=(select (result->>'id')::uuid from created_order)),0,'consumer cannot read order');
select is((select count(*)::integer from public.purchase_order_items where order_id=(select (result->>'id')::uuid from created_order)),0,'consumer cannot read items');
select throws_ok($$select public.cancel_purchase_order((select (result->>'id')::uuid from created_order),'Acesso indevido','consumer-cancel','a3000000-0000-4000-8000-000000000008')$$,'42501','PROCUREMENT_MANAGE_FORBIDDEN','consumer cannot cancel order');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table cancelled_order as select public.cancel_purchase_order((select (result->>'id')::uuid from created_order),'Pedido desnecessário','order-cancel','a3000000-0000-4000-8000-000000000009') result;
select is((select result->>'status' from cancelled_order),'CANCELLED','order cancellation changes state');
select results_eq($$select public.cancel_purchase_order((select (result->>'id')::uuid from created_order),'Pedido desnecessário','order-cancel','a3000000-0000-4000-8000-000000000098')$$,$$select result from cancelled_order$$,'cancel retry is stable');
select throws_ok($$select public.cancel_purchase_order((select (result->>'id')::uuid from created_order),'Segundo cancelamento','order-cancel-again','a3000000-0000-4000-8000-000000000010')$$,'P0001','PURCHASE_ORDER_NOT_OPEN','second distinct cancellation is rejected');
reset role;

select is((select count(*)::integer from public.purchase_order_items where order_id=(select (result->>'id')::uuid from created_order)),1,'cancellation retains immutable items');
select is((select count(*)::integer from public.audit_logs where entity_type='purchase_order' and entity_id=(select result->>'id' from created_order)),2,'creation and cancellation audited');
select is((select count(*)::integer from public.outbox_events where aggregate_type='purchase_order' and aggregate_id=(select result->>'id' from created_order)),2,'one outbox event per transition');
select is((select count(*)::integer from public.financial_ledger_entries where correlation_id in ('a3000000-0000-4000-8000-000000000003'::uuid,'a3000000-0000-4000-8000-000000000009'::uuid)),0,'no financial ledger entry before receipt');

select * from finish();
rollback;
