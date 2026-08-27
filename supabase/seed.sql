-- Identidades exclusivamente locais. Os endereços e senhas abaixo são fixtures, nunca dados de produção.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  phone_change_token, email_change_token_current, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'admin@germinatura.test', extensions.crypt('Admin123!', extensions.gen_salt('bf')), now(), '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{"name":"Admin Local"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'vendedor@germinatura.test', extensions.crypt('Vendedor123!', extensions.gen_salt('bf')), now(), '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{"name":"Vendedor Local"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'consumidor@germinatura.test', extensions.crypt('Consumidor123!', extensions.gen_salt('bf')), now(), '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{"name":"Consumidor Local"}', now(), now())
on conflict (id) do nothing;

insert into auth.identities (
  id, provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values
  (gen_random_uuid(), '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '{"sub":"10000000-0000-4000-8000-000000000001","email":"admin@germinatura.test","email_verified":true}', 'email', now(), now(), now()),
  (gen_random_uuid(), '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '{"sub":"10000000-0000-4000-8000-000000000002","email":"vendedor@germinatura.test","email_verified":true}', 'email', now(), now(), now()),
  (gen_random_uuid(), '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', '{"sub":"10000000-0000-4000-8000-000000000003","email":"consumidor@germinatura.test","email_verified":true}', 'email', now(), now(), now())
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
