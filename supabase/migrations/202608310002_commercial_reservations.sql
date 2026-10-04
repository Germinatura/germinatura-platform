create type public.commercial_reservation_status as enum (
  'ACTIVE',
  'CONVERTED',
  'CANCELLED',
  'EXPIRED'
);

create table public.commercial_reservations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete restrict,
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  stock_reservation_id uuid unique references public.stock_reservations(id) on delete restrict,
  converted_sale_id uuid unique references public.sales(id) on delete restrict,
  status public.commercial_reservation_status not null default 'ACTIVE',
  quote_snapshot jsonb not null,
  original_total_cents bigint not null,
  discount_total_cents bigint not null default 0,
  total_cents bigint not null,
  correlation_id uuid not null,
  expires_at timestamptz not null,
  converted_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commercial_reservations_quote_valid check (jsonb_typeof(quote_snapshot) = 'object'),
  constraint commercial_reservations_money_valid check (
    original_total_cents between 0 and 9007199254740991
    and discount_total_cents between 0 and original_total_cents
    and total_cents = original_total_cents - discount_total_cents
  ),
  constraint commercial_reservations_expiry_valid check (expires_at > created_at),
  constraint commercial_reservations_state_valid check (
    (status = 'ACTIVE' and stock_reservation_id is not null and converted_sale_id is null
      and converted_at is null and cancelled_at is null and expired_at is null)
    or (status = 'CONVERTED' and stock_reservation_id is not null and converted_sale_id is not null
      and converted_at is not null and cancelled_at is null and expired_at is null)
    or (status = 'CANCELLED' and stock_reservation_id is not null and converted_sale_id is null
      and converted_at is null and cancelled_at is not null and expired_at is null)
    or (status = 'EXPIRED' and stock_reservation_id is not null and converted_sale_id is null
      and converted_at is null and cancelled_at is null and expired_at is not null)
  ) not valid
);

create index commercial_reservations_customer_created_idx
  on public.commercial_reservations (customer_id, created_at desc);
create index commercial_reservations_active_expiry_idx
  on public.commercial_reservations (expires_at, id) where status = 'ACTIVE';

create trigger commercial_reservations_prevent_hard_delete before delete on public.commercial_reservations
for each row execute function private.prevent_inventory_hard_delete();

create or replace function private.guard_commercial_reservation_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.customer_id is distinct from old.customer_id
    or new.location_id is distinct from old.location_id
    or new.stock_reservation_id is distinct from old.stock_reservation_id
      and old.stock_reservation_id is not null
    or new.quote_snapshot is distinct from old.quote_snapshot
    or new.original_total_cents is distinct from old.original_total_cents
    or new.discount_total_cents is distinct from old.discount_total_cents
    or new.total_cents is distinct from old.total_cents
    or new.correlation_id is distinct from old.correlation_id
    or new.expires_at is distinct from old.expires_at
    or new.created_at is distinct from old.created_at
  ) then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_SNAPSHOT_IMMUTABLE';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger commercial_reservations_guard before update on public.commercial_reservations
for each row execute function private.guard_commercial_reservation_write();

create or replace function private.reserve_stock_for_commercial_reservation(
  p_commercial_reservation_id uuid,
  p_location_id uuid,
  p_items jsonb,
  p_actor_id uuid,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_stock_reservation_id uuid := gen_random_uuid();
  v_movement_id uuid;
  v_expires_at timestamptz := clock_timestamp() + interval '10 minutes';
begin
  perform balance.id
  from public.inventory_balances balance
  join jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint)
    on item.product_id = balance.product_id
  where balance.location_id = p_location_id
  order by balance.product_id
  for update of balance;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint)
    left join public.inventory_balances balance
      on balance.location_id = p_location_id and balance.product_id = item.product_id
    where balance.id is null or balance.available_quantity < item.quantity
  ) then
    raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT';
  end if;

  v_movement_id := private.record_reservation_movement(
    v_stock_reservation_id, 'RESERVA', p_location_id, p_items, p_actor_id,
    'Reserva comercial', p_correlation_id
  );
  insert into public.stock_reservations (
    id, location_id, actor_id, origin_type, origin_id,
    reservation_movement_id, expires_at
  ) values (
    v_stock_reservation_id, p_location_id, p_actor_id,
    'commercial_reservation', p_commercial_reservation_id::text,
    v_movement_id, v_expires_at
  );
  insert into public.stock_reservation_items (reservation_id, product_id, quantity)
  select v_stock_reservation_id, item.product_id, item.quantity
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint);

  update public.inventory_balances balance
  set reserved_quantity = balance.reserved_quantity + item.quantity
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint)
  where balance.location_id = p_location_id and balance.product_id = item.product_id;

  return jsonb_build_object(
    'reservation_id', v_stock_reservation_id,
    'status', 'ACTIVE',
    'expires_at', v_expires_at,
    'reservation_movement_id', v_movement_id
  );
end;
$$;

create or replace function public.create_commercial_reservation(
  p_location_id uuid,
  p_items jsonb,
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
  v_quote jsonb;
  v_reservation_id uuid := gen_random_uuid();
  v_stock jsonb;
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.has_permission('reservations.manage.own') or p_correlation_id is null then
    raise exception using errcode = '42501', message = 'COMMERCIAL_RESERVATION_FORBIDDEN';
  end if;
  if not exists (
    select 1 from public.stock_locations
    where id = p_location_id and active and location_type = 'CENTRAL'
  ) then
    raise exception using errcode = '42501', message = 'COMMERCIAL_RESERVATION_LOCATION_FORBIDDEN';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 100
    or exists (
      select 1 from jsonb_array_elements(p_items) element
      where jsonb_typeof(element) <> 'object'
        or element - 'product_id' - 'quantity' <> '{}'::jsonb
        or not (element ? 'product_id' and element ? 'quantity')
    ) then
    raise exception using errcode = '22023', message = 'INVALID_COMMERCIAL_RESERVATION_ITEMS';
  end if;

  select
    jsonb_agg(jsonb_build_object('product_id', item.product_id, 'quantity', item.quantity) order by item.product_id),
    count(*), count(distinct item.product_id),
    count(*) filter (where item.product_id is null or item.quantity not between 1 and 9007199254740991)
  into v_items, v_item_count, v_distinct_count, v_invalid_count
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint);
  if v_invalid_count > 0 or v_item_count <> v_distinct_count then
    raise exception using errcode = '22023', message = 'INVALID_COMMERCIAL_RESERVATION_ITEMS';
  end if;

  v_scope := private.build_idempotency_scope('reservations', 'create', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object('location_id', p_location_id, 'items', v_items)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  v_quote := private.price_sale_items('PORTAL', v_items);
  v_stock := private.reserve_stock_for_commercial_reservation(
    v_reservation_id, p_location_id, v_items, v_actor_id, p_correlation_id
  );
  insert into public.commercial_reservations (
    id, customer_id, location_id, stock_reservation_id, quote_snapshot,
    original_total_cents, discount_total_cents, total_cents,
    correlation_id, expires_at
  ) values (
    v_reservation_id, v_actor_id, p_location_id,
    (v_stock ->> 'reservation_id')::uuid, v_quote,
    (v_quote ->> 'original_total_cents')::bigint,
    (v_quote ->> 'discount_total_cents')::bigint,
    (v_quote ->> 'total_cents')::bigint,
    p_correlation_id, (v_stock ->> 'expires_at')::timestamptz
  );

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('reservations.created', v_actor_id, 'commercial_reservation', v_reservation_id::text,
    p_correlation_id, jsonb_build_object('total_cents', v_quote -> 'total_cents'));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('reservations.created', 'commercial_reservation', v_reservation_id::text,
    jsonb_build_object('reservation_id', v_reservation_id, 'expires_at', v_stock -> 'expires_at'));

  v_result := jsonb_build_object(
    'reservation_id', v_reservation_id,
    'status', 'ACTIVE',
    'location_id', p_location_id,
    'quote', v_quote,
    'stock_reservation', v_stock,
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation_id::text
  );
  return v_result;
end;
$$;

create or replace function public.cancel_commercial_reservation(
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
  v_reservation public.commercial_reservations%rowtype;
  v_scope text;
  v_claim record;
  v_stock jsonb;
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into v_reservation from public.commercial_reservations
  where id = p_reservation_id for update;
  if not found or not (
    v_reservation.customer_id = v_actor_id or public.has_permission('reservations.manage.all')
  ) then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.status = 'CONVERTED' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_ALREADY_CONVERTED';
  end if;
  v_scope := private.build_idempotency_scope('reservations', 'cancel', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key, jsonb_build_object('reservation_id', p_reservation_id)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  if v_reservation.status = 'ACTIVE' then
    v_stock := private.finalize_stock_reservation(
      v_reservation.stock_reservation_id, 'RELEASED', v_actor_id, p_correlation_id
    );
    update public.commercial_reservations
    set status = 'CANCELLED', cancelled_at = now()
    where id = v_reservation.id;
  else
    select jsonb_build_object(
      'reservation_id', stock.id, 'status', stock.status,
      'release_movement_id', stock.release_movement_id
    ) into v_stock from public.stock_reservations stock
    where stock.id = v_reservation.stock_reservation_id;
  end if;
  v_result := jsonb_build_object(
    'reservation_id', v_reservation.id,
    'status', case when v_reservation.status = 'ACTIVE' then 'CANCELLED' else v_reservation.status end,
    'stock_reservation', v_stock,
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation.id::text
  );
  return v_result;
end;
$$;

create or replace function public.convert_commercial_reservation(
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
  v_reservation public.commercial_reservations%rowtype;
  v_scope text;
  v_claim record;
  v_sale_id uuid := gen_random_uuid();
  v_attempt_id uuid := gen_random_uuid();
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into v_reservation from public.commercial_reservations
  where id = p_reservation_id for update;
  if not found or v_reservation.customer_id <> v_actor_id then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_FOUND';
  end if;
  v_scope := private.build_idempotency_scope('reservations', 'convert', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key, jsonb_build_object('reservation_id', p_reservation_id)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if v_reservation.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_ACTIVE';
  end if;
  if v_reservation.expires_at <= clock_timestamp() then
    perform private.finalize_stock_reservation(
      v_reservation.stock_reservation_id, 'EXPIRED', v_actor_id, p_correlation_id
    );
    update public.commercial_reservations set status = 'EXPIRED', expired_at = now()
    where id = v_reservation.id;
    v_result := jsonb_build_object(
      'reservation_id', v_reservation.id, 'status', 'EXPIRED',
      'sale_id', null, 'payment_attempt_id', null, 'correlation_id', p_correlation_id
    );
    perform private.complete_idempotency(
      v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation.id::text
    );
    return v_result;
  end if;

  insert into public.sales (
    id, channel, location_id, created_by, customer_id,
    original_total_cents, discount_total_cents, total_cents, quoted_at, correlation_id
  ) values (
    v_sale_id, 'PORTAL', v_reservation.location_id, v_actor_id, v_actor_id,
    v_reservation.original_total_cents, v_reservation.discount_total_cents,
    v_reservation.total_cents,
    (v_reservation.quote_snapshot ->> 'quoted_at')::timestamptz, p_correlation_id
  );
  insert into public.sale_items (
    sale_id, product_id, product_sku, product_name, quantity,
    unit_price_cents, original_subtotal_cents, discount_cents, total_cents,
    promotion_id, promotion_snapshot
  )
  select v_sale_id, line.product_id, line.product_sku, line.product_name, line.quantity,
    line.unit_price_cents, line.original_subtotal_cents, line.discount_cents, line.total_cents,
    line.promotion_id, line.promotion_snapshot
  from jsonb_to_recordset(v_reservation.quote_snapshot -> 'lines') as line(
    product_id uuid, product_sku text, product_name text, quantity bigint,
    unit_price_cents bigint, original_subtotal_cents bigint, discount_cents bigint,
    total_cents bigint, promotion_id uuid, promotion_snapshot jsonb
  );
  perform private.assert_sale_totals(v_sale_id);
  update public.stock_reservations
  set origin_type = 'sale', origin_id = v_sale_id::text
  where id = v_reservation.stock_reservation_id and status = 'ACTIVE';
  if not found then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_STOCK_NOT_ACTIVE';
  end if;
  insert into public.payment_attempts (
    id, sale_id, amount_cents, operator_id, idempotency_key, correlation_id
  ) values (
    v_attempt_id, v_sale_id, v_reservation.total_cents,
    v_actor_id, p_idempotency_key, p_correlation_id
  );
  perform private.transition_sale_state(
    v_sale_id, 'AWAITING_PAYMENT', v_actor_id, p_correlation_id, null
  );
  update public.commercial_reservations
  set status = 'CONVERTED', converted_sale_id = v_sale_id, converted_at = now()
  where id = v_reservation.id;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('reservations.converted', v_actor_id, 'commercial_reservation', v_reservation.id::text,
    p_correlation_id, jsonb_build_object('sale_id', v_sale_id, 'attempt_id', v_attempt_id));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('reservations.converted', 'commercial_reservation', v_reservation.id::text,
    jsonb_build_object('reservation_id', v_reservation.id, 'sale_id', v_sale_id));

  v_result := jsonb_build_object(
    'reservation_id', v_reservation.id, 'status', 'CONVERTED',
    'sale_id', v_sale_id, 'sale_status', 'AWAITING_PAYMENT',
    'payment_attempt_id', v_attempt_id,
    'stock_reservation_id', v_reservation.stock_reservation_id,
    'total_cents', v_reservation.total_cents,
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale_id::text
  );
  return v_result;
end;
$$;

alter table public.commercial_reservations validate constraint commercial_reservations_state_valid;
alter table public.commercial_reservations enable row level security;
revoke all on table public.commercial_reservations from public, anon, authenticated, service_role;
grant select on table public.commercial_reservations to authenticated;
create policy commercial_reservations_own_read on public.commercial_reservations
for select to authenticated using (
  customer_id = auth.uid() and public.has_permission('reservations.manage.own')
);
create policy commercial_reservations_manager_read on public.commercial_reservations
for select to authenticated using (public.has_permission('reservations.manage.all'));

revoke all on function private.guard_commercial_reservation_write() from public, anon, authenticated, service_role;
revoke all on function private.reserve_stock_for_commercial_reservation(uuid, uuid, jsonb, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.create_commercial_reservation(uuid, jsonb, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_commercial_reservation(uuid, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.convert_commercial_reservation(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_commercial_reservation(uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.cancel_commercial_reservation(uuid, text, uuid) to authenticated;
grant execute on function public.convert_commercial_reservation(uuid, text, uuid) to authenticated;

comment on table public.commercial_reservations is
  'Commercial holds with immutable server-side price snapshots; stock is held by stock_reservations.';
