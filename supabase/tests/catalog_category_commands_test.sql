begin;
select plan(19);
select ok(not has_table_privilege('authenticated', 'public.categories', 'UPDATE'), 'direct category updates stay denied');
select ok(not has_table_privilege('authenticated', 'public.categories', 'INSERT'), 'direct category creation stays denied');
select ok(not has_function_privilege('anon', 'public.save_catalog_category(uuid,integer,text,text,boolean,integer,text,text,uuid)', 'EXECUTE'), 'anonymous RPC execution denied');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.save_catalog_category(null,null,'Teste','teste',true,0,'Criar categoria','category-forbidden','99000000-0000-4000-8000-000000000001')$$,
 '42501','CATALOG_MANAGE_FORBIDDEN','consumer cannot mutate categories through RPC');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table category_result as select public.save_catalog_category(null,null,'Categoria teste','categoria-teste',true,7,'Criar categoria','category-create','99000000-0000-4000-8000-000000000001') as result;
select is((select (result->>'revision')::integer from category_result),1,'creation starts at revision one');
select results_eq($$select public.save_catalog_category(null,null,'Categoria teste','categoria-teste',true,7,'Criar categoria','category-create','99000000-0000-4000-8000-000000000002')$$,
 $$select result from category_result$$,'retry returns original result including correlation');
select throws_ok($$select public.save_catalog_category(null,null,'Outro nome','categoria-teste',true,7,'Criar categoria','category-create','99000000-0000-4000-8000-000000000001')$$,
 'P0001','IDEMPOTENCY_CONFLICT','same key with changed payload rejected');
select throws_ok($$select public.save_catalog_category(null,null,'Outro nome','categoria-teste',true,7,'Criar categoria','category-duplicate','99000000-0000-4000-8000-000000000001')$$,
 '23505',null,'duplicate slug rejected');
select throws_ok($$select public.save_catalog_category(null,null,'Teste','invalid slug',true,0,'Criar categoria','category-invalid','99000000-0000-4000-8000-000000000001')$$,
 '22023','INVALID_CATALOG_CATEGORY','invalid slug rejected at database boundary');
select throws_ok($$select public.save_catalog_category(null,null,'Teste','new-test',true,0,'','category-reason','99000000-0000-4000-8000-000000000001')$$,
 '22023','INVALID_CATALOG_CATEGORY','reason required at database boundary');
create temp table category_updated as select public.save_catalog_category((select (result->>'id')::uuid from category_result),1,'Categoria atualizada','categoria-teste',false,9,'Inativar categoria','category-edit','99000000-0000-4000-8000-000000000003') as result;
select is((select (result->>'revision')::integer from category_updated),2,'update increments revision');
select results_eq($$select public.save_catalog_category((select (result->>'id')::uuid from category_result),1,'Categoria atualizada','categoria-teste',false,9,'Inativar categoria','category-edit','99000000-0000-4000-8000-000000000004')$$,
 $$select result from category_updated$$,'retry succeeds despite old expected revision');
select throws_ok($$select public.save_catalog_category((select (result->>'id')::uuid from category_result),1,'Perdida','categoria-teste',true,0,'Outra edição','category-stale','99000000-0000-4000-8000-000000000001')$$,
 'P0001','CATEGORY_REVISION_CONFLICT','stale update cannot overwrite a concurrent edit');
select is((select name from public.categories where id=(select (result->>'id')::uuid from category_result)),'Categoria atualizada','conflict preserves winner');
reset role;
select is((select count(*)::integer from public.audit_logs where entity_type='category' and entity_id=(select result->>'id' from category_result)),2,'exactly one audit per successful mutation');
select is((select metadata->'before'->>'name' from public.audit_logs where action='catalog.category.updated' and entity_id=(select result->>'id' from category_result)),'Categoria teste','audit retains before snapshot');
select is((select metadata->>'reason' from public.audit_logs where action='catalog.category.updated' and entity_id=(select result->>'id' from category_result)),'Inativar categoria','audit retains reason');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((select count(*)::integer from public.categories where slug='categoria-teste'),0,'inactive category hidden by RLS');
reset role;
select is((select count(*)::integer from public.categories where slug='categoria-teste'),1,'inactivation preserves category history');
select * from finish();
rollback;
