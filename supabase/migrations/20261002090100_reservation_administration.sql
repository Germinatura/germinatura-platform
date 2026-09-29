-- Spec 4.3 / 5.10 / 5.17 (RES-002): reservations hold price and stock until pickup under configurable deadlines;
-- the commission prepares them (READY, with pickup instructions and deadline) and filters them by status,
-- customer and date. Completion at pickup (COMPLETED) comes with the PDV pickup flow.

-- Reservation deadlines: how long a reservation holds stock and how long a prepared one waits for pickup.
create table public.reservation_settings (
  singleton boolean primary key default true check (singleton),
  hold_hours integer not null default 72 check (hold_hours between 1 and 720),
  pickup_hours integer not null default 48 check (pickup_hours between 1 and 720),
  updated_at timestamptz,
  updated_by uuid references public.profiles(id) on delete restrict
);
insert into public.reservation_settings (singleton) values (true);
alter table public.reservation_settings enable row level security;
revoke all on public.reservation_settings from public, anon, authenticated, service_role;
grant select on public.reservation_settings to authenticated;
create policy reservation_settings_read on public.reservation_settings for select to authenticated using (true);

alter table public.commercial_reservations
  add column ready_at timestamptz,
  add column ready_by uuid references public.profiles(id) on delete restrict,
  add column pickup_instructions text check (pickup_instructions is null
    or (char_length(pickup_instructions) between 3 and 500 and pickup_instructions = btrim(pickup_instructions))),
  add column pickup_deadline timestamptz,
  add column completed_at timestamptz;

alter table public.commercial_reservations drop constraint commercial_reservations_state_valid;
alter table public.commercial_reservations add constraint commercial_reservations_state_valid check (
  (status = 'ACTIVE' and stock_reservation_id is not null and converted_sale_id is null
    and converted_at is null and cancelled_at is null and expired_at is null and ready_at is null and completed_at is null)
  or (status = 'READY' and stock_reservation_id is not null and converted_sale_id is null
    and ready_at is not null and ready_by is not null and pickup_deadline is not null
    and converted_at is null and cancelled_at is null and expired_at is null and completed_at is null)
  or (status = 'CONVERTED' and stock_reservation_id is not null and converted_sale_id is not null
    and converted_at is not null and cancelled_at is null and expired_at is null and completed_at is null)
  or (status = 'COMPLETED' and stock_reservation_id is not null and converted_sale_id is not null
    and converted_at is not null and completed_at is not null and cancelled_at is null and expired_at is null)
  or (status = 'CANCELLED' and stock_reservation_id is not null and converted_sale_id is null
    and converted_at is null and cancelled_at is not null and expired_at is null)
  or (status = 'EXPIRED' and stock_reservation_id is not null and converted_sale_id is null
    and converted_at is null and cancelled_at is null and expired_at is not null)
) not valid;
create index commercial_reservations_ready_deadline_idx
  on public.commercial_reservations (pickup_deadline, id) where status = 'READY';
create index commercial_reservations_status_created_idx
  on public.commercial_reservations (status, created_at desc, id);

-- The stock hold now follows the configured reservation window instead of a fixed checkout-like hold.
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
  v_expires_at timestamptz := clock_timestamp()
    + make_interval(hours => (select hold_hours from public.reservation_settings where singleton));
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

create function public.update_reservation_settings(
  p_hold_hours integer, p_pickup_hours integer, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_claim record; v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('reservations.manage.all') then
    raise exception using errcode = '42501', message = 'RESERVATIONS_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_hold_hours is null or p_hold_hours not between 1 and 720
    or p_pickup_hours is null or p_pickup_hours not between 1 and 720 then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_SETTINGS';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('reservations', 'settings', v_actor_id), p_idempotency_key,
    jsonb_build_object('hold_hours', p_hold_hours, 'pickup_hours', p_pickup_hours));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  update public.reservation_settings
  set hold_hours = p_hold_hours, pickup_hours = p_pickup_hours, updated_at = clock_timestamp(), updated_by = v_actor_id
  where singleton;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('reservations.settings.updated', v_actor_id, 'reservation_settings', 'singleton', p_correlation_id,
    jsonb_build_object('hold_hours', p_hold_hours, 'pickup_hours', p_pickup_hours));
  v_result := jsonb_build_object('hold_hours', p_hold_hours, 'pickup_hours', p_pickup_hours, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'reservation_settings', 'singleton');
  return v_result;
end;
$$;

-- The commission prepares an active reservation; the pickup deadline starts now.
create function public.mark_commercial_reservation_ready(
  p_reservation_id uuid, p_pickup_instructions text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_claim record; v_reservation public.commercial_reservations%rowtype;
  v_instructions text := nullif(btrim(p_pickup_instructions), ''); v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('reservations.manage.all') then
    raise exception using errcode = '42501', message = 'RESERVATIONS_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or (v_instructions is not null and char_length(v_instructions) not between 3 and 500) then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_INSTRUCTIONS';
  end if;
  select * into v_reservation from public.commercial_reservations where id = p_reservation_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('reservations', 'ready', v_actor_id), p_idempotency_key,
    jsonb_build_object('reservation_id', p_reservation_id, 'pickup_instructions', v_instructions));
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
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_EXPIRED';
  end if;
  update public.commercial_reservations
  set status = 'READY', ready_at = clock_timestamp(), ready_by = v_actor_id, pickup_instructions = v_instructions,
    pickup_deadline = clock_timestamp() + make_interval(hours => (select pickup_hours from public.reservation_settings where singleton))
  where id = v_reservation.id returning * into v_reservation;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('reservations.ready', v_actor_id, 'commercial_reservation', v_reservation.id::text, p_correlation_id,
    jsonb_build_object('pickup_deadline', v_reservation.pickup_deadline, 'pickup_instructions', v_instructions));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('reservations.ready', 'commercial_reservation', v_reservation.id::text,
    jsonb_build_object('reservation_id', v_reservation.id, 'customer_id', v_reservation.customer_id,
      'pickup_deadline', v_reservation.pickup_deadline, 'correlation_id', p_correlation_id));
  v_result := jsonb_build_object('reservation_id', v_reservation.id, 'status', v_reservation.status,
    'ready_at', v_reservation.ready_at, 'pickup_deadline', v_reservation.pickup_deadline,
    'pickup_instructions', v_reservation.pickup_instructions, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation.id::text);
  return v_result;
end;
$$;

-- Expiry covers active reservations past their hold and prepared ones past their pickup deadline.
create or replace function private.expire_due_commercial_reservations(p_limit integer)
returns integer language plpgsql set search_path = '' as $$
declare
  v_reservation public.commercial_reservations%rowtype;
  v_count integer := 0;
begin
  for v_reservation in
    select * from public.commercial_reservations
    where (status = 'ACTIVE' and expires_at <= clock_timestamp())
      or (status = 'READY' and pickup_deadline <= clock_timestamp())
    order by coalesce(pickup_deadline, expires_at), id for update skip locked limit p_limit
  loop
    perform private.finalize_stock_reservation(
      v_reservation.stock_reservation_id, 'EXPIRED', v_reservation.customer_id, v_reservation.correlation_id
    );
    update public.commercial_reservations set status = 'EXPIRED', expired_at = now()
    where id = v_reservation.id;
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('reservations.expired', v_reservation.customer_id, 'commercial_reservation', v_reservation.id::text,
      v_reservation.correlation_id, jsonb_build_object('expires_at', v_reservation.expires_at,
        'pickup_deadline', v_reservation.pickup_deadline, 'was_ready', v_reservation.status = 'READY'));
    insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
    values ('reservations.expired', 'commercial_reservation', v_reservation.id::text,
      jsonb_build_object('reservation_id', v_reservation.id, 'customer_id', v_reservation.customer_id,
        'correlation_id', v_reservation.correlation_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Reservation list for the commission: status, customer (name or e-mail), creation period, pickup deadline.
create function public.list_commercial_reservations_admin(
  p_status text default null, p_query text default null, p_from date default null, p_to date default null,
  p_cursor uuid default null, p_limit integer default 25
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_cursor public.commercial_reservations%rowtype;
  v_query text := nullif(btrim(p_query), '');
  v_ids uuid[];
begin
  if auth.uid() is null or not public.has_permission('reservations.manage.all') then
    raise exception using errcode = '42501', message = 'RESERVATIONS_MANAGE_REQUIRED';
  end if;
  if (p_status is not null and p_status not in ('ACTIVE', 'READY', 'CONVERTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'))
    or (v_query is not null and char_length(v_query) > 80)
    or (p_from is not null and p_to is not null and p_to < p_from)
    or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_FILTER';
  end if;
  if p_cursor is not null then
    select * into v_cursor from public.commercial_reservations where id = p_cursor;
    if not found then
      raise exception using errcode = '22023', message = 'INVALID_RESERVATION_CURSOR';
    end if;
  end if;
  select array_agg(page.id order by page.created_at desc, page.id desc) into v_ids from (
    select reservation.id, reservation.created_at
    from public.commercial_reservations reservation
    join public.profiles customer on customer.id = reservation.customer_id
    where (p_status is null or reservation.status::text = p_status)
      and (v_query is null or customer.display_name ilike '%' || v_query || '%' or customer.email ilike '%' || v_query || '%')
      and (p_from is null or reservation.created_at >= (p_from::timestamp at time zone 'America/Sao_Paulo'))
      and (p_to is null or reservation.created_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo'))
      and (p_cursor is null or (reservation.created_at, reservation.id) < (v_cursor.created_at, v_cursor.id))
    order by reservation.created_at desc, reservation.id desc
    limit p_limit + 1
  ) page;

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'reservation_id', reservation.id, 'status', reservation.status, 'created_at', reservation.created_at,
        'customer_id', reservation.customer_id,
        'customer_name', coalesce(nullif(btrim(customer.display_name), ''), customer.email),
        'location_name', location.name, 'total_cents', reservation.total_cents,
        'discount_total_cents', reservation.discount_total_cents, 'expires_at', reservation.expires_at,
        'ready_at', reservation.ready_at, 'pickup_deadline', reservation.pickup_deadline,
        'pickup_instructions', reservation.pickup_instructions, 'converted_sale_id', reservation.converted_sale_id,
        'items', (select jsonb_agg(jsonb_build_object('product_name', line ->> 'product_name',
            'quantity', (line ->> 'quantity')::bigint, 'total_cents', (line ->> 'total_cents')::bigint))
          from jsonb_array_elements(reservation.quote_snapshot -> 'lines') line))
        order by page.ordinality)
      from unnest(v_ids) with ordinality as page(reservation_id, ordinality)
      join public.commercial_reservations reservation on reservation.id = page.reservation_id
      join public.profiles customer on customer.id = reservation.customer_id
      join public.stock_locations location on location.id = reservation.location_id
      where page.ordinality <= p_limit), '[]'::jsonb),
    'next_cursor', case when coalesce(array_length(v_ids, 1), 0) > p_limit then v_ids[p_limit] end);
end;
$$;

revoke all on function public.update_reservation_settings(integer, integer, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.mark_commercial_reservation_ready(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_commercial_reservations_admin(text, text, date, date, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.update_reservation_settings(integer, integer, text, uuid) to authenticated;
grant execute on function public.mark_commercial_reservation_ready(uuid, text, text, uuid) to authenticated;
grant execute on function public.list_commercial_reservations_admin(text, text, date, date, uuid, integer) to authenticated;

comment on table public.reservation_settings is 'Spec 5.17: reservation hold and pickup windows, in hours.';
comment on function public.mark_commercial_reservation_ready(uuid, text, text, uuid) is
  'Commission prepares an active reservation: READY with pickup instructions and a configured pickup deadline.';

-- Cancellation also releases prepared reservations, but only the commission may cancel one.
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
  if v_reservation.status in ('CONVERTED', 'COMPLETED') then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_ALREADY_CONVERTED';
  end if;
  -- A prepared reservation is only cancelled by the commission (spec 4.3: the customer only sees instructions).
  if v_reservation.status = 'READY' and not public.has_permission('reservations.manage.all') then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_READY_CANCEL_FORBIDDEN';
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

  if v_reservation.status in ('ACTIVE', 'READY') then
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
    'status', case when v_reservation.status in ('ACTIVE', 'READY') then 'CANCELLED' else v_reservation.status end,
    'stock_reservation', v_stock,
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation.id::text
  );
  return v_result;
end;
$$;
