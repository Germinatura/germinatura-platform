begin;
select plan(32);

select has_table('public', 'categories', 'categories table exists');
select has_table('public', 'products', 'products table exists');
select has_table('public', 'product_prices', 'product prices table exists');
select col_type_is('public', 'product_prices', 'amount_cents', 'bigint', 'prices use bigint cents');
select has_index('public', 'products', 'products_sku_key', 'SKU is unique');
select has_index('public', 'product_prices', 'product_prices_product_validity_idx', 'price validity lookup is indexed');

select results_eq(
  $$select count(*)::bigint from pg_class where oid in ('public.categories'::regclass, 'public.products'::regclass, 'public.product_prices'::regclass) and relrowsecurity$$,
  array[3::bigint],
  'all catalog tables have RLS enabled'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename in ('categories', 'products', 'product_prices') and cmd in ('INSERT', 'UPDATE', 'DELETE')$$,
  array[0::bigint],
  'catalog has no direct write policies'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name in ('categories', 'products', 'product_prices') and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint],
  'API roles receive no catalog write grants'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name in ('categories', 'products', 'product_prices') and grantee = 'service_role'$$,
  array[0::bigint],
  'service role receives no direct catalog grants'
);

insert into public.categories (id, name, slug, active, sort_order) values
  ('20000000-0000-4000-8000-000000000001', 'Vestuário', 'vestuario', true, 1),
  ('20000000-0000-4000-8000-000000000002', 'Arquivo', 'arquivo', false, 2);

insert into public.products (
  id, category_id, sku, slug, name, active, published, sellable_pdv, reservable, tracks_lots
) values
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'CAMISETA-P', 'camiseta-p', 'Camiseta P', true, true, true, true, false),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'OCULTO', 'oculto', 'Produto oculto', true, false, false, false, false),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'INATIVO', 'inativo', 'Produto inativo', false, true, false, false, false),
  ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000002', 'CAT-INATIVA', 'cat-inativa', 'Categoria inativa', true, true, false, false, false);

insert into public.product_prices (id, product_id, amount_cents, valid_from, valid_to, created_by) values
  ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 1000, now() - interval '2 days', now() - interval '1 day', '10000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 1290, now() - interval '1 day', now() + interval '1 day', '10000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', 1490, now() + interval '1 day', null, '10000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000002', 500, now() - interval '1 day', null, null),
  ('40000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000004', 700, now() - interval '1 day', null, null);

select throws_ok(
  $$insert into public.product_prices (product_id, amount_cents, valid_from, valid_to) values ('30000000-0000-4000-8000-000000000001', 1300, now(), now() + interval '2 days')$$,
  '23P01',
  null,
  'overlapping price interval is rejected'
);
select lives_ok(
  $$insert into public.product_prices (product_id, amount_cents, valid_from, valid_to) values ('30000000-0000-4000-8000-000000000002', 600, now() - interval '2 days', now() - interval '1 day')$$,
  'adjacent price interval is accepted'
);
select throws_ok(
  $$insert into public.product_prices (product_id, amount_cents, valid_from) values ('30000000-0000-4000-8000-000000000003', -1, now())$$,
  '23514',
  null,
  'negative cents are rejected'
);
select throws_ok(
  $$insert into public.product_prices (product_id, amount_cents, valid_from) values ('30000000-0000-4000-8000-000000000003', 9007199254740992, now())$$,
  '23514',
  null,
  'cents above the TypeScript safe integer are rejected'
);
select throws_ok(
  $$insert into public.product_prices (product_id, amount_cents, valid_from, valid_to) values ('30000000-0000-4000-8000-000000000003', 100, now(), now())$$,
  '23514',
  null,
  'empty validity interval is rejected'
);
select throws_ok(
  $$insert into public.products (category_id, sku, slug, name) values ('20000000-0000-4000-8000-000000000001', 'sku-invalid', 'sku-invalid', 'SKU inválido')$$,
  '23514',
  null,
  'noncanonical SKU is rejected'
);

set local role anon;
select results_eq($$select array_agg(slug order by slug) from public.categories$$, $$values (array['vestuario'::text])$$, 'anonymous users see only active categories');
select results_eq($$select array_agg(slug order by slug) from public.products$$, $$values (array['camiseta-p'::text])$$, 'anonymous users see only public products in active categories');
select results_eq($$select array_agg(amount_cents order by amount_cents) from public.product_prices$$, $$values (array[1290::bigint])$$, 'anonymous users see only the current public price');
select throws_ok(
  $$insert into public.categories (name, slug) values ('Proibida', 'proibida')$$,
  '42501',
  null,
  'anonymous catalog writes are denied'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select results_eq($$select count(*)::bigint from public.products$$, array[1::bigint], 'consumer receives only the public catalog');
select results_eq($$select count(*)::bigint from public.product_prices$$, array[1::bigint], 'consumer cannot read price history');
select throws_ok(
  $$update public.products set published = false where id = '30000000-0000-4000-8000-000000000001'$$,
  '42501',
  null,
  'authenticated direct updates are denied'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq($$select count(*)::bigint from public.categories$$, array[2::bigint], 'catalog manager reads inactive categories');
select results_eq($$select count(*)::bigint from public.products$$, array[4::bigint], 'catalog manager reads unpublished and inactive products');
select results_eq($$select count(*)::bigint from public.product_prices$$, array[6::bigint], 'catalog manager reads complete price history');
select throws_ok(
  $$insert into public.categories (name, slug) values ('Direta', 'direta')$$,
  '42501',
  null,
  'catalog manager still cannot write tables directly'
);
reset role;

select throws_ok(
  $$delete from public.product_prices where id = '40000000-0000-4000-8000-000000000001'$$,
  'P0001',
  'CATALOG_HARD_DELETE_FORBIDDEN',
  'price history cannot be hard deleted'
);
select throws_ok(
  $$update public.product_prices set amount_cents = 1 where id = '40000000-0000-4000-8000-000000000001'$$,
  'P0001',
  'PRODUCT_PRICE_HISTORY_IMMUTABLE',
  'price history cannot be rewritten'
);
select throws_ok(
  $$delete from public.products where id = '30000000-0000-4000-8000-000000000002'$$,
  'P0001',
  'CATALOG_HARD_DELETE_FORBIDDEN',
  'historical products cannot be hard deleted'
);
select throws_ok(
  $$delete from public.categories where id = '20000000-0000-4000-8000-000000000002'$$,
  'P0001',
  'CATALOG_HARD_DELETE_FORBIDDEN',
  'historical categories cannot be hard deleted'
);

update public.products set name = 'Camiseta atualizada' where id = '30000000-0000-4000-8000-000000000001';
select ok(
  (select updated_at >= created_at from public.products where id = '30000000-0000-4000-8000-000000000001'),
  'product updates maintain updated_at'
);

select * from finish();
rollback;
