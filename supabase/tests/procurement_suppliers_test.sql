begin;
select plan(28);

select ok(has_table_privilege('authenticated', 'public.suppliers', 'SELECT'), 'authenticated role can reach supplier reads through RLS');
select ok(not has_table_privilege('authenticated', 'public.suppliers', 'INSERT'), 'direct supplier inserts remain denied');
select ok(not has_table_privilege('authenticated', 'public.suppliers', 'UPDATE'), 'direct supplier updates remain denied');
select ok(not has_table_privilege('service_role', 'public.suppliers', 'INSERT'), 'service role receives no direct supplier write grant');
select ok(not has_function_privilege('anon', 'public.save_supplier(uuid,integer,text,text,text,text,text,text,boolean,text,text,uuid)', 'EXECUTE'), 'anonymous supplier command execution denied');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.save_supplier(null,null,'Fornecedor negado','Contato',null,null,null,null,true,'Teste de permissão','supplier-consumer','a1000000-0000-4000-8000-000000000001')$$,
  '42501', 'PROCUREMENT_MANAGE_FORBIDDEN', 'consumer cannot create suppliers'
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.save_supplier(null,null,'Fornecedor vendedor','Contato',null,null,null,null,true,'Teste de permissão','supplier-seller','a1000000-0000-4000-8000-000000000002')$$,
  '42501', 'PROCUREMENT_MANAGE_FORBIDDEN', 'seller cannot create suppliers'
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table supplier_created as
select public.save_supplier(
  null, null, 'Doces Exemplo', 'Ana Compras', 'ANA@EXAMPLE.COM', '(11) 99999-0000',
  '12.345.678/0001-90', 'Entrega às sextas', true, 'Cadastro inicial homologado',
  'supplier-create', 'a1000000-0000-4000-8000-000000000003'
) result;

select is((select result->>'revision' from supplier_created), '1', 'supplier creation starts at revision one');
select is((select result->>'email' from supplier_created), 'ana@example.com', 'email is normalized by the server');
select is((select result->>'document' from supplier_created), '12345678000190', 'document is normalized by the server');
select results_eq(
  $$select public.save_supplier(null,null,'Doces Exemplo','Ana Compras','ANA@EXAMPLE.COM','(11) 99999-0000','12.345.678/0001-90','Entrega às sextas',true,'Cadastro inicial homologado','supplier-create','a1000000-0000-4000-8000-000000000099')$$,
  $$select result from supplier_created$$,
  'retry returns the original supplier result'
);
select throws_ok(
  $$select public.save_supplier(null,null,'Outro nome','Ana Compras','ANA@EXAMPLE.COM','(11) 99999-0000','12.345.678/0001-90','Entrega às sextas',true,'Cadastro inicial homologado','supplier-create','a1000000-0000-4000-8000-000000000003')$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with changed supplier payload is rejected'
);
select throws_ok(
  $$select public.save_supplier(null,null,'Sem contato',null,null,null,null,null,true,'Cadastro inválido','supplier-no-contact','a1000000-0000-4000-8000-000000000004')$$,
  '22023', 'INVALID_SUPPLIER', 'a supplier requires at least one contact'
);
select throws_ok(
  $$select public.save_supplier(null,null,'Documento repetido','Outro contato',null,'11900000000','12345678000190',null,true,'Testar documento','supplier-duplicate-document','a1000000-0000-4000-8000-000000000005')$$,
  '23505', null, 'normalized supplier document remains unique'
);

create temp table supplier_updated as
select public.save_supplier(
  (select (result->>'id')::uuid from supplier_created), 1, 'Doces Exemplo Ltda', 'Ana Compras',
  'ana@example.com', '(11) 99999-0000', '12345678000190', 'Entrega quinzenal', false,
  'Fornecedor temporariamente inativo', 'supplier-update', 'a1000000-0000-4000-8000-000000000006'
) result;
select is((select result->>'revision' from supplier_updated), '2', 'supplier update increments revision');
select is((select result->>'active' from supplier_updated), 'false', 'supplier can be inactivated without deletion');
select results_eq(
  $$select public.save_supplier((select (result->>'id')::uuid from supplier_created),1,'Doces Exemplo Ltda','Ana Compras','ana@example.com','(11) 99999-0000','12345678000190','Entrega quinzenal',false,'Fornecedor temporariamente inativo','supplier-update','a1000000-0000-4000-8000-000000000099')$$,
  $$select result from supplier_updated$$,
  'update retry succeeds despite the original expected revision'
);
select throws_ok(
  $$select public.save_supplier((select (result->>'id')::uuid from supplier_created),1,'Edição perdida','Ana Compras','ana@example.com',null,'12345678000190',null,true,'Edição concorrente','supplier-stale','a1000000-0000-4000-8000-000000000007')$$,
  'P0001', 'SUPPLIER_REVISION_CONFLICT', 'stale supplier edit cannot overwrite the winner'
);
select is((select name from public.suppliers where id=(select (result->>'id')::uuid from supplier_created)), 'Doces Exemplo Ltda', 'conflict preserves the winning supplier edit');
select throws_ok(
  $$select public.save_supplier('a2000000-0000-4000-8000-000000000001',1,'Inexistente','Contato',null,null,null,null,true,'Editar inexistente','supplier-missing','a1000000-0000-4000-8000-000000000008')$$,
  'P0002', 'SUPPLIER_NOT_FOUND', 'unknown supplier cannot be edited'
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((select count(*)::integer from public.suppliers), 0, 'consumer sees no suppliers through RLS');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is((select count(*)::integer from public.suppliers where id=(select (result->>'id')::uuid from supplier_created)), 1, 'administrator reads the retained inactive supplier');
reset role;

select is((select count(*)::integer from public.audit_logs where entity_type='supplier' and entity_id=(select result->>'id' from supplier_created)), 2, 'one audit record exists per successful supplier mutation');
select is((select metadata->'before'->>'name' from public.audit_logs where action='procurement.supplier.updated' and entity_id=(select result->>'id' from supplier_created)), 'Doces Exemplo', 'audit preserves the prior supplier snapshot');
select is((select metadata->>'reason' from public.audit_logs where action='procurement.supplier.updated' and entity_id=(select result->>'id' from supplier_created)), 'Fornecedor temporariamente inativo', 'audit preserves the stated reason');
select is((select count(*)::integer from public.outbox_events where aggregate_type='supplier' and aggregate_id=(select result->>'id' from supplier_created)), 2, 'one outbox event exists per successful supplier mutation');
select is((select count(*)::integer from public.idempotency_keys where key in ('supplier-create','supplier-update') and status='SUCCEEDED'), 2, 'only successful supplier commands retain idempotency claims');
select is((select count(*)::integer from public.suppliers where id=(select (result->>'id')::uuid from supplier_created) and active=false), 1, 'inactivation retains the supplier row');

select * from finish();
rollback;
