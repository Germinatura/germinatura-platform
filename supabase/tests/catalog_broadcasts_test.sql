-- Spec 4.7 (NOTIF-005): new products, live promotions and new raffles are announced once, by preference.
begin;
select plan(9);

select ok(not has_table_privilege('authenticated','public.broadcast_notices','SELECT'),'the notice ledger is internal');

-- A product is published, withdrawn and published again: announced only once.
update public.products set published = true where id = '33f00000-0000-4000-8000-000000000002';
update public.products set published = false where id = '33f00000-0000-4000-8000-000000000002';
update public.products set published = true where id = '33f00000-0000-4000-8000-000000000002';
select is((select count(*)::integer from public.outbox_events where topic = 'catalog.product.published' and aggregate_id = '33f00000-0000-4000-8000-000000000002'),1,'a product is announced once');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select lives_ok($$select public.set_notification_preference('PROMOCOES',false)$$,'the consumer silences promotions');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table live as select public.save_quantity_price_promotion(null,null,'BROADCAST-LIVE','Duas por dez','Oferta no ar',true,true,150,false,
  now()-interval '1 hour',now()+interval '2 days',null,null,array['33000000-0000-4000-8000-000000000001']::uuid[],
  array['PORTAL','PDV']::public.promotion_channel[],2,1000,3,'Promoção pública','broadcast-live',gen_random_uuid()) result;
create temp table hidden as select public.save_quantity_price_promotion(null,null,'BROADCAST-HIDDEN','Interna','Oferta interna',true,false,150,false,
  now()-interval '1 hour',now()+interval '2 days',null,null,array['33000000-0000-4000-8000-000000000001']::uuid[],
  array['PDV']::public.promotion_channel[],2,1000,3,'Promoção interna','broadcast-hidden',gen_random_uuid()) result;
create temp table campaign as select public.create_raffle_campaign('Rifa da formatura','33f00000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',10,now()-interval '1 minute',now()+interval '1 day','broadcast-raffle',gen_random_uuid()) result;
reset role;

select is((select count(*)::integer from public.outbox_events where topic = 'promotions.live' and aggregate_id in ((select result->>'id' from live),(select result->>'id' from hidden))),1,'only the public live promotion is announced');
select is((select count(*)::integer from public.outbox_events where topic = 'raffles.campaign.opened' and aggregate_id = (select result->>'campaign_id' from campaign)),1,'a new raffle is announced');

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table claimed as select * from public.worker_claim_outbox_events('worker-broadcasts', 100, 300);
select lives_ok($$select public.worker_process_outbox_event(id, 'worker-broadcasts') from claimed$$,'the worker delivers the broadcasts');
reset role;

select is((select body from public.notifications where kind = 'NEW_PRODUCT' and recipient_id = '10000000-0000-4000-8000-000000000003'
  and data->>'product_id' = '33f00000-0000-4000-8000-000000000002'),'Item não publicado chegou ao catálogo.','the consumer hears about the new product');
select ok(not exists (select 1 from public.notifications where kind = 'PROMOTION_LIVE' and recipient_id = '10000000-0000-4000-8000-000000000003')
  and exists (select 1 from public.notifications where kind = 'PROMOTION_LIVE' and recipient_id = '10000000-0000-4000-8000-000000000002'),'promotions reach only who keeps them on');
select ok(exists (select 1 from public.notifications where kind = 'RAFFLE_OPENED' and recipient_id = '10000000-0000-4000-8000-000000000003'
  and data->>'campaign_id' = (select result->>'campaign_id' from campaign)),'raffle buyers hear about the new raffle');

select * from finish();
rollback;
