begin;
select plan(28);

select has_table('public', 'stock_return_requests', 'stock return requests are persisted');
select has_function('public', 'request_stock_return', array['uuid','bigint','text','text','uuid'], 'request RPC exists');
select has_function('public', 'resolve_stock_return', array['uuid','text','text','text','uuid'], 'resolution RPC exists');
select has_function('public', 'get_stock_returns', array['uuid','integer'], 'history RPC exists');
select function_privs_are('private','execute_stock_return',array['uuid','uuid','uuid','uuid','bigint','uuid','text','uuid'],'authenticated',array[]::text[],'internal stock transfer is not directly executable');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33000000-0000-4000-8000-000000000001',5,'Preparar devolução','return-adjust','63000000-0000-4000-8000-000000000001')$$,'admin prepares seller stock through the ledger');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table requested_return as select public.request_stock_return('33000000-0000-4000-8000-000000000001',4,'Sobras do evento externo','return-request-1','63000000-0000-4000-8000-000000000002') result;
reset role;
select results_eq($$select status::text from public.stock_return_requests where id=(select (result->>'request_id')::uuid from requested_return)$$,array['REQUESTED'::text],'request is pending physical receipt');
select results_eq($$select on_hand_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'$$,array[5::bigint],'request does not move seller stock');
select results_eq($$select count(*)::bigint from public.stock_movements where source_type='stock_return_request'$$,array[0::bigint],'request creates no movement before receipt');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq($$select public.request_stock_return('33000000-0000-4000-8000-000000000001',4,'Sobras do evento externo','return-request-1','63000000-0000-4000-8000-000000000099')$$,$$select result from requested_return$$,'request replay returns the persisted result');
select throws_ok($$select public.resolve_stock_return((select (result->>'request_id')::uuid from requested_return),'RECEIVE','Tentativa sem permissão','return-receive-seller','63000000-0000-4000-8000-000000000003')$$,'42501','INVENTORY_MANAGE_REQUIRED','seller cannot confirm physical receipt');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.request_stock_return('33000000-0000-4000-8000-000000000001',1,'Tentativa de consumidor','return-consumer','63000000-0000-4000-8000-000000000004')$$,'42501','STOCK_RETURN_REQUIRED','consumer cannot request a stock return');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table received_return as select public.resolve_stock_return((select (result->>'request_id')::uuid from requested_return),'RECEIVE','Quantidade e integridade conferidas','return-receive-1','63000000-0000-4000-8000-000000000005') result;
reset role;
select results_eq($$select status::text from public.stock_return_requests where id=(select (result->>'request_id')::uuid from requested_return)$$,array['RECEIVED'::text],'inventory confirmation records receipt');
select results_eq($$select array_agg(on_hand_quantity order by location_id) from public.inventory_balances where location_id in ('50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002') and product_id='33000000-0000-4000-8000-000000000001'$$,$$values (array[4::bigint,1::bigint])$$,'receipt debits seller and credits central atomically');
select results_eq($$select movement_type::text from public.stock_movements where id=(select (result->>'movement_id')::uuid from received_return)$$,array['TRANSFERENCIA'::text],'receipt is represented by a transfer');
select results_eq($$select source_id from public.stock_movements where id=(select (result->>'movement_id')::uuid from received_return)$$,$$select result->>'request_id' from received_return$$,'movement links to its return request');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq($$select public.request_stock_return('33000000-0000-4000-8000-000000000001',4,'Sobras do evento externo','return-request-1','63000000-0000-4000-8000-000000000096')$$,$$select result from requested_return$$,'request replay survives receipt and the resulting stock change');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq($$select public.resolve_stock_return((select (result->>'request_id')::uuid from requested_return),'RECEIVE','Quantidade e integridade conferidas','return-receive-1','63000000-0000-4000-8000-000000000099')$$,$$select result from received_return$$,'receipt replay returns the original result');
select throws_ok($$select public.resolve_stock_return((select (result->>'request_id')::uuid from requested_return),'REJECT','Tentativa depois do recebimento','return-resolve-again','63000000-0000-4000-8000-000000000006')$$,'P0001','RETURN_REQUEST_ALREADY_RESOLVED','resolved return cannot change state');
select results_eq($$select count(*)::bigint from public.stock_movements where source_type='stock_return_request'$$,array[1::bigint],'receipt replay creates only one movement');
select results_eq($$select jsonb_array_length(public.get_stock_returns(null,1)->'requests')$$,array[1],'manager can list return history');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table cancelled_return as select public.request_stock_return('33000000-0000-4000-8000-000000000001',1,'Produto não será mais devolvido','return-request-cancel','63000000-0000-4000-8000-000000000007') result;
select lives_ok($$select public.resolve_stock_return((select (result->>'request_id')::uuid from cancelled_return),'CANCEL','Necessário para nova venda','return-cancel-1','63000000-0000-4000-8000-000000000008')$$,'seller cancels own pending return');
select results_eq($$select status::text from public.stock_return_requests where id=(select (result->>'request_id')::uuid from cancelled_return)$$,array['CANCELLED'::text],'cancellation persists without movement');
select results_eq($$select jsonb_array_length(public.get_stock_returns(null,1)->'requests')$$,array[1],'seller history applies the page size');
select ok((public.get_stock_returns(null,1)->>'next_cursor') is not null,'seller history returns a cursor');

reset role;
select results_eq($$select count(*)::bigint from public.audit_logs where entity_type='stock_return_request'$$,array[4::bigint],'requests and decisions are audited');
select results_eq($$select count(*)::bigint from public.outbox_events where aggregate_type='stock_return_request'$$,array[4::bigint],'requests and decisions publish outbox events');
select results_eq($$select count(*)::bigint from public.idempotency_keys where key in ('return-receive-seller','return-consumer','return-resolve-again')$$,array[0::bigint],'failed operations leave no idempotency claims');

select * from finish();
rollback;
