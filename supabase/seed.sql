-- Identidades exclusivamente locais. Os endereços e senhas abaixo são fixtures, nunca dados de produção.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  phone_change_token, email_change_token_current, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'admin.teste@institutojef.org.br', extensions.crypt('Admin123!', extensions.gen_salt('bf')), now(), '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{"name":"Admin Local"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'vendedor.teste@institutojef.org.br', extensions.crypt('Vendedor123!', extensions.gen_salt('bf')), now(), '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{"name":"Vendedor Local"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'consumidor.teste@institutojef.org.br', extensions.crypt('Consumidor123!', extensions.gen_salt('bf')), now(), '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{"name":"Consumidor Local"}', now(), now())
on conflict (id) do nothing;

insert into auth.identities (
  id, provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values
  (gen_random_uuid(), '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '{"sub":"10000000-0000-4000-8000-000000000001","email":"admin.teste@institutojef.org.br","email_verified":true}', 'email', now(), now(), now()),
  (gen_random_uuid(), '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '{"sub":"10000000-0000-4000-8000-000000000002","email":"vendedor.teste@institutojef.org.br","email_verified":true}', 'email', now(), now(), now()),
  (gen_random_uuid(), '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', '{"sub":"10000000-0000-4000-8000-000000000003","email":"consumidor.teste@institutojef.org.br","email_verified":true}', 'email', now(), now(), now())
on conflict (provider_id, provider) do nothing;

delete from public.user_roles where user_id in (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003'
);

insert into public.user_roles (user_id, role_id) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003');

insert into public.stock_locations (id, location_type, name, seller_id) values
  ('50000000-0000-4000-8000-000000000001', 'CENTRAL', 'Estoque central', null),
  ('50000000-0000-4000-8000-000000000002', 'SELLER', 'Estoque do vendedor local', '10000000-0000-4000-8000-000000000002')
on conflict (id) do update set
  name = excluded.name,
  active = true;

insert into public.categories (id, name, slug, active, sort_order) values
  ('23000000-0000-4000-8000-000000000001', 'Fixtures de concorrência', 'fixtures-concorrencia', false, 999)
on conflict (id) do update set active = false;

insert into public.products (
  id, category_id, sku, slug, name, active, published, sellable_pdv, reservable, tracks_lots
) values (
  '33000000-0000-4000-8000-000000000001',
  '23000000-0000-4000-8000-000000000001',
  'CONCURRENCY-ITEM',
  'concurrency-item',
  'Item local para testes de concorrência',
  true, false, false, true, false
)
on conflict (id) do update set active = true, reservable = true;

insert into public.inventory_balances (location_id, product_id)
values (
  '50000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000001'
)
on conflict (location_id, product_id) do nothing;

insert into public.categories (id, name, slug, active, sort_order) values
  ('23f00000-0000-4000-8000-000000000001', 'Catálogo público local', 'catalogo-publico-local', true, 10)
on conflict (id) do update set name = excluded.name, active = true, sort_order = excluded.sort_order;

insert into public.products (
  id, category_id, sku, slug, name, description, active, published, sellable_pdv, reservable, tracks_lots
) values
  (
    '33f00000-0000-4000-8000-000000000001',
    '23f00000-0000-4000-8000-000000000001',
    'PUBLIC-ITEM-A',
    'public-item-a',
    'Item público A',
    'Fixture pública para o catálogo local.',
    true, true, true, true, false
  ),
  (
    '33f00000-0000-4000-8000-000000000002',
    '23f00000-0000-4000-8000-000000000001',
    'HIDDEN-ITEM',
    'hidden-item',
    'Item não publicado',
    null,
    true, false, true, true, false
  ),
  (
    '33f00000-0000-4000-8000-000000000003',
    '23f00000-0000-4000-8000-000000000001',
    'PUBLIC-ITEM-B',
    'public-item-b',
    'Item público B',
    null,
    true, true, true, false, false
  )
on conflict (id) do update set
  category_id = excluded.category_id,
  name = excluded.name,
  description = excluded.description,
  active = excluded.active,
  published = excluded.published,
  sellable_pdv = excluded.sellable_pdv,
  reservable = excluded.reservable,
  tracks_lots = excluded.tracks_lots;

insert into public.product_prices (id, product_id, amount_cents, valid_from) values
  ('43f00000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001', 2590, '2026-01-01T00:00:00Z'),
  ('43f00000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000002', 1990, '2026-01-01T00:00:00Z'),
  ('43f00000-0000-4000-8000-000000000003', '33f00000-0000-4000-8000-000000000003', 3490, '2026-01-01T00:00:00Z')
on conflict (id) do nothing;
