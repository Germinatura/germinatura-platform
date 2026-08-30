create type public.sale_status as enum (
  'DRAFT',
  'AWAITING_PAYMENT',
  'CONFIRMED',
  'CANCELLED'
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  channel public.promotion_channel not null,
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  customer_id uuid references public.profiles(id) on delete restrict,
  status public.sale_status not null default 'DRAFT',
  currency text not null default 'BRL',
  original_total_cents bigint not null,
  discount_total_cents bigint not null default 0,
  total_cents bigint not null,
  quoted_at timestamptz not null,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_currency_brl check (currency = 'BRL'),
  constraint sales_money_valid check (
    original_total_cents between 0 and 9007199254740991
    and discount_total_cents between 0 and original_total_cents
    and total_cents = original_total_cents - discount_total_cents
  ),
  constraint sales_customer_channel_valid check (
    channel <> 'PORTAL' or customer_id is not null
  )
);

create index sales_created_by_created_idx on public.sales (created_by, created_at desc);
create index sales_customer_created_idx on public.sales (customer_id, created_at desc)
  where customer_id is not null;
create index sales_location_created_idx on public.sales (location_id, created_at desc);
create index sales_status_created_idx on public.sales (status, created_at desc);
create index sales_correlation_id_idx on public.sales (correlation_id);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  product_sku text not null,
  product_name text not null,
  quantity bigint not null,
  unit_price_cents bigint not null,
  original_subtotal_cents bigint not null,
  discount_cents bigint not null default 0,
  total_cents bigint not null,
  promotion_id uuid references public.promotions(id) on delete restrict,
  promotion_snapshot jsonb,
  created_at timestamptz not null default now(),
  constraint sale_items_sale_product_unique unique (sale_id, product_id),
  constraint sale_items_product_sku_valid check (
    char_length(product_sku) between 1 and 64 and product_sku = btrim(product_sku)
    and product_sku ~ '^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$'
  ),
  constraint sale_items_product_name_valid check (
    char_length(product_name) between 1 and 160 and product_name = btrim(product_name)
  ),
  constraint sale_items_quantity_valid check (quantity between 1 and 9007199254740991),
  constraint sale_items_money_valid check (
    unit_price_cents between 0 and 9007199254740991
    and original_subtotal_cents = unit_price_cents * quantity
    and discount_cents between 0 and original_subtotal_cents
    and total_cents = original_subtotal_cents - discount_cents
  ),
  constraint sale_items_promotion_pair_valid check (
    (promotion_id is null and promotion_snapshot is null)
    or (
      promotion_id is not null
      and promotion_snapshot is not null
      and jsonb_typeof(promotion_snapshot) = 'object'
    )
  )
);

create index sale_items_product_id_idx on public.sale_items (product_id);

create table public.sale_status_history (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  from_status public.sale_status,
  to_status public.sale_status not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint sale_status_history_change_valid check (
    from_status is null or from_status <> to_status
  ),
  constraint sale_status_history_reason_valid check (
    reason is null or (char_length(reason) between 1 and 500 and reason = btrim(reason))
  )
);

create index sale_status_history_sale_created_idx
  on public.sale_status_history (sale_id, created_at, id);
create index sale_status_history_correlation_idx
  on public.sale_status_history (correlation_id);

create or replace function private.guard_sale_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then
      raise exception using errcode = 'P0001', message = 'SALE_MUST_START_AS_DRAFT';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
    or new.channel is distinct from old.channel
    or new.location_id is distinct from old.location_id
    or new.created_by is distinct from old.created_by
    or new.customer_id is distinct from old.customer_id
    or new.currency is distinct from old.currency
    or new.original_total_cents is distinct from old.original_total_cents
    or new.discount_total_cents is distinct from old.discount_total_cents
    or new.total_cents is distinct from old.total_cents
    or new.quoted_at is distinct from old.quoted_at
    or new.correlation_id is distinct from old.correlation_id
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'P0001', message = 'SALE_SNAPSHOT_IMMUTABLE';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.prevent_sale_hard_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'SALE_HARD_DELETE_FORBIDDEN';
end;
$$;

create or replace function private.record_initial_sale_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.sale_status_history (
    sale_id, from_status, to_status, actor_id, correlation_id
  ) values (
    new.id, null, 'DRAFT', new.created_by, new.correlation_id
  );

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'sales.created', new.created_by, 'sale', new.id::text, new.correlation_id,
    jsonb_build_object(
      'channel', new.channel,
      'location_id', new.location_id,
      'customer_id', new.customer_id,
      'total_cents', new.total_cents,
      'currency', new.currency
    )
  );

  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'sales.created', 'sale', new.id::text,
    jsonb_build_object(
      'sale_id', new.id,
      'status', new.status,
      'channel', new.channel,
      'correlation_id', new.correlation_id
    )
  );
  return new;
end;
$$;

create or replace function private.assert_sale_totals(p_sale_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_sale public.sales%rowtype;
  v_item_count bigint;
  v_original_total bigint;
  v_discount_total bigint;
  v_total bigint;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;

  select count(*), coalesce(sum(original_subtotal_cents), 0),
    coalesce(sum(discount_cents), 0), coalesce(sum(total_cents), 0)
  into v_item_count, v_original_total, v_discount_total, v_total
  from public.sale_items where sale_id = p_sale_id;

  if v_item_count = 0
    or v_original_total <> v_sale.original_total_cents
    or v_discount_total <> v_sale.discount_total_cents
    or v_total <> v_sale.total_cents then
    raise exception using errcode = 'P0001', message = 'SALE_TOTAL_MISMATCH';
  end if;
end;
$$;

create or replace function private.transition_sale_state(
  p_sale_id uuid,
  p_target_status public.sale_status,
  p_actor_id uuid,
  p_correlation_id uuid,
  p_reason text default null
)
returns public.sales
language plpgsql
set search_path = ''
as $$
declare
  v_sale public.sales%rowtype;
begin
  if p_actor_id is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_SALE_TRANSITION_CONTEXT';
  end if;
  if p_reason is not null and (
    char_length(p_reason) not between 1 and 500 or p_reason <> btrim(p_reason)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SALE_TRANSITION_REASON';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_actor_id and active
  ) then
    raise exception using errcode = '42501', message = 'SALE_ACTOR_INACTIVE';
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;
  if v_sale.status = p_target_status then
    return v_sale;
  end if;

  if not (
    (v_sale.status = 'DRAFT' and p_target_status in ('AWAITING_PAYMENT', 'CANCELLED'))
    or (v_sale.status = 'AWAITING_PAYMENT' and p_target_status in ('CONFIRMED', 'CANCELLED'))
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_SALE_TRANSITION';
  end if;

  if p_target_status = 'AWAITING_PAYMENT' then
    perform private.assert_sale_totals(v_sale.id);
  end if;

  update public.sales set status = p_target_status where id = v_sale.id
  returning * into v_sale;

  insert into public.sale_status_history (
    sale_id, from_status, to_status, actor_id, reason, correlation_id
  ) values (
    v_sale.id, (select to_status from public.sale_status_history where sale_id = v_sale.id order by created_at desc, id desc limit 1),
    p_target_status, p_actor_id, p_reason, p_correlation_id
  );

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'sales.status.changed', p_actor_id, 'sale', v_sale.id::text, p_correlation_id,
    jsonb_build_object('status', p_target_status, 'reason', p_reason)
  );

  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'sales.status.changed', 'sale', v_sale.id::text,
    jsonb_build_object(
      'sale_id', v_sale.id,
      'status', p_target_status,
      'correlation_id', p_correlation_id
    )
  );
  return v_sale;
end;
$$;

create trigger sales_guard_write before insert or update on public.sales
for each row execute function private.guard_sale_write();
create trigger sales_prevent_hard_delete before delete on public.sales
for each row execute function private.prevent_sale_hard_delete();
create trigger sales_record_initial_state after insert on public.sales
for each row execute function private.record_initial_sale_state();
create trigger sale_items_immutable before update or delete on public.sale_items
for each row execute function private.prevent_immutable_record_change();
create trigger sale_status_history_immutable before update or delete on public.sale_status_history
for each row execute function private.prevent_immutable_record_change();

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role cross join public.permissions permission
where role.key = 'CONSUMIDOR' and permission.key = 'sales.read.own'
on conflict do nothing;

alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.sale_status_history enable row level security;

revoke all on table public.sales from public, anon, authenticated, service_role;
revoke all on table public.sale_items from public, anon, authenticated, service_role;
revoke all on table public.sale_status_history from public, anon, authenticated, service_role;
grant select on table public.sales to authenticated;
grant select on table public.sale_items to authenticated;
grant select on table public.sale_status_history to authenticated;

create policy sales_own_read on public.sales for select to authenticated
using (
  public.has_permission('sales.read.own')
  and (created_by = auth.uid() or customer_id = auth.uid())
);
create policy sales_all_read on public.sales for select to authenticated
using (public.has_permission('sales.read.all'));
create policy sale_items_visible_sale_read on public.sale_items for select to authenticated
using (exists (select 1 from public.sales where sales.id = sale_items.sale_id));
create policy sale_status_history_visible_sale_read on public.sale_status_history for select to authenticated
using (exists (select 1 from public.sales where sales.id = sale_status_history.sale_id));

revoke all on function private.guard_sale_write() from public, anon, authenticated, service_role;
revoke all on function private.prevent_sale_hard_delete() from public, anon, authenticated, service_role;
revoke all on function private.record_initial_sale_state() from public, anon, authenticated, service_role;
revoke all on function private.assert_sale_totals(uuid) from public, anon, authenticated, service_role;
revoke all on function private.transition_sale_state(uuid, public.sale_status, uuid, uuid, text) from public, anon, authenticated, service_role;

comment on table public.sales is 'Server-owned sale aggregate with immutable financial snapshot and controlled state transitions.';
comment on table public.sale_items is 'Immutable product, price and promotion snapshots captured for a sale.';
comment on table public.sale_status_history is 'Immutable audit trail for every sale state transition.';
comment on function private.transition_sale_state(uuid, public.sale_status, uuid, uuid, text) is
  'Internal transition primitive. Confirmed cancellation remains fail-closed until reversal workflows are transactional.';
