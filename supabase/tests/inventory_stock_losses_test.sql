begin;
select plan(47);
create temp table stock_loss_test_baseline as select
  (select count(*)::bigint from public.stock_loss_reports) reports,
  (select count(*)::bigint from public.stock_movements where source_type='stock_loss_report') movements,
  (select count(*)::bigint from public.audit_logs where entity_type='stock_loss_report') audits,
  (select count(*)::bigint from public.outbox_events where aggregate_type='stock_loss_report') events,
  (select count(*)::bigint from public.audit_logs where entity_type='stock_loss_settings') setting_audits;
grant select on stock_loss_test_baseline to authenticated;
select has_table('public','stock_loss_reports','loss reports are persisted');
select has_table('public','stock_loss_settings','loss approval settings are persisted');
select has_function('public','report_stock_loss',array['uuid','bigint','text','text','text','text','uuid'],'report RPC exists');
select has_function('public','resolve_stock_loss',array['uuid','text','text','text','uuid'],'resolution RPC exists');
select has_function('public','configure_stock_loss_threshold',array['bigint','text','text','uuid'],'settings RPC exists');
select has_function('public','get_stock_losses',array['uuid','integer'],'history RPC exists');
select function_privs_are('private','record_stock_loss_movement',array['uuid','stock_movement_type','uuid','uuid','bigint','uuid','text','uuid'],'authenticated',array[]::text[],'internal movement helper is not directly executable');
select function_privs_are('private','record_stock_loss_event',array['uuid','text','uuid','uuid','jsonb'],'authenticated',array[]::text[],'internal audit helper is not directly executable');
select results_eq($$select count(*)::bigint from storage.buckets where id='stock-loss-photos' and not public and file_size_limit=5242880$$,array[1::bigint],'loss photo bucket is private and limited');
select results_eq($$select count(*)::bigint from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'stock_loss_photos_%'$$,array[2::bigint],'loss photos have restricted read and insert policies');
select is((select approval_threshold_quantity from public.stock_loss_settings where singleton),null::bigint,'approval defaults to fail-closed without invented threshold');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33000000-0000-4000-8000-000000000001',8,'Preparar perdas','loss-adjust','64000000-0000-4000-8000-000000000001')$$,'admin prepares seller stock through ledger');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
insert into storage.objects(bucket_id,name,owner_id,metadata) values('stock-loss-photos','10000000-0000-4000-8000-000000000002/evidence.jpg','10000000-0000-4000-8000-000000000002','{}');
create temp table pending_loss as select public.report_stock_loss('33000000-0000-4000-8000-000000000001',5,'DAMAGED','Embalagens danificadas no transporte','10000000-0000-4000-8000-000000000002/evidence.jpg','loss-report-pending','64000000-0000-4000-8000-000000000002') result;
reset role;
select results_eq($$select status::text from public.stock_loss_reports where id=(select (result->>'report_id')::uuid from pending_loss)$$,array['PENDING_APPROVAL'::text],'loss above unconfigured threshold remains pending');
select is((select on_hand_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),8::bigint,'pending loss preserves physical stock');
select is((select reserved_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),5::bigint,'pending loss holds reported quantity');
select is((select available_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),3::bigint,'pending loss removes held stock from availability');
select results_eq($$select movement_type::text from public.stock_movements where id=(select hold_movement_id from public.stock_loss_reports where id=(select (result->>'report_id')::uuid from pending_loss))$$,array['RESERVA'::text],'pending loss has immutable hold movement');
select results_eq($$select photo_path from public.stock_loss_reports where id=(select (result->>'report_id')::uuid from pending_loss)$$,array['10000000-0000-4000-8000-000000000002/evidence.jpg'::text],'optional evidence is linked to report');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.report_stock_loss('33000000-0000-4000-8000-000000000001',1,'MISSING','Tentativa de consumidor',null,'loss-consumer','64000000-0000-4000-8000-000000000003')$$,'42501','STOCK_LOSS_REQUIRED','consumer cannot report loss');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.resolve_stock_loss((select (result->>'report_id')::uuid from pending_loss),'APPROVE','Tentativa sem gestão','loss-approve-seller','64000000-0000-4000-8000-000000000004')$$,'42501','STOCK_LOSS_DECISION_FORBIDDEN','seller cannot approve own loss');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table approved_loss as select public.resolve_stock_loss((select (result->>'report_id')::uuid from pending_loss),'APPROVE','Evidência e quantidade conferidas','loss-approve','64000000-0000-4000-8000-000000000005') result;
reset role;
select results_eq($$select status::text from public.stock_loss_reports where id=(select (result->>'report_id')::uuid from pending_loss)$$,array['APPLIED'::text],'manager approval applies loss');
select is((select on_hand_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),3::bigint,'approval consumes physical stock');
select is((select reserved_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),0::bigint,'approval consumes the hold');
select is((select available_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),3::bigint,'approval leaves consistent availability');
select results_eq($$select movement_type::text from public.stock_movements where id=(select (result->>'movement_id')::uuid from approved_loss)$$,array['PERDA'::text],'approval creates loss movement');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select results_eq($$select public.resolve_stock_loss((select (result->>'report_id')::uuid from pending_loss),'APPROVE','Evidência e quantidade conferidas','loss-approve','64000000-0000-4000-8000-000000000099')$$,$$select result from approved_loss$$,'approval replay returns original result');
select throws_ok($$select public.resolve_stock_loss((select (result->>'report_id')::uuid from pending_loss),'REJECT','Tentativa após aprovação','loss-resolve-again','64000000-0000-4000-8000-000000000006')$$,'P0001','STOCK_LOSS_ALREADY_RESOLVED','resolved loss cannot change state');
select lives_ok($$select public.configure_stock_loss_threshold(2,'Permitir baixas pequenas','loss-settings-2','64000000-0000-4000-8000-000000000007')$$,'manager configures automatic threshold');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table automatic_loss as select public.report_stock_loss('33000000-0000-4000-8000-000000000001',1,'EXPIRED','Produto fora da validade',null,'loss-report-auto','64000000-0000-4000-8000-000000000008') result;
reset role;
select results_eq($$select result->>'status' from automatic_loss$$,array['APPLIED'::text],'loss at configured threshold applies automatically');
select is((select on_hand_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),2::bigint,'automatic loss debits physical stock');
select is((select reserved_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),0::bigint,'automatic loss creates no hold');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.configure_stock_loss_threshold(0,'Exigir aprovação novamente','loss-settings-0','64000000-0000-4000-8000-000000000009')$$,'zero threshold requires approval for every positive loss');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table cancelled_loss as select public.report_stock_loss('33000000-0000-4000-8000-000000000001',1,'OTHER','Registro que será cancelado',null,'loss-report-cancel','64000000-0000-4000-8000-000000000010') result;
select lives_ok($$select public.resolve_stock_loss((select (result->>'report_id')::uuid from cancelled_loss),'CANCEL','Ocorrência registrada por engano','loss-cancel','64000000-0000-4000-8000-000000000011')$$,'seller cancels own pending loss');
reset role;
select results_eq($$select status::text from public.stock_loss_reports where id=(select (result->>'report_id')::uuid from cancelled_loss)$$,array['CANCELLED'::text],'cancellation is persisted');
select is((select on_hand_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),2::bigint,'cancellation preserves physical stock');
select is((select reserved_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),0::bigint,'cancellation releases the hold');
select is((select available_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000002' and product_id='33000000-0000-4000-8000-000000000001'),2::bigint,'cancellation restores availability');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select results_eq($$select count(*)::bigint from public.stock_loss_reports$$,array[0::bigint],'RLS hides losses from consumer');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select is((select count(*)::bigint from public.stock_loss_reports),(select reports+3 from stock_loss_test_baseline),'seller sees own loss history plus this test run');
select results_eq($$select jsonb_array_length(public.get_stock_losses(null,2)->'reports')$$,array[2],'history enforces page size');
select ok((public.get_stock_losses(null,2)->>'next_cursor') is not null,'history exposes cursor');
select results_eq($$select public.report_stock_loss('33000000-0000-4000-8000-000000000001',1,'EXPIRED','Produto fora da validade',null,'loss-report-auto','64000000-0000-4000-8000-000000000098')$$,$$select result from automatic_loss$$,'report replay survives resulting stock change');
reset role;
select is((select count(*)::bigint from public.stock_movements where source_type='stock_loss_report'),(select movements+5 from stock_loss_test_baseline),'loss workflow writes only expected immutable movements');
select is((select count(*)::bigint from public.audit_logs where entity_type='stock_loss_report'),(select audits+5 from stock_loss_test_baseline),'loss reports and decisions are audited');
select is((select count(*)::bigint from public.outbox_events where aggregate_type='stock_loss_report'),(select events+5 from stock_loss_test_baseline),'loss events are published transactionally');
select is((select count(*)::bigint from public.audit_logs where entity_type='stock_loss_settings'),(select setting_audits+2 from stock_loss_test_baseline),'threshold changes are audited');
select results_eq($$select count(*)::bigint from public.idempotency_keys where key in ('loss-consumer','loss-approve-seller','loss-resolve-again')$$,array[0::bigint],'failed operations leave no idempotency claims');
select * from finish(); rollback;
