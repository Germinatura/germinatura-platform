-- Spec 5.15 (NOTIF-003): segmented announcements with a frozen audience, delivered by the outbox worker.
begin;
select plan(15);

select ok(not has_function_privilege('anon','public.publish_announcement(text,text,boolean,text[],text[],text,uuid)','EXECUTE'),'anonymous cannot publish');
select ok(not has_table_privilege('authenticated','public.announcements','INSERT'),'announcements deny direct writes');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.publish_announcement('Aviso','Texto do aviso',true,null,null,'ann-consumer',gen_random_uuid())$$,'42501','COMMUNICATIONS_MANAGE_REQUIRED','a consumer cannot publish');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.publish_announcement('Aviso','Texto do aviso',false,null,null,'ann-empty',gen_random_uuid())$$,'22023','INVALID_ANNOUNCEMENT','an announcement needs an audience');
select throws_ok($$select public.publish_announcement('Aviso','Texto do aviso',false,array['TURMA_A'],null,'ann-role',gen_random_uuid())$$,'22023','INVALID_ANNOUNCEMENT','unknown roles are rejected');
select throws_ok($$select public.publish_announcement('Aviso','Texto do aviso',false,null,array['ninguem@institutojef.org.br'],'ann-unknown',gen_random_uuid())$$,'P0001','ANNOUNCEMENT_UNKNOWN_RECIPIENTS','unknown e-mails are reported');

create temp table sellers as select public.publish_announcement('Reunião de vendedores','Encontro na sala da comissão às 18h.',false,array['VENDEDOR'],null,'ann-sellers','76000000-0000-4000-8000-000000000001') result;
select is(public.publish_announcement('Reunião de vendedores','Encontro na sala da comissão às 18h.',false,array['VENDEDOR'],null,'ann-sellers','76000000-0000-4000-8000-000000000001'),(select result from sellers),'publishing is idempotent');
create temp table direct as select public.publish_announcement('Retirada liberada','Seu pedido já pode ser retirado.',false,null,array[' CONSUMIDOR.TESTE@institutojef.org.br '],'ann-direct',gen_random_uuid()) result;
create temp table everyone as select public.publish_announcement('Festa de formatura','Os convites começam a ser vendidos amanhã.',true,null,null,'ann-all',gen_random_uuid()) result;
select is((public.list_announcements(10)->0->>'id'),(select result->>'id' from everyone),'the newest announcement is listed first');
reset role;

select ok((select bool_and(recipient_id <> '10000000-0000-4000-8000-000000000003') and bool_or(recipient_id = '10000000-0000-4000-8000-000000000002')
  from public.announcement_recipients where announcement_id = (select (result->>'id')::uuid from sellers)),'the role audience reaches sellers and not consumers');
select is((select array_agg(recipient_id::text) from public.announcement_recipients where announcement_id = (select (result->>'id')::uuid from direct)),
  array['10000000-0000-4000-8000-000000000003'],'e-mails are matched ignoring case and spaces');
select is((select (result->>'recipient_count')::bigint from everyone),
  (select count(*) from public.profiles where active and onboarding_completed_at is not null),'everyone means every active, onboarded user');

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table claimed as select * from public.worker_claim_outbox_events('worker-announcements', 100, 300);
select lives_ok($$select public.worker_process_outbox_event(id, 'worker-announcements') from claimed$$,'the worker delivers the announcements');
reset role;

select is((select kind||':'||title from public.notifications where recipient_id='10000000-0000-4000-8000-000000000003'
  and data->>'announcement_id' = (select result->>'id' from direct)),'ANNOUNCEMENT:Retirada liberada','the recipient gets the announcement in-app');
select is((select count(*)::integer from public.notifications where data->>'announcement_id' = (select result->>'id' from sellers)),
  (select recipient_count from public.announcements where id = (select (result->>'id')::uuid from sellers)),'one notification per frozen recipient');
select throws_ok($$delete from public.announcements$$,'P0001','IMMUTABLE_RECORD','announcements are immutable');

select * from finish();
rollback;
