begin;
select plan(25);

select has_table('public','product_images','product image metadata table exists');
select ok(not has_table_privilege('authenticated','public.product_images','INSERT'),'direct metadata insert stays denied');
select ok(not has_table_privilege('authenticated','public.product_images','UPDATE'),'direct metadata update stays denied');
select ok(not has_function_privilege('anon','public.add_catalog_product_image(uuid,integer,uuid,text,text,text,text,uuid)','EXECUTE'),'anonymous image command is denied');

insert into storage.objects(bucket_id,name,metadata,owner_id) values
  ('product-images','products/33f00000-0000-4000-8000-000000000001/63f00000-0000-4000-8000-000000000001.webp','{"mimetype":"image/webp","size":128}',null),
  ('product-images','products/33f00000-0000-4000-8000-000000000001/63f00000-0000-4000-8000-000000000002.png','{"mimetype":"image/png","size":256}',null);

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.add_catalog_product_image('33f00000-0000-4000-8000-000000000001',1,'63f00000-0000-4000-8000-000000000001','products/33f00000-0000-4000-8000-000000000001/63f00000-0000-4000-8000-000000000001.webp','Doce em embalagem azul','Adicionar imagem','image-forbidden','73f00000-0000-4000-8000-000000000001')$$,
  '42501','CATALOG_MANAGE_FORBIDDEN','consumer cannot attach images');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table first_image as select public.add_catalog_product_image(
  '33f00000-0000-4000-8000-000000000001',1,'63f00000-0000-4000-8000-000000000001',
  'products/33f00000-0000-4000-8000-000000000001/63f00000-0000-4000-8000-000000000001.webp',
  'Doce em embalagem azul','Adicionar imagem principal','image-add-1','73f00000-0000-4000-8000-000000000001') result;
select is((select result->>'sortOrder' from first_image),'0','first image becomes cover');
select is((select result->>'productRevision' from first_image),'2','adding image increments product revision');
select results_eq($$select public.add_catalog_product_image('33f00000-0000-4000-8000-000000000001',1,'63f00000-0000-4000-8000-000000000001','products/33f00000-0000-4000-8000-000000000001/63f00000-0000-4000-8000-000000000001.webp','Doce em embalagem azul','Adicionar imagem principal','image-add-1','73f00000-0000-4000-8000-000000000099')$$,
  $$select result from first_image$$,'replay returns original result');
select throws_ok($$select public.add_catalog_product_image('33f00000-0000-4000-8000-000000000001',2,'63f00000-0000-4000-8000-000000000099','products/33f00000-0000-4000-8000-000000000001/63f00000-0000-4000-8000-000000000099.webp','Imagem ausente','Adicionar imagem ausente','image-missing','73f00000-0000-4000-8000-000000000002')$$,
  'P0001','PRODUCT_IMAGE_OBJECT_INVALID','missing binary object is rejected');

create temp table second_image as select public.add_catalog_product_image(
  '33f00000-0000-4000-8000-000000000001',2,'63f00000-0000-4000-8000-000000000002',
  'products/33f00000-0000-4000-8000-000000000001/63f00000-0000-4000-8000-000000000002.png',
  'Doce visto de lado','Adicionar imagem lateral','image-add-2','73f00000-0000-4000-8000-000000000003') result;
select is((select result->>'sortOrder' from second_image),'1','next image appends after cover');

create temp table reordered as select public.reorder_catalog_product_images(
  '33f00000-0000-4000-8000-000000000001',3,
  array['63f00000-0000-4000-8000-000000000002'::uuid,'63f00000-0000-4000-8000-000000000001'::uuid],
  'Trocar imagem principal','image-order','73f00000-0000-4000-8000-000000000004') result;
select is((select sort_order from public.product_images where id='63f00000-0000-4000-8000-000000000002'),0::smallint,'reorder changes cover');
select is((select result->>'productRevision' from reordered),'4','reorder increments revision');
select throws_ok($$select public.reorder_catalog_product_images('33f00000-0000-4000-8000-000000000001',3,array['63f00000-0000-4000-8000-000000000001'::uuid,'63f00000-0000-4000-8000-000000000002'::uuid],'Ordem concorrente','image-order-stale','73f00000-0000-4000-8000-000000000005')$$,
  'P0001','PRODUCT_REVISION_CONFLICT','stale reorder loses concurrency race');
select throws_ok($$select public.reorder_catalog_product_images('33f00000-0000-4000-8000-000000000001',4,array['63f00000-0000-4000-8000-000000000001'::uuid],'Lista incompleta','image-order-partial','73f00000-0000-4000-8000-000000000006')$$,
  'P0001','PRODUCT_IMAGE_SET_CHANGED','partial image order is rejected');

create temp table removing as select public.begin_remove_catalog_product_image(
  '63f00000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',4,
  'Remover imagem principal','image-remove','73f00000-0000-4000-8000-000000000007') result;
select is((select status from public.product_images where id='63f00000-0000-4000-8000-000000000002'),'REMOVING','removal first hides metadata');
select is((select sort_order from public.product_images where id='63f00000-0000-4000-8000-000000000001'),0::smallint,'removal closes active ordering gap');
select results_eq($$select public.begin_remove_catalog_product_image('63f00000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',4,'Remover imagem principal','image-remove','73f00000-0000-4000-8000-000000000099')$$,
  $$select result from removing$$,'removal start is replayable for Storage retry');
select is((public.begin_remove_catalog_product_image('63f00000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',4,'Retentar limpeza física','image-remove-retry','73f00000-0000-4000-8000-000000000098')->>'productRevision'),'5','a new request can resume pending physical cleanup without another revision');
select lives_ok($$select public.finish_remove_catalog_product_image('63f00000-0000-4000-8000-000000000002','73f00000-0000-4000-8000-000000000008')$$,'removal can be finalized after Storage succeeds');
select is((select status from public.product_images where id='63f00000-0000-4000-8000-000000000002'),'REMOVED','finalized metadata preserves tombstone');
select lives_ok($$select public.finish_remove_catalog_product_image('63f00000-0000-4000-8000-000000000002','73f00000-0000-4000-8000-000000000009')$$,'finalization is idempotent');
reset role;

set local role anon;
select is((select count(*)::integer from public.product_images where product_id='33f00000-0000-4000-8000-000000000001'),1,'anonymous catalog sees only active image metadata');
reset role;
select is((select count(*)::integer from public.audit_logs where entity_type='product_image' and entity_id in ('63f00000-0000-4000-8000-000000000001','63f00000-0000-4000-8000-000000000002')),4,'image lifecycle creates one audit per state change');
select is((select revision from public.products where id='33f00000-0000-4000-8000-000000000001'),5,'all catalog-visible image changes advance product revision');
select is((select count(*)::integer from storage.objects where name like 'products/33f00000-0000-4000-8000-000000000001/%'),2,'database removal never mutates Storage objects directly');

select * from finish();
rollback;
