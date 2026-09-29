-- Spec 4.2 / 4.7 (NOTIF-004): preferences, "avise-me quando voltar" and Portal availability.
begin;
select plan(16);

select ok(has_function_privilege('anon','public.portal_availability(uuid[])','EXECUTE'),'anonymous visitors see availability');
select is((select count(*)::integer from public.portal_availability(array['33f00000-0000-4000-8000-000000000002'::uuid])),0,'unpublished products are never answered');

insert into public.inventory_balances (location_id, product_id) values
  ('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
-- Start with no central stock of the product.
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001',
  -(select available_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000001' and product_id='33f00000-0000-4000-8000-000000000001'),
  'Zerar para avise-me','prefs-zero',gen_random_uuid()) where (select available_quantity from public.inventory_balances where location_id='50000000-0000-4000-8000-000000000001' and product_id='33f00000-0000-4000-8000-000000000001') > 0$$,'admin empties the central stock');
select is((select available from public.portal_availability(array['33f00000-0000-4000-8000-000000000001'::uuid])),false,'the product shows as unavailable');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select is(jsonb_array_length(public.get_my_notification_preferences()),6,'every optional category is listed');
select ok((select bool_and((item->>'enabled')::boolean) from jsonb_array_elements(public.get_my_notification_preferences()) item),'categories start enabled');
select is((public.set_notification_preference('COMUNICADOS',false)->>'enabled')::boolean,false,'the consumer silences announcements');
select lives_ok($$select public.set_stock_alert('33f00000-0000-4000-8000-000000000001',true)$$,'the consumer asks to be told when it is back');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select lives_ok($$select public.set_stock_alert('33f00000-0000-4000-8000-000000000001',true)$$,'the seller asks too');
select lives_ok($$select public.set_notification_preference('ESTOQUE_DE_VOLTA',false)$$,'but silences back-in-stock notices');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.publish_announcement('Aviso geral','Mensagem para todos.',true,null,null,'prefs-announcement',gen_random_uuid())$$,'an announcement goes to everyone');
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001',1,'Chegou estoque','prefs-restock',gen_random_uuid())$$,'stock comes back');
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001',1,'Mais estoque','prefs-restock-2',gen_random_uuid())$$,'more stock arrives');
reset role;

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table claimed as select * from public.worker_claim_outbox_events('worker-prefs', 100, 300);
select lives_ok($$select public.worker_process_outbox_event(id, 'worker-prefs') from claimed$$,'the worker processes the events');
reset role;

select is((select array_agg(recipient_id::text order by recipient_id) from public.notifications where kind = 'PRODUCT_BACK_IN_STOCK'),
  array['10000000-0000-4000-8000-000000000003'],'only the subscriber who keeps the category on is told, once');
select ok(not exists (select 1 from public.notifications where kind = 'ANNOUNCEMENT' and recipient_id = '10000000-0000-4000-8000-000000000003')
  and exists (select 1 from public.notifications where kind = 'ANNOUNCEMENT' and recipient_id = '10000000-0000-4000-8000-000000000002'),'announcements skip users who silenced them');

select * from finish();
rollback;
