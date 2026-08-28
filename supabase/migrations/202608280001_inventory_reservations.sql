create type public.stock_reservation_status as enum ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');

create table public.stock_reservations (
  id uuid primary key,
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  origin_type text not null,
  origin_id text not null,
  status public.stock_reservation_status not null default 'ACTIVE',
  reservation_movement_id uuid not null unique references public.stock_movements(id) on delete restrict,
  release_movement_id uuid unique references public.stock_movements(id) on delete restrict,
  expires_at timestamptz not null,
  released_at timestamptz,
  expired_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_reservations_origin_valid check (
    char_length(origin_type) between 1 and 64
    and origin_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
    and char_length(origin_id) between 1 and 128
    and origin_id = btrim(origin_id)
  ),
  constraint stock_reservations_expiry_valid check (expires_at > created_at),
  constraint stock_reservations_state_valid check (
    (status = 'ACTIVE' and release_movement_id is null and released_at is null and expired_at is null and consumed_at is null)
    or (status = 'RELEASED' and release_movement_id is not null and released_at is not null and expired_at is null and consumed_at is null)
    or (status = 'EXPIRED' and release_movement_id is not null and released_at is null and expired_at is not null and consumed_at is null)
    or (status = 'CONSUMED' and release_movement_id is null and released_at is null and expired_at is null and consumed_at is not null)
  )
);

create index stock_reservations_active_expiry_idx
  on public.stock_reservations (expires_at, id)
  where status = 'ACTIVE';
create index stock_reservations_actor_created_idx
  on public.stock_reservations (actor_id, created_at desc);
create index stock_reservations_location_created_idx
  on public.stock_reservations (location_id, created_at desc);

create table public.stock_reservation_items (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.stock_reservations(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity bigint not null,
  created_at timestamptz not null default now(),
  constraint stock_reservation_items_reservation_product_unique unique (reservation_id, product_id),
  constraint stock_reservation_items_quantity_valid check (quantity between 1 and 9007199254740991)
);

create index stock_reservation_items_product_id_idx on public.stock_reservation_items (product_id);

create trigger stock_reservations_set_updated_at before update on public.stock_reservations
for each row execute function private.set_updated_at();
create trigger stock_reservations_prevent_hard_delete before delete on public.stock_reservations
for each row execute function private.prevent_inventory_hard_delete();
create trigger stock_reservation_items_immutable before update or delete on public.stock_reservation_items
for each row execute function private.prevent_immutable_record_change();

create or replace function private.record_reservation_movement(
  p_reservation_id uuid,
  p_movement_type public.stock_movement_type,
  p_location_id uuid,
  p_items jsonb,
  p_actor_id uuid,
  p_reason text,
  p_correlation_id uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare v_movement_id uuid;
begin
  insert into public.stock_movements (
    movement_type, from_location_id, to_location_id, actor_id, reason,
    correlation_id, source_type, source_id
  ) values (
    p_movement_type, p_location_id, null, p_actor_id, p_reason,
    p_correlation_id, 'stock_reservation', p_reservation_id::text
  ) returning id into v_movement_id;

  insert into public.stock_movement_items (movement_id, product_id, quantity)
  select v_movement_id, item.product_id, item.quantity
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint);

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    case when p_movement_type = 'RESERVA' then 'inventory.reservation.created'
      else 'inventory.reservation.released' end,
    p_actor_id, 'stock_reservation', p_reservation_id::text, p_correlation_id,
    jsonb_build_object('movement_id', v_movement_id, 'movement_type', p_movement_type, 'items', p_items)
  );

  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    case when p_movement_type = 'RESERVA' then 'inventory.reservation.created'
      else 'inventory.reservation.released' end,
    'stock_reservation', p_reservation_id::text,
    jsonb_build_object(
      'reservation_id', p_reservation_id,
      'movement_id', v_movement_id,
      'movement_type', p_movement_type,
      'items', p_items,
      'correlation_id', p_correlation_id
    )
  );
  return v_movement_id;
end;
$$;

create or replace function private.finalize_stock_reservation(
  p_reservation_id uuid,
  p_target_status public.stock_reservation_status,
  p_actor_id uuid,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_reservation public.stock_reservations%rowtype;
  v_items jsonb;
  v_release_movement_id uuid;
  v_result jsonb;
begin
  if p_target_status not in ('RELEASED', 'EXPIRED') then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_FINAL_STATUS';
  end if;

  select * into v_reservation from public.stock_reservations
  where id = p_reservation_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.status <> 'ACTIVE' then
    return jsonb_build_object(
      'reservation_id', v_reservation.id,
      'status', v_reservation.status,
      'release_movement_id', v_reservation.release_movement_id
    );
  end if;

  select jsonb_agg(
    jsonb_build_object('product_id', product_id, 'quantity', quantity)
    order by product_id
  ) into v_items
  from public.stock_reservation_items where reservation_id = p_reservation_id;

  perform balance.id
  from public.inventory_balances balance
  join jsonb_to_recordset(v_items) as item(product_id uuid, quantity bigint)
    on item.product_id = balance.product_id
  where balance.location_id = v_reservation.location_id
  order by balance.product_id
  for update of balance;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as item(product_id uuid, quantity bigint)
    left join public.inventory_balances balance
      on balance.location_id = v_reservation.location_id and balance.product_id = item.product_id
    where balance.id is null or balance.reserved_quantity < item.quantity
  ) then
    raise exception using errcode = 'P0001', message = 'RESERVATION_BALANCE_CONFLICT';
  end if;

  update public.inventory_balances balance
  set reserved_quantity = balance.reserved_quantity - item.quantity
  from jsonb_to_recordset(v_items) as item(product_id uuid, quantity bigint)
  where balance.location_id = v_reservation.location_id and balance.product_id = item.product_id;

  v_release_movement_id := private.record_reservation_movement(
    v_reservation.id, 'LIBERACAO_RESERVA', v_reservation.location_id, v_items,
    p_actor_id,
    case when p_target_status = 'EXPIRED' then 'Reserva expirada' else 'Reserva liberada' end,
    p_correlation_id
  );

  update public.stock_reservations
  set status = p_target_status,
      release_movement_id = v_release_movement_id,
      released_at = case when p_target_status = 'RELEASED' then now() else null end,
      expired_at = case when p_target_status = 'EXPIRED' then now() else null end
  where id = v_reservation.id;

  v_result := jsonb_build_object(
    'reservation_id', v_reservation.id,
    'status', p_target_status,
    'release_movement_id', v_release_movement_id
  );
  return v_result;
end;
$$;

create or replace function public.reserve_stock(
  p_location_id uuid,
  p_items jsonb,
  p_origin_type text,
  p_origin_id text,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_items jsonb;
  v_item_count integer;
  v_distinct_count integer;
  v_invalid_count integer;
  v_scope text;
  v_claim record;
  v_reservation_id uuid := gen_random_uuid();
  v_movement_id uuid;
  v_expires_at timestamptz := clock_timestamp() + interval '10 minutes';
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1 from public.stock_locations location
    where location.id = p_location_id and location.active
      and (
        public.has_permission('inventory.manage')
        or (
          public.has_permission('inventory.read')
          and location.location_type = 'SELLER'
          and location.seller_id = v_actor_id
        )
      )
  ) then
    raise exception using errcode = '42501', message = 'RESERVATION_LOCATION_FORBIDDEN';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_ITEMS';
  end if;
  if p_origin_type is null or char_length(p_origin_type) not between 1 and 64
    or p_origin_type !~ '^[a-z][a-z0-9_.-]{0,63}$'
    or p_origin_id is null or char_length(p_origin_id) not between 1 and 128
    or p_origin_id <> btrim(p_origin_id) then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_ORIGIN';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;

  select
    jsonb_agg(jsonb_build_object('product_id', item.product_id, 'quantity', item.quantity) order by item.product_id),
    count(*), count(distinct item.product_id),
    count(*) filter (where item.product_id is null or item.quantity not between 1 and 9007199254740991)
  into v_items, v_item_count, v_distinct_count, v_invalid_count
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint);
  if v_invalid_count > 0 or v_item_count <> v_distinct_count then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_ITEMS';
  end if;
  if (
    select count(*) from public.products product
    join jsonb_to_recordset(v_items) as item(product_id uuid, quantity bigint)
      on item.product_id = product.id
    -- This is an inventory hold, not the commercial reservation feature.
    -- Channel cases (PDV, online, reservation order) validate their own flags
    -- before calling this primitive; every hold still requires an active product.
    where product.active
  ) <> v_item_count then
    raise exception using errcode = 'P0001', message = 'PRODUCT_INACTIVE';
  end if;

  v_scope := private.build_idempotency_scope('inventory', 'reserve', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object(
      'location_id', p_location_id,
      'items', v_items,
      'origin_type', p_origin_type,
      'origin_id', p_origin_id
    )
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  perform balance.id
  from public.inventory_balances balance
  join jsonb_to_recordset(v_items) as item(product_id uuid, quantity bigint)
    on item.product_id = balance.product_id
  where balance.location_id = p_location_id
  order by balance.product_id
  for update of balance;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as item(product_id uuid, quantity bigint)
    left join public.inventory_balances balance
      on balance.location_id = p_location_id and balance.product_id = item.product_id
    where balance.id is null or balance.available_quantity < item.quantity
  ) then
    raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT';
  end if;

  v_movement_id := private.record_reservation_movement(
    v_reservation_id, 'RESERVA', p_location_id, v_items, v_actor_id,
    'Reserva de estoque', p_correlation_id
  );
  insert into public.stock_reservations (
    id, location_id, actor_id, origin_type, origin_id,
    reservation_movement_id, expires_at
  ) values (
    v_reservation_id, p_location_id, v_actor_id, p_origin_type, p_origin_id,
    v_movement_id, v_expires_at
  );
  insert into public.stock_reservation_items (reservation_id, product_id, quantity)
  select v_reservation_id, item.product_id, item.quantity
  from jsonb_to_recordset(v_items) as item(product_id uuid, quantity bigint);

  update public.inventory_balances balance
  set reserved_quantity = balance.reserved_quantity + item.quantity
  from jsonb_to_recordset(v_items) as item(product_id uuid, quantity bigint)
  where balance.location_id = p_location_id and balance.product_id = item.product_id;

  v_result := jsonb_build_object(
    'reservation_id', v_reservation_id,
    'status', 'ACTIVE',
    'location_id', p_location_id,
    'items', v_items,
    'expires_at', v_expires_at,
    'reservation_movement_id', v_movement_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'stock_reservation', v_reservation_id::text
  );
  return v_result;
end;
$$;

create or replace function public.release_stock_reservation(
  p_reservation_id uuid,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_reservation public.stock_reservations%rowtype;
  v_scope text;
  v_claim record;
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;
  select * into v_reservation from public.stock_reservations where id = p_reservation_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.actor_id <> v_actor_id
    and not public.has_permission('inventory.manage')
    and not public.has_permission('reservations.manage.all') then
    raise exception using errcode = '42501', message = 'RESERVATION_FORBIDDEN';
  end if;

  v_scope := private.build_idempotency_scope('inventory', 'release_reservation', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key, jsonb_build_object('reservation_id', p_reservation_id)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  v_result := private.finalize_stock_reservation(
    p_reservation_id, 'RELEASED', v_actor_id, p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'stock_reservation', p_reservation_id::text
  );
  return v_result;
end;
$$;

create or replace function private.expire_stock_reservation(
  p_reservation_id uuid,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare v_reservation public.stock_reservations%rowtype;
begin
  select * into v_reservation from public.stock_reservations
  where id = p_reservation_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.status <> 'ACTIVE' then
    return jsonb_build_object(
      'reservation_id', v_reservation.id,
      'status', v_reservation.status,
      'release_movement_id', v_reservation.release_movement_id
    );
  end if;
  if v_reservation.expires_at > clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'RESERVATION_NOT_EXPIRED';
  end if;
  return private.finalize_stock_reservation(
    p_reservation_id, 'EXPIRED', v_reservation.actor_id, p_correlation_id
  );
end;
$$;

alter table public.stock_reservations enable row level security;
alter table public.stock_reservation_items enable row level security;
revoke all on table public.stock_reservations from public, anon, authenticated, service_role;
revoke all on table public.stock_reservation_items from public, anon, authenticated, service_role;
grant select on table public.stock_reservations to authenticated;
grant select on table public.stock_reservation_items to authenticated;

create policy stock_reservations_own_read on public.stock_reservations for select to authenticated
using (actor_id = auth.uid() and public.has_permission('reservations.manage.own'));
create policy stock_reservations_manager_read on public.stock_reservations for select to authenticated
using (public.has_permission('inventory.manage') or public.has_permission('reservations.manage.all'));
create policy stock_reservation_items_visible_reservation_read on public.stock_reservation_items for select to authenticated
using (exists (select 1 from public.stock_reservations where stock_reservations.id = stock_reservation_items.reservation_id));

revoke all on function private.record_reservation_movement(uuid, public.stock_movement_type, uuid, jsonb, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.finalize_stock_reservation(uuid, public.stock_reservation_status, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.expire_stock_reservation(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reserve_stock(uuid, jsonb, text, text, text, uuid) from public;
revoke all on function public.release_stock_reservation(uuid, text, uuid) from public;
grant execute on function public.reserve_stock(uuid, jsonb, text, text, text, uuid) to authenticated;
grant execute on function public.release_stock_reservation(uuid, text, uuid) to authenticated;

comment on table public.stock_reservations is 'Server-timed stock reservations; lifecycle mutations occur only through transactional functions.';
comment on table public.stock_reservation_items is 'Immutable products and quantities held by a stock reservation.';
