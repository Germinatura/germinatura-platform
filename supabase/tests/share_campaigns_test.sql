-- Spec 4.2 / 5.13 (GROW-001): tracked share campaigns, visits and reservation attribution.
begin;
select plan(13);

select ok(has_function_privilege('anon','public.record_share_visit(text)','EXECUTE'),'anyone can follow a tracked link');
select ok(not has_function_privilege('anon','public.create_share_campaign(text,public.share_channel,uuid[],text,uuid)','EXECUTE'),'anonymous cannot create campaigns');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.create_share_campaign('Doces da semana','WHATSAPP',null,'share-consumer',gen_random_uuid())$$,'42501','COMMUNICATIONS_MANAGE_REQUIRED','a consumer cannot create campaigns');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.create_share_campaign('Oculto','WHATSAPP',array['33f00000-0000-4000-8000-000000000002'::uuid],'share-hidden',gen_random_uuid())$$,'22023','INVALID_SHARE_CAMPAIGN','unpublished products cannot be shared');
create temp table campaign as select public.create_share_campaign('Doces da semana','WHATSAPP',array['33f00000-0000-4000-8000-000000000001'::uuid],'share-1','77000000-0000-4000-8000-000000000001') result;
select ok((select result->>'code' from campaign) ~ '^[a-z0-9]{8}$','the campaign gets a short code');
select is(public.create_share_campaign('Doces da semana','WHATSAPP',array['33f00000-0000-4000-8000-000000000001'::uuid],'share-1','77000000-0000-4000-8000-000000000001'),(select result from campaign),'creation is idempotent');
reset role;
grant select on campaign to anon;

set local role anon;
select is((public.record_share_visit((select result->>'code' from campaign))->>'campaign_id'),(select result->>'id' from campaign),'a visit resolves the campaign');
select is(public.record_share_visit('zzzzzzzz'),null,'unknown codes are not counted');
select is(public.record_share_visit('<script>'),null,'malformed codes are ignored');
reset role;

insert into public.inventory_balances (location_id, product_id) values ('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001',1,'Divulgação','share-stock',gen_random_uuid())$$,'admin prepares central stock');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
create temp table res as select (public.create_commercial_reservation('50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'share-res',gen_random_uuid())->>'reservation_id')::uuid as id;
select is(public.attribute_reservation((select id from res),(select result->>'code' from campaign)),true,'the consumer reservation is attributed to the campaign');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select is(public.attribute_reservation((select id from res),(select result->>'code' from campaign)),false,'nobody else can attribute it');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select is((select (item->>'visits')::integer||':'||(item->>'reservations')::integer from jsonb_array_elements(public.list_share_campaigns(10)) item
  where item->>'id' = (select result->>'id' from campaign)),'1:1','the campaign reports visits and reservations');
reset role;

select * from finish();
rollback;
