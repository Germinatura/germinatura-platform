begin;
select plan(20);

select ok(not has_function_privilege('anon', 'public.set_catalog_product_price(uuid,integer,bigint,text,text,uuid)', 'EXECUTE'), 'anonymous price command execution denied');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.set_catalog_product_price('33f00000-0000-4000-8000-000000000001',1,2790,'Definir novo preço','price-forbidden','99000000-0000-4000-8000-000000000001')$$,
  '42501','CATALOG_MANAGE_FORBIDDEN','consumer cannot define prices through RPC');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table price_result as
  select public.set_catalog_product_price('33f00000-0000-4000-8000-000000000001',1,2790,'Definir novo preço','price-create','99000000-0000-4000-8000-000000000001') as result;
select is((select result->>'amountCents' from price_result), '2790', 'price command returns the integer-cent amount');
select is((select result->>'productRevision' from price_result), '2', 'price command increments product revision');
select ok((select result->>'previousPriceId' from price_result) is not null, 'current price is linked as the prior interval');
select results_eq($$select public.set_catalog_product_price('33f00000-0000-4000-8000-000000000001',1,2790,'Definir novo preço','price-create','99000000-0000-4000-8000-000000000002')$$,
  $$select result from price_result$$, 'same idempotency key replays the original price result');
select throws_ok($$select public.set_catalog_product_price('33f00000-0000-4000-8000-000000000001',2,2890,'Conteúdo divergente','price-create','99000000-0000-4000-8000-000000000001')$$,
  'P0001','IDEMPOTENCY_CONFLICT','same price key with a divergent request is rejected');
select is((select count(*)::integer from public.product_prices where product_id='33f00000-0000-4000-8000-000000000001'), 2, 'new price appends one historical row');
select is((select amount_cents from public.product_prices where product_id='33f00000-0000-4000-8000-000000000001' order by valid_from limit 1), 2590::bigint, 'prior amount is preserved');
select ok((select old.valid_to = current.valid_from from public.product_prices old cross join public.product_prices current where old.product_id='33f00000-0000-4000-8000-000000000001' and old.amount_cents=2590 and current.amount_cents=2790), 'old and new price intervals are adjacent');
select throws_ok($$select public.set_catalog_product_price('33f00000-0000-4000-8000-000000000001',2,2790,'Mesmo preço vigente','price-unchanged','99000000-0000-4000-8000-000000000001')$$,
  'P0001','PRODUCT_PRICE_UNCHANGED','current amount cannot be appended again');
select throws_ok($$select public.set_catalog_product_price('33f00000-0000-4000-8000-000000000001',1,2990,'Edição concorrente','price-stale','99000000-0000-4000-8000-000000000001')$$,
  'P0001','PRODUCT_REVISION_CONFLICT','stale product revision cannot replace the winning price');
select throws_ok($$select public.set_catalog_product_price('99999999-0000-4000-8000-000000000001',1,100,'Produto ausente','price-missing','99000000-0000-4000-8000-000000000001')$$,
  'P0002','PRODUCT_NOT_FOUND','unknown product is rejected');
select throws_ok($$select public.set_catalog_product_price('33f00000-0000-4000-8000-000000000001',2,-1,'Preço inválido','price-invalid','99000000-0000-4000-8000-000000000001')$$,
  '22023','INVALID_CATALOG_PRODUCT_PRICE','invalid cents are rejected at database boundary');
reset role;

select is((select count(*)::integer from public.audit_logs where action='catalog.product_price.set' and entity_id=(select result->>'id' from price_result)), 1, 'one audit row exists for the successful command');
select is((select metadata->>'reason' from public.audit_logs where action='catalog.product_price.set' and entity_id=(select result->>'id' from price_result)), 'Definir novo preço', 'audit preserves the reason');
select is((select metadata->'previous_price'->>'amount_cents' from public.audit_logs where action='catalog.product_price.set' and entity_id=(select result->>'id' from price_result)), '2590', 'audit preserves the prior price snapshot');
select throws_ok($$update public.product_prices set amount_cents = 1 where product_id='33f00000-0000-4000-8000-000000000001' and amount_cents=2790$$,
  'P0001','PRODUCT_PRICE_HISTORY_IMMUTABLE','amount remains immutable after a price command');

update public.product_prices set valid_to = statement_timestamp()
where product_id='33f00000-0000-4000-8000-000000000003' and valid_to is null;
insert into public.product_prices (product_id, amount_cents, valid_from, created_by)
values ('33f00000-0000-4000-8000-000000000003', 3890, statement_timestamp() + interval '1 hour', '10000000-0000-4000-8000-000000000001');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table scheduled_result as
  select public.set_catalog_product_price('33f00000-0000-4000-8000-000000000003',1,3590,'Alterar antes do agendamento','price-scheduled','99000000-0000-4000-8000-000000000001') as result;
select ok((select result->>'validTo' from scheduled_result) is not null, 'new immediate price ends at the pre-existing future price');
select ok((select (result->>'validTo')::timestamptz = valid_from from scheduled_result cross join public.product_prices where product_id='33f00000-0000-4000-8000-000000000003' and amount_cents=3890), 'scheduled price remains intact after setting the current price');
reset role;

select * from finish();
rollback;
