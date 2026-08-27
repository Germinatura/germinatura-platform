create extension if not exists btree_gist with schema extensions;

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_name_valid check (char_length(name) between 1 and 120 and name = btrim(name)),
  constraint categories_slug_valid check (
    char_length(slug) between 1 and 80 and slug = btrim(slug)
    and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  constraint categories_sort_order_valid check (sort_order >= 0)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories(id) on delete restrict,
  sku text not null unique,
  slug text not null unique,
  name text not null,
  description text,
  active boolean not null default true,
  published boolean not null default false,
  sellable_pdv boolean not null default false,
  reservable boolean not null default false,
  tracks_lots boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_sku_valid check (
    char_length(sku) between 1 and 64 and sku = btrim(sku)
    and sku ~ '^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$'
  ),
  constraint products_slug_valid check (
    char_length(slug) between 1 and 100 and slug = btrim(slug)
    and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  constraint products_name_valid check (char_length(name) between 1 and 160 and name = btrim(name)),
  constraint products_description_valid check (
    description is null
    or (char_length(description) between 1 and 2000 and description = btrim(description))
  )
);

create index products_category_id_idx on public.products (category_id);

create table public.product_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  amount_cents bigint not null,
  valid_from timestamptz not null,
  valid_to timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint product_prices_amount_cents_valid check (amount_cents between 0 and 9007199254740991),
  constraint product_prices_validity_valid check (valid_to is null or valid_to > valid_from),
  constraint product_prices_no_overlap exclude using gist (
    product_id with =,
    tstzrange(valid_from, valid_to, '[)') with &&
  )
);

create index product_prices_product_validity_idx
  on public.product_prices (product_id, valid_from desc);

create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.prevent_catalog_hard_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'CATALOG_HARD_DELETE_FORBIDDEN';
end;
$$;

create or replace function private.prevent_product_price_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'PRODUCT_PRICE_HISTORY_IMMUTABLE';
end;
$$;

create trigger categories_set_updated_at before update on public.categories
for each row execute function private.set_updated_at();
create trigger products_set_updated_at before update on public.products
for each row execute function private.set_updated_at();
create trigger categories_prevent_hard_delete before delete on public.categories
for each row execute function private.prevent_catalog_hard_delete();
create trigger products_prevent_hard_delete before delete on public.products
for each row execute function private.prevent_catalog_hard_delete();
create trigger product_prices_prevent_hard_delete before delete on public.product_prices
for each row execute function private.prevent_catalog_hard_delete();
create trigger product_prices_prevent_update before update on public.product_prices
for each row execute function private.prevent_product_price_update();

alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_prices enable row level security;

revoke all on table public.categories from public, anon, authenticated, service_role;
revoke all on table public.products from public, anon, authenticated, service_role;
revoke all on table public.product_prices from public, anon, authenticated, service_role;
grant select on table public.categories to anon, authenticated;
grant select on table public.products to anon, authenticated;
grant select on table public.product_prices to anon, authenticated;

create policy categories_public_read on public.categories for select to anon, authenticated
using (active);
create policy categories_manager_read on public.categories for select to authenticated
using (public.has_permission('catalog.manage'));

create policy products_public_read on public.products for select to anon, authenticated
using (
  active and published
  and exists (
    select 1 from public.categories
    where categories.id = products.category_id and categories.active
  )
);
create policy products_manager_read on public.products for select to authenticated
using (public.has_permission('catalog.manage'));

create policy product_prices_public_current_read on public.product_prices for select to anon, authenticated
using (
  valid_from <= now() and (valid_to is null or valid_to > now())
  and exists (
    select 1 from public.products
    join public.categories on categories.id = products.category_id
    where products.id = product_prices.product_id
      and products.active and products.published and categories.active
  )
);
create policy product_prices_manager_read on public.product_prices for select to authenticated
using (public.has_permission('catalog.manage'));

revoke all on function private.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function private.prevent_catalog_hard_delete() from public, anon, authenticated, service_role;
revoke all on function private.prevent_product_price_update() from public, anon, authenticated, service_role;

comment on table public.categories is 'Normalized catalog categories; deactivate rows instead of deleting history.';
comment on table public.products is 'Catalog products with channel and inventory behavior flags.';
comment on table public.product_prices is 'Immutable price validity history in integer cents using half-open intervals.';
