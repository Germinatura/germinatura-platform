create type public.stock_location_type as enum ('CENTRAL', 'SELLER');

create table public.stock_locations (
  id uuid primary key default gen_random_uuid(),
  location_type public.stock_location_type not null,
  name text not null,
  seller_id uuid references public.profiles(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_locations_name_valid check (
    char_length(name) between 1 and 120 and name = btrim(name)
  ),
  constraint stock_locations_owner_valid check (
    (location_type = 'CENTRAL' and seller_id is null)
    or (location_type = 'SELLER' and seller_id is not null)
  ),
  constraint stock_locations_seller_unique unique (seller_id)
);

create unique index stock_locations_one_active_central_idx
  on public.stock_locations (location_type)
  where location_type = 'CENTRAL' and active;

create index stock_locations_active_type_idx
  on public.stock_locations (location_type, active);

create table public.inventory_balances (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  on_hand_quantity bigint not null default 0,
  reserved_quantity bigint not null default 0,
  available_quantity bigint generated always as (on_hand_quantity - reserved_quantity) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_balances_location_product_unique unique (location_id, product_id),
  constraint inventory_balances_on_hand_valid check (
    on_hand_quantity between 0 and 9007199254740991
  ),
  constraint inventory_balances_reserved_valid check (
    reserved_quantity between 0 and 9007199254740991
  ),
  constraint inventory_balances_reservation_within_stock check (
    reserved_quantity <= on_hand_quantity
  )
);

create index inventory_balances_product_id_idx
  on public.inventory_balances (product_id);

create or replace function private.prevent_inventory_hard_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'INVENTORY_HARD_DELETE_FORBIDDEN';
end;
$$;

create trigger stock_locations_set_updated_at before update on public.stock_locations
for each row execute function private.set_updated_at();
create trigger inventory_balances_set_updated_at before update on public.inventory_balances
for each row execute function private.set_updated_at();
create trigger stock_locations_prevent_hard_delete before delete on public.stock_locations
for each row execute function private.prevent_inventory_hard_delete();
create trigger inventory_balances_prevent_hard_delete before delete on public.inventory_balances
for each row execute function private.prevent_inventory_hard_delete();

alter table public.stock_locations enable row level security;
alter table public.inventory_balances enable row level security;

revoke all on table public.stock_locations from public, anon, authenticated, service_role;
revoke all on table public.inventory_balances from public, anon, authenticated, service_role;
grant select on table public.stock_locations to authenticated;
grant select on table public.inventory_balances to authenticated;

create policy stock_locations_seller_read
on public.stock_locations for select to authenticated
using (
  location_type = 'SELLER'
  and seller_id = auth.uid()
  and public.has_permission('inventory.read')
);

create policy stock_locations_manager_read
on public.stock_locations for select to authenticated
using (public.has_permission('inventory.manage'));

create policy inventory_balances_seller_read
on public.inventory_balances for select to authenticated
using (
  public.has_permission('inventory.read')
  and exists (
    select 1 from public.stock_locations
    where stock_locations.id = inventory_balances.location_id
      and stock_locations.location_type = 'SELLER'
      and stock_locations.seller_id = auth.uid()
  )
);

create policy inventory_balances_manager_read
on public.inventory_balances for select to authenticated
using (public.has_permission('inventory.manage'));

revoke all on function private.prevent_inventory_hard_delete() from public, anon, authenticated, service_role;

comment on table public.stock_locations is 'Central and seller-owned inventory locations; deactivate instead of deleting.';
comment on table public.inventory_balances is 'Protected materialized inventory projection; future ledger RPCs are the only mutation path.';
