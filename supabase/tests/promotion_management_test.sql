begin;
select plan(26);

select has_table('public','promotion_versions','promotion version history exists');
select col_type_is('public','promotions','revision','integer','promotion revision is explicit');
select ok(not has_table_privilege('authenticated','public.promotion_versions','INSERT'),'history denies direct insert');
select has_function('public','save_quantity_price_promotion',array['uuid','integer','text','text','text','boolean','boolean','integer','boolean','timestamp with time zone','timestamp with time zone','bigint','integer','uuid[]','promotion_channel[]','integer','bigint','integer','text','text','uuid'],'promotion save command exists');
select ok(not has_function_privilege('anon','public.save_quantity_price_promotion(uuid,integer,text,text,text,boolean,boolean,integer,boolean,timestamp with time zone,timestamp with time zone,bigint,integer,uuid[],promotion_channel[],integer,bigint,integer,text,text,uuid)','EXECUTE'),'anonymous cannot execute command');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.save_quantity_price_promotion(null,null,'PROMO-CONSUMER','Negada',null,false,false,1,false,now(),null,null,null,array['33000000-0000-4000-8000-000000000001']::uuid[],array['PORTAL']::public.promotion_channel[],2,1000,null,'Tentativa indevida','promo-consumer',gen_random_uuid())$$,'42501','PROMOTION_MANAGE_FORBIDDEN','consumer cannot manage promotions');
select is((select count(*)::integer from public.promotion_versions),0,'consumer cannot read version history');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table created_promotion as select public.save_quantity_price_promotion(
  null,null,'QTY-MANAGED','Duas por dez','Oferta administrada',true,true,150,false,
  now()-interval '1 hour',now()+interval '2 days',null,null,
  array['33000000-0000-4000-8000-000000000001']::uuid[],
  array['PORTAL','PDV']::public.promotion_channel[],2,1000,3,
  'Criar promoção administrada','promo-create',gen_random_uuid()) result;

select is((select result->>'code' from created_promotion),'QTY-MANAGED','command returns created promotion');
select is((select (result->>'revision')::integer from created_promotion),1,'creation starts at revision one');
select is((select count(*)::integer from public.promotion_products where promotion_id=(select (result->>'id')::uuid from created_promotion)),1,'product scope is persisted');
select is((select count(*)::integer from public.promotion_channels where promotion_id=(select (result->>'id')::uuid from created_promotion)),2,'channel scope is persisted');
select results_eq($$select group_quantity,group_price_cents,max_groups_per_line from public.promotion_quantity_price_rules where promotion_id=(select (result->>'id')::uuid from created_promotion)$$,$$select 2::integer,1000::bigint,3::integer$$,'quantity price rule is persisted in cents');
select is((select count(*)::integer from public.promotion_versions where promotion_id=(select (result->>'id')::uuid from created_promotion)),1,'creation writes immutable version');
reset role;
select is((select count(*)::integer from public.audit_logs where entity_type='promotion' and entity_id=(select result->>'id' from created_promotion)),1,'creation is audited');
select is((select count(*)::integer from public.outbox_events where aggregate_type='promotion' and aggregate_id=(select result->>'id' from created_promotion)),1,'creation emits outbox event');
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';

select is((public.save_quantity_price_promotion(
  null,null,'QTY-MANAGED','Duas por dez','Oferta administrada',true,true,150,false,
  now()-interval '1 hour',now()+interval '2 days',null,null,
  array['33000000-0000-4000-8000-000000000001']::uuid[],array['PORTAL','PDV']::public.promotion_channel[],2,1000,3,
  'Criar promoção administrada','promo-create',gen_random_uuid())->>'id'),(select result->>'id' from created_promotion),'idempotent replay returns same promotion');
select is((select count(*)::integer from public.promotions where code='QTY-MANAGED'),1,'replay does not duplicate promotion');

create temp table updated_promotion as select public.save_quantity_price_promotion(
  (select (result->>'id')::uuid from created_promotion),1,'QTY-MANAGED','Três por doze',null,false,false,200,false,
  now()-interval '1 hour',null,null,null,
  array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PDV']::public.promotion_channel[],3,1200,null,
  'Atualizar e inativar promoção','promo-update',gen_random_uuid()) result;
select is((select (result->>'revision')::integer from updated_promotion),2,'update increments revision');
select is((select count(*)::integer from public.promotion_products where promotion_id=(select (result->>'id')::uuid from created_promotion) and product_id='33f00000-0000-4000-8000-000000000001'),1,'update replaces product scope');
select is((select count(*)::integer from public.promotion_channels where promotion_id=(select (result->>'id')::uuid from created_promotion)),1,'update replaces channel scope');
select is((select count(*)::integer from public.promotion_versions where promotion_id=(select (result->>'id')::uuid from created_promotion)),2,'update preserves both versions');
select throws_ok($$select public.save_quantity_price_promotion(
  (select (result->>'id')::uuid from created_promotion),1,'QTY-MANAGED','Conflito',null,false,false,1,false,now(),null,null,null,
  array['33000000-0000-4000-8000-000000000001']::uuid[],array['PDV']::public.promotion_channel[],2,900,null,
  'Tentar revisão antiga','promo-conflict',gen_random_uuid())$$,'P0001','PROMOTION_REVISION_CONFLICT','stale update is rejected');
select throws_ok($$select public.save_quantity_price_promotion(null,null,'BAD','Inválida',null,true,true,0,false,now(),null,null,null,array['ffffffff-ffff-4fff-8fff-ffffffffffff']::uuid[],array['PDV']::public.promotion_channel[],2,1000,null,'Produto inexistente','promo-missing',gen_random_uuid())$$,'P0002','PROMOTION_PRODUCT_NOT_FOUND','unknown product is rejected');
reset role;
select throws_ok($$delete from public.promotion_versions where promotion_id=(select (result->>'id')::uuid from created_promotion)$$,'P0001','IMMUTABLE_RECORD','version history is immutable');
select throws_ok($$delete from public.promotion_products where promotion_id=(select (result->>'id')::uuid from created_promotion)$$,'P0001','PROMOTION_HARD_DELETE_FORBIDDEN','scope deletion remains forbidden outside command');
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select throws_ok($$insert into public.promotions(code,name,valid_from) values('DIRECT-MANAGER','Direta',now())$$,'42501',null,'manager still cannot write promotion tables directly');

select * from finish();
rollback;
