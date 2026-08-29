create type public.promotion_channel as enum ('PORTAL', 'PDV', 'RESERVA');
create type public.promotion_rule_type as enum ('QUANTIDADE_PRECO');

create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  active boolean not null default false,
  publicable boolean not null default false,
  priority integer not null default 0,
  cumulative boolean not null default false,
  valid_from timestamptz not null,
  valid_to timestamptz,
  global_redemption_limit bigint,
  per_user_redemption_limit integer,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotions_code_valid check (
    char_length(code) between 1 and 80 and code = btrim(code)
    and code ~ '^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$'
  ),
  constraint promotions_name_valid check (
    char_length(name) between 1 and 160 and name = btrim(name)
  ),
  constraint promotions_description_valid check (
    description is null
    or (char_length(description) between 1 and 2000 and description = btrim(description))
  ),
  constraint promotions_priority_valid check (priority between 0 and 1000),
  constraint promotions_validity_valid check (valid_to is null or valid_to > valid_from),
  constraint promotions_global_limit_valid check (
    global_redemption_limit is null
    or global_redemption_limit between 1 and 9007199254740991
  ),
  constraint promotions_per_user_limit_valid check (
    per_user_redemption_limit is null or per_user_redemption_limit >= 1
  )
);

create index promotions_current_lookup_idx
  on public.promotions (active, publicable, valid_from, valid_to, priority desc);

create table public.promotion_products (
  promotion_id uuid not null references public.promotions(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (promotion_id, product_id)
);

create index promotion_products_product_idx
  on public.promotion_products (product_id, promotion_id);

create table public.promotion_channels (
  promotion_id uuid not null references public.promotions(id) on delete restrict,
  channel public.promotion_channel not null,
  created_at timestamptz not null default now(),
  primary key (promotion_id, channel)
);

create index promotion_channels_channel_idx
  on public.promotion_channels (channel, promotion_id);

create table public.promotion_quantity_price_rules (
  promotion_id uuid primary key references public.promotions(id) on delete restrict,
  rule_type public.promotion_rule_type not null default 'QUANTIDADE_PRECO',
  group_quantity integer not null,
  group_price_cents bigint not null,
  max_groups_per_line integer,
  created_at timestamptz not null default now(),
  constraint promotion_quantity_rules_group_valid check (group_quantity >= 2),
  constraint promotion_quantity_rules_price_valid check (
    group_price_cents between 0 and 9007199254740991
  ),
  constraint promotion_quantity_rules_max_groups_valid check (
    max_groups_per_line is null or max_groups_per_line >= 1
  )
);

create or replace function private.prevent_promotion_hard_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'PROMOTION_HARD_DELETE_FORBIDDEN';
end;
$$;

create trigger promotions_set_updated_at before update on public.promotions
for each row execute function private.set_updated_at();
create trigger promotions_prevent_hard_delete before delete on public.promotions
for each row execute function private.prevent_promotion_hard_delete();
create trigger promotion_products_prevent_hard_delete before delete on public.promotion_products
for each row execute function private.prevent_promotion_hard_delete();
create trigger promotion_channels_prevent_hard_delete before delete on public.promotion_channels
for each row execute function private.prevent_promotion_hard_delete();
create trigger promotion_quantity_rules_prevent_hard_delete before delete on public.promotion_quantity_price_rules
for each row execute function private.prevent_promotion_hard_delete();

alter table public.promotions enable row level security;
alter table public.promotion_products enable row level security;
alter table public.promotion_channels enable row level security;
alter table public.promotion_quantity_price_rules enable row level security;

revoke all on table public.promotions from public, anon, authenticated, service_role;
revoke all on table public.promotion_products from public, anon, authenticated, service_role;
revoke all on table public.promotion_channels from public, anon, authenticated, service_role;
revoke all on table public.promotion_quantity_price_rules from public, anon, authenticated, service_role;
grant select on table public.promotions to anon, authenticated;
grant select on table public.promotion_products to anon, authenticated;
grant select on table public.promotion_channels to anon, authenticated;
grant select on table public.promotion_quantity_price_rules to anon, authenticated;

create policy promotions_public_current_read on public.promotions for select to anon, authenticated
using (
  active and publicable
  and valid_from <= now() and (valid_to is null or valid_to > now())
);
create policy promotions_manager_read on public.promotions for select to authenticated
using (public.has_permission('catalog.manage'));

create policy promotion_products_public_current_read on public.promotion_products for select to anon, authenticated
using (
  exists (
    select 1 from public.promotions
    where promotions.id = promotion_products.promotion_id
      and promotions.active and promotions.publicable
      and promotions.valid_from <= now()
      and (promotions.valid_to is null or promotions.valid_to > now())
  )
  and exists (
    select 1 from public.products
    join public.categories on categories.id = products.category_id
    where products.id = promotion_products.product_id
      and products.active and products.published and categories.active
  )
);
create policy promotion_products_manager_read on public.promotion_products for select to authenticated
using (public.has_permission('catalog.manage'));

create policy promotion_channels_public_current_read on public.promotion_channels for select to anon, authenticated
using (
  exists (
    select 1 from public.promotions
    where promotions.id = promotion_channels.promotion_id
      and promotions.active and promotions.publicable
      and promotions.valid_from <= now()
      and (promotions.valid_to is null or promotions.valid_to > now())
  )
);
create policy promotion_channels_manager_read on public.promotion_channels for select to authenticated
using (public.has_permission('catalog.manage'));

create policy promotion_quantity_rules_public_current_read
on public.promotion_quantity_price_rules for select to anon, authenticated
using (
  exists (
    select 1 from public.promotions
    where promotions.id = promotion_quantity_price_rules.promotion_id
      and promotions.active and promotions.publicable
      and promotions.valid_from <= now()
      and (promotions.valid_to is null or promotions.valid_to > now())
  )
);
create policy promotion_quantity_rules_manager_read
on public.promotion_quantity_price_rules for select to authenticated
using (public.has_permission('catalog.manage'));

create view public.current_quantity_price_promotions
with (security_invoker = true)
as
select
  promotions.id as promotion_id,
  promotions.code,
  promotions.name,
  promotions.priority,
  promotions.cumulative,
  promotions.valid_from,
  promotions.valid_to,
  promotions.global_redemption_limit,
  promotions.per_user_redemption_limit,
  promotion_products.product_id,
  promotion_channels.channel,
  promotion_quantity_price_rules.rule_type,
  promotion_quantity_price_rules.group_quantity,
  promotion_quantity_price_rules.group_price_cents,
  promotion_quantity_price_rules.max_groups_per_line
from public.promotions
join public.promotion_products
  on promotion_products.promotion_id = promotions.id
join public.products on products.id = promotion_products.product_id
join public.categories on categories.id = products.category_id
join public.promotion_channels
  on promotion_channels.promotion_id = promotions.id
join public.promotion_quantity_price_rules
  on promotion_quantity_price_rules.promotion_id = promotions.id
where promotions.active and promotions.publicable
  and promotions.valid_from <= now()
  and (promotions.valid_to is null or promotions.valid_to > now())
  and products.active and categories.active
  and case promotion_channels.channel
    when 'PORTAL' then products.published
    when 'PDV' then products.sellable_pdv
    when 'RESERVA' then products.reservable
  end;

revoke all on table public.current_quantity_price_promotions
from public, anon, authenticated, service_role;
grant select on table public.current_quantity_price_promotions to anon, authenticated;

revoke all on function private.prevent_promotion_hard_delete()
from public, anon, authenticated, service_role;

comment on table public.promotions is
  'Promotion lifecycle, half-open validity, priority, cumulativity and optional redemption limits.';
comment on table public.promotion_products is
  'Explicit product scope for promotion rules; products remain canonical catalog items.';
comment on table public.promotion_channels is
  'Channels where a promotion may be considered by authoritative pricing.';
comment on table public.promotion_quantity_price_rules is
  'Persisted QUANTIDADE_PRECO rules in integer cents; other rule types are deliberately unsupported.';
comment on view public.current_quantity_price_promotions is
  'Security-invoker read model for active, publicable, channel-compatible QUANTIDADE_PRECO rules. Overlap is intentional; authoritative pricing resolves priority and economics.';
