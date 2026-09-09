begin;
select plan(24);

select ok(not has_table_privilege('authenticated', 'public.products', 'UPDATE'), 'direct product updates stay denied');
select ok(not has_table_privilege('authenticated', 'public.products', 'INSERT'), 'direct product creation stays denied');
select ok(not has_function_privilege('anon', 'public.save_catalog_product(uuid,integer,uuid,text,text,text,boolean,boolean,boolean,boolean,boolean,text,text,uuid)', 'EXECUTE'), 'anonymous product command execution denied');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.save_catalog_product(null,null,'23f00000-0000-4000-8000-000000000001','produto-teste','Produto teste',null,true,false,false,false,false,'Criar produto','product-forbidden','99000000-0000-4000-8000-000000000001')$$,
  '42501','CATALOG_MANAGE_FORBIDDEN','consumer cannot mutate products through RPC');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table product_result as
  select public.save_catalog_product(null,null,'23f00000-0000-4000-8000-000000000001','produto-teste','Produto teste','Descrição de teste',true,false,false,true,false,'Criar produto','product-create','99000000-0000-4000-8000-000000000001') as result;
select is((select result->>'revision' from product_result), '1', 'creation starts at revision one');
select matches((select result->>'sku' from product_result), '^PROD-[0-9]{6,}$', 'creation assigns a server-generated canonical SKU');
select results_eq($$select public.save_catalog_product(null,null,'23f00000-0000-4000-8000-000000000001','produto-teste','Produto teste','Descrição de teste',true,false,false,true,false,'Criar produto','product-create','99000000-0000-4000-8000-000000000002')$$,
  $$select result from product_result$$, 'retry returns the original product result including SKU and correlation');
select throws_ok($$select public.save_catalog_product(null,null,'23f00000-0000-4000-8000-000000000001','produto-outro','Produto outro',null,true,false,false,false,false,'Criar produto','product-create','99000000-0000-4000-8000-000000000001')$$,
  'P0001','IDEMPOTENCY_CONFLICT','same product key with changed payload rejected');
select throws_ok($$select public.save_catalog_product(null,null,'23000000-0000-4000-8000-000000000001','produto-inativo','Produto inativo',null,true,false,false,false,false,'Criar produto','product-inactive-category','99000000-0000-4000-8000-000000000001')$$,
  'P0001','PRODUCT_CATEGORY_INACTIVE','inactive category cannot receive a new product');
select throws_ok($$select public.save_catalog_product(null,null,'99999999-0000-4000-8000-000000000001','produto-sem-categoria','Produto sem categoria',null,true,false,false,false,false,'Criar produto','product-unknown-category','99000000-0000-4000-8000-000000000001')$$,
  'P0002','PRODUCT_CATEGORY_NOT_FOUND','unknown category is rejected');
select throws_ok($$select public.save_catalog_product(null,null,'23f00000-0000-4000-8000-000000000001','produto-sem-preco','Produto sem preço',null,true,true,false,false,false,'Criar produto','product-no-price','99000000-0000-4000-8000-000000000001')$$,
  'P0001','PRODUCT_CURRENT_PRICE_REQUIRED','a product without a current price cannot be published');
select throws_ok($$select public.save_catalog_product(null,null,'23f00000-0000-4000-8000-000000000001','invalid slug','Produto inválido',null,true,false,false,false,false,'Criar produto','product-invalid','99000000-0000-4000-8000-000000000001')$$,
  '22023','INVALID_CATALOG_PRODUCT','invalid product fields are rejected at database boundary');

create temp table product_updated as
  select public.save_catalog_product((select (result->>'id')::uuid from product_result),1,'23f00000-0000-4000-8000-000000000001','produto-teste','Produto atualizado',null,false,false,false,false,true,'Inativar produto','product-edit','99000000-0000-4000-8000-000000000003') as result;
select is((select result->>'revision' from product_updated), '2', 'update increments product revision');
select is((select result->>'sku' from product_updated), (select result->>'sku' from product_result), 'SKU is immutable across edits');
select results_eq($$select public.save_catalog_product((select (result->>'id')::uuid from product_result),1,'23f00000-0000-4000-8000-000000000001','produto-teste','Produto atualizado',null,false,false,false,false,true,'Inativar produto','product-edit','99000000-0000-4000-8000-000000000004')$$,
  $$select result from product_updated$$, 'retry succeeds despite old expected revision');
select throws_ok($$select public.save_catalog_product((select (result->>'id')::uuid from product_result),1,'23f00000-0000-4000-8000-000000000001','produto-teste','Edição perdida',null,true,false,false,false,false,'Outra edição','product-stale','99000000-0000-4000-8000-000000000001')$$,
  'P0001','PRODUCT_REVISION_CONFLICT','stale product edit cannot overwrite winner');
select is((select name from public.products where id=(select (result->>'id')::uuid from product_result)), 'Produto atualizado', 'conflict preserves winning product edit');
reset role;

select is((select count(*)::integer from public.audit_logs where entity_type='product' and entity_id=(select result->>'id' from product_result)), 2, 'exactly one audit record exists per successful product mutation');
select is((select metadata->'before'->>'name' from public.audit_logs where action='catalog.product.updated' and entity_id=(select result->>'id' from product_result)), 'Produto teste', 'audit retains product before snapshot');
select is((select metadata->'after'->>'sku' from public.audit_logs where action='catalog.product.updated' and entity_id=(select result->>'id' from product_result)), (select result->>'sku' from product_result), 'audit retains generated SKU');
select is((select metadata->>'reason' from public.audit_logs where action='catalog.product.updated' and entity_id=(select result->>'id' from product_result)), 'Inativar produto', 'audit retains product reason');
select throws_ok($$update public.products set sku = 'SKU-ALTERADO' where id = (select (result->>'id')::uuid from product_result)$$,
  'P0001', 'PRODUCT_SKU_IMMUTABLE', 'SKU cannot be rewritten even by a future privileged command');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((select count(*)::integer from public.products where slug='produto-teste'), 0, 'inactive product is hidden from consumer RLS');
reset role;
select is((select count(*)::integer from public.products where slug='produto-teste'), 1, 'inactivation preserves product history');
select * from finish();
rollback;
