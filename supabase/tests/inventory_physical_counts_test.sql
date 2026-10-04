begin;
select plan(39);
create temp table count_baseline as select
  (select count(*)::bigint from public.inventory_counts) counts,
  (select count(*)::bigint from public.audit_logs where entity_type='inventory_count') audits,
  (select count(*)::bigint from public.outbox_events where aggregate_type='inventory_count') events;
grant select on count_baseline to authenticated;

select has_table('public','inventory_counts','physical counts are persisted');
select has_table('public','inventory_count_items','count snapshots are persisted');
select has_function('public','submit_inventory_count',array['uuid','jsonb','text','text','uuid'],'submission RPC exists');
select has_function('public','resolve_inventory_count',array['uuid','text','text','text','uuid'],'resolution RPC exists');
select has_function('public','get_inventory_count_context',array['uuid','uuid','integer'],'context RPC exists');
select function_privs_are('private','record_inventory_count_event',array['uuid','text','uuid','uuid','jsonb'],'authenticated',array[]::text[],'event helper is private');
select function_privs_are('private','record_inventory_count_adjustment',array['uuid','uuid','uuid','uuid','bigint','uuid','text','uuid'],'authenticated',array[]::text[],'adjustment helper is private');
select function_privs_are('private','can_count_location',array['uuid','uuid'],'authenticated',array[]::text[],'authorization helper is private');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',6,'Preparar inventário A','count-adjust-a','65000000-0000-4000-8000-000000000001')$$,'admin prepares first balance');
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000002',2,'Preparar inventário B','count-adjust-b','65000000-0000-4000-8000-000000000002')$$,'admin prepares second balance');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table pending_count as select public.submit_inventory_count(null,'[{"product_id":"33f00000-0000-4000-8000-000000000001","expected_on_hand_quantity":6,"expected_reserved_quantity":0,"counted_on_hand_quantity":4},{"product_id":"33f00000-0000-4000-8000-000000000002","expected_on_hand_quantity":2,"expected_reserved_quantity":0,"counted_on_hand_quantity":5}]'::jsonb,'Contagem completa do vendedor','count-submit','65000000-0000-4000-8000-000000000003') result;
reset role;
select results_eq($$select status::text from public.inventory_counts where id=(select (result->>'count_id')::uuid from pending_count)$$,array['PENDING_APPROVAL'::text],'count waits for confirmation');
select results_eq($$select count(*)::bigint from public.inventory_count_items where count_id=(select (result->>'count_id')::uuid from pending_count)$$,array[2::bigint],'all snapshots are persisted');
select results_eq($$select expected_on_hand_quantity from public.inventory_count_items where count_id=(select (result->>'count_id')::uuid from pending_count) and product_id='33f00000-0000-4000-8000-000000000001'$$,array[6::bigint],'expected physical quantity is frozen');
select results_eq($$select difference_quantity from public.inventory_count_items where count_id=(select (result->>'count_id')::uuid from pending_count) order by product_id$$,array[-2::bigint,3::bigint],'differences are derived');
select is((select on_hand_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33f00000-0000-4000-8000-000000000001'),6::bigint,'submission does not edit stock');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.submit_inventory_count('50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","expected_on_hand_quantity":6,"expected_reserved_quantity":0,"counted_on_hand_quantity":6}]','Tentativa do consumidor','count-consumer','65000000-0000-4000-8000-000000000004')$$,'42501','INVENTORY_COUNT_REQUIRED','consumer cannot count stock');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.resolve_inventory_count((select (result->>'count_id')::uuid from pending_count),'APPROVE','Tentativa sem gestão','count-seller-approve','65000000-0000-4000-8000-000000000005')$$,'42501','INVENTORY_COUNT_DECISION_FORBIDDEN','seller cannot approve count');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table approved_count as select public.resolve_inventory_count((select (result->>'count_id')::uuid from pending_count),'APPROVE','Contagem física conferida','count-approve','65000000-0000-4000-8000-000000000006') result;
reset role;
select results_eq($$select result->>'status' from approved_count$$,array['APPLIED'::text],'approval applies count');
select results_eq($$select (result->>'adjustment_count')::integer from approved_count$$,array[2],'approval reports adjustment count');
select is((select on_hand_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33f00000-0000-4000-8000-000000000001'),4::bigint,'negative difference updates balance');
select is((select on_hand_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33f00000-0000-4000-8000-000000000002'),5::bigint,'positive difference updates balance');
select results_eq($$select movement_type::text from public.stock_movements where source_type='inventory_count' and source_id=(select result->>'count_id' from pending_count) order by movement_type$$,array['AJUSTE_NEGATIVO'::text,'AJUSTE_POSITIVO'::text],'approval records immutable adjustments');
select results_eq($$select count(*)::bigint from public.inventory_count_items where count_id=(select (result->>'count_id')::uuid from pending_count) and movement_id is not null$$,array[2::bigint],'count items link to their movements');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select results_eq($$select public.resolve_inventory_count((select (result->>'count_id')::uuid from pending_count),'APPROVE','Contagem física conferida','count-approve','65000000-0000-4000-8000-000000000099')$$,$$select result from approved_count$$,'approval replay returns original result');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select results_eq($$select public.submit_inventory_count(null,'[{"product_id":"33f00000-0000-4000-8000-000000000001","expected_on_hand_quantity":6,"expected_reserved_quantity":0,"counted_on_hand_quantity":4},{"product_id":"33f00000-0000-4000-8000-000000000002","expected_on_hand_quantity":2,"expected_reserved_quantity":0,"counted_on_hand_quantity":5}]'::jsonb,'Contagem completa do vendedor','count-submit','65000000-0000-4000-8000-000000000098')$$,$$select result from pending_count$$,'submission replay survives resulting stock change');

create temp table stale_count as select public.submit_inventory_count(null,'[{"product_id":"33f00000-0000-4000-8000-000000000001","expected_on_hand_quantity":4,"expected_reserved_quantity":0,"counted_on_hand_quantity":4}]','Snapshot que ficará antigo','count-stale','65000000-0000-4000-8000-000000000007') result;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',1,'Movimento concorrente','count-concurrent-adjust','65000000-0000-4000-8000-000000000008')$$,'concurrent movement changes balance');
select throws_ok($$select public.resolve_inventory_count((select (result->>'count_id')::uuid from stale_count),'APPROVE','Conferência atrasada','count-stale-approve','65000000-0000-4000-8000-000000000009')$$,'P0001','INVENTORY_COUNT_STALE','stale count cannot overwrite movement');
reset role;
select results_eq($$select status::text from public.inventory_counts where id=(select (result->>'count_id')::uuid from stale_count)$$,array['PENDING_APPROVAL'::text],'stale count remains pending for explicit resolution');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select lives_ok($$select public.resolve_inventory_count((select (result->>'count_id')::uuid from stale_count),'CANCEL','Refazer após movimentação','count-stale-cancel','65000000-0000-4000-8000-000000000010')$$,'seller cancels own stale count');
create temp table cancel_count as select public.submit_inventory_count(null,'[{"product_id":"33f00000-0000-4000-8000-000000000001","expected_on_hand_quantity":5,"expected_reserved_quantity":0,"counted_on_hand_quantity":5}]','Contagem para cancelar','count-cancel-submit','65000000-0000-4000-8000-000000000011') result;
select lives_ok($$select public.resolve_inventory_count((select (result->>'count_id')::uuid from cancel_count),'CANCEL','Registro feito por engano','count-cancel','65000000-0000-4000-8000-000000000012')$$,'seller cancels pending count');
select results_eq($$select jsonb_array_length(public.get_inventory_count_context(null,null,2)->'counts')$$,array[2],'history enforces page size');
select ok((public.get_inventory_count_context(null,null,2)->>'next_cursor') is not null,'history exposes cursor');
select results_eq($$select jsonb_array_length(public.get_inventory_count_context(null,null,20)->'balances')$$,array[2],'my stock returns every product balance');
select ok(jsonb_array_length(public.get_inventory_count_context(null,null,20)->'movements')>0,'my stock returns recent movements');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select results_eq($$select count(*)::bigint from public.inventory_counts$$,array[0::bigint],'RLS hides counts from consumer');
reset role;
select is((select count(*)::bigint from public.inventory_counts),(select counts+3 from count_baseline),'workflow writes expected count records');
select is((select count(*)::bigint from public.audit_logs where entity_type='inventory_count'),(select audits+6 from count_baseline),'submissions and decisions are audited');
select is((select count(*)::bigint from public.outbox_events where aggregate_type='inventory_count'),(select events+6 from count_baseline),'count events are transactional');
select results_eq($$select count(*)::bigint from public.idempotency_keys where key in ('count-consumer','count-seller-approve','count-stale-approve')$$,array[0::bigint],'failed operations leave no idempotency claims');
select * from finish(); rollback;
