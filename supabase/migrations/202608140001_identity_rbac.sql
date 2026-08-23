create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key in (
    'ADMIN', 'VENDEDOR', 'ESTOQUE', 'FINANCEIRO', 'COMUNICACAO', 'MODERADOR', 'CONSUMIDOR'
  )),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text not null,
  created_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

insert into public.roles (id, key, name) values
  ('00000000-0000-4000-8000-000000000001', 'ADMIN', 'Administrador'),
  ('00000000-0000-4000-8000-000000000002', 'VENDEDOR', 'Vendedor'),
  ('00000000-0000-4000-8000-000000000003', 'CONSUMIDOR', 'Consumidor'),
  ('00000000-0000-4000-8000-000000000004', 'ESTOQUE', 'Estoque'),
  ('00000000-0000-4000-8000-000000000005', 'FINANCEIRO', 'Financeiro'),
  ('00000000-0000-4000-8000-000000000006', 'COMUNICACAO', 'Comunicação'),
  ('00000000-0000-4000-8000-000000000007', 'MODERADOR', 'Moderador');

insert into public.permissions (key, description) values
  ('portal.access', 'Acessar o Portal'),
  ('admin.access', 'Acessar a área administrativa'),
  ('catalog.read', 'Consultar catálogo'),
  ('catalog.manage', 'Administrar catálogo'),
  ('inventory.read', 'Consultar estoque'),
  ('inventory.manage', 'Administrar estoque'),
  ('sales.create', 'Criar vendas'),
  ('sales.read.own', 'Consultar as próprias vendas'),
  ('sales.read.all', 'Consultar todas as vendas'),
  ('reservations.manage.own', 'Administrar as próprias reservas'),
  ('reservations.manage.all', 'Administrar todas as reservas'),
  ('raffles.buy', 'Comprar números de rifa'),
  ('raffles.sell', 'Vender números de rifa no PDV'),
  ('raffles.manage', 'Administrar rifas'),
  ('users.manage', 'Administrar usuários e permissões'),
  ('finance.manage', 'Administrar o financeiro'),
  ('communications.manage', 'Administrar comunicações'),
  ('community.moderate', 'Moderar conteúdo da comunidade');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key = 'ADMIN';

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key = 'VENDEDOR' and p.key in (
  'portal.access', 'catalog.read', 'inventory.read', 'sales.create', 'sales.read.own',
  'reservations.manage.own', 'raffles.buy', 'raffles.sell'
);

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where (r.key = 'ESTOQUE' and p.key in ('portal.access', 'catalog.read', 'inventory.read', 'inventory.manage'))
   or (r.key = 'FINANCEIRO' and p.key in ('portal.access', 'sales.read.all', 'finance.manage'))
   or (r.key = 'COMUNICACAO' and p.key in ('portal.access', 'communications.manage'))
   or (r.key = 'MODERADOR' and p.key in ('portal.access', 'community.moderate'))
   or (r.key = 'CONSUMIDOR' and p.key in ('portal.access', 'catalog.read', 'reservations.manage.own', 'raffles.buy'));

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)));

  insert into public.user_roles (user_id, role_id)
  select new.id, id from public.roles where key = 'CONSUMIDOR';
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

create or replace function public.has_permission(required_permission text)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p on p.id = rp.permission_id
    where ur.user_id = auth.uid() and p.key = required_permission
  );
$$;

create or replace function public.get_my_session()
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  select jsonb_build_object(
    'auth_id', u.id,
    'email', u.email,
    'display_name', p.display_name,
    'roles', coalesce(jsonb_agg(r.key order by r.key) filter (where r.key is not null), '[]'::jsonb)
  )
  from auth.users u
  join public.profiles p on p.id = u.id
  left join public.user_roles ur on ur.user_id = p.id
  left join public.roles r on r.id = ur.role_id
  where u.id = auth.uid()
  group by u.id, u.email, p.display_name;
$$;

revoke all on function public.has_permission(text) from public;
revoke all on function public.get_my_session() from public;
grant execute on function public.has_permission(text) to authenticated, service_role;
grant execute on function public.get_my_session() to authenticated, service_role;

alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.user_roles enable row level security;
alter table public.role_permissions enable row level security;

create policy "profiles_select_self" on public.profiles
  for select to authenticated using (id = auth.uid());
create policy "roles_read_authenticated" on public.roles
  for select to authenticated using (true);
create policy "permissions_read_authenticated" on public.permissions
  for select to authenticated using (true);
create policy "user_roles_select_self" on public.user_roles
  for select to authenticated using (user_id = auth.uid());
create policy "role_permissions_read_authenticated" on public.role_permissions
  for select to authenticated using (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "catalog_images_public_read" on storage.objects
  for select using (bucket_id = 'product-images');
create policy "catalog_images_admin_insert" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'product-images' and public.has_permission('catalog.manage')
  );
create policy "catalog_images_admin_update" on storage.objects
  for update to authenticated using (
    bucket_id = 'product-images' and public.has_permission('catalog.manage')
  );
create policy "catalog_images_admin_delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'product-images' and public.has_permission('catalog.manage')
  );
