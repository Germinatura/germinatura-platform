create type public.stock_movement_type as enum (
  'SALDO_INICIAL',
  'ENTRADA_COMPRA',
  'TRANSFERENCIA',
  'VENDA',
  'RESERVA',
  'LIBERACAO_RESERVA',
  'PERDA',
  'VENCIMENTO',
  'DEVOLUCAO',
  'AJUSTE_POSITIVO',
  'AJUSTE_NEGATIVO',
  'CANCELAMENTO_VENDA'
);

create type public.outbox_status as enum ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  movement_type public.stock_movement_type not null,
  from_location_id uuid references public.stock_locations(id) on delete restrict,
  to_location_id uuid references public.stock_locations(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null,
  correlation_id uuid not null,
  source_type text,
  source_id text,
  reversal_of uuid unique references public.stock_movements(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint stock_movements_reason_valid check (
    char_length(reason) between 1 and 500 and reason = btrim(reason)
  ),
  constraint stock_movements_source_pair_valid check (
    (source_type is null and source_id is null)
    or (
      source_type is not null and source_id is not null
      and char_length(source_type) between 1 and 64
      and source_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
      and char_length(source_id) between 1 and 128
      and source_id = btrim(source_id)
    )
  ),
  constraint stock_movements_locations_valid check (
    (
      movement_type = 'TRANSFERENCIA'
      and from_location_id is not null and to_location_id is not null
      and from_location_id <> to_location_id
    )
    or (
      movement_type in ('SALDO_INICIAL', 'ENTRADA_COMPRA', 'DEVOLUCAO', 'AJUSTE_POSITIVO', 'CANCELAMENTO_VENDA')
      and from_location_id is null and to_location_id is not null
    )
    or (
      movement_type in ('VENDA', 'RESERVA', 'LIBERACAO_RESERVA', 'PERDA', 'VENCIMENTO', 'AJUSTE_NEGATIVO')
      and from_location_id is not null and to_location_id is null
    )
  ),
  constraint stock_movements_not_self_reversal check (reversal_of is null or reversal_of <> id)
);

create index stock_movements_from_location_created_idx
  on public.stock_movements (from_location_id, created_at desc)
  where from_location_id is not null;
create index stock_movements_to_location_created_idx
  on public.stock_movements (to_location_id, created_at desc)
  where to_location_id is not null;
create index stock_movements_correlation_id_idx
  on public.stock_movements (correlation_id);

create table public.stock_movement_items (
  id uuid primary key default gen_random_uuid(),
  movement_id uuid not null references public.stock_movements(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity bigint not null,
  created_at timestamptz not null default now(),
  constraint stock_movement_items_movement_product_unique unique (movement_id, product_id),
  constraint stock_movement_items_quantity_valid check (quantity between 1 and 9007199254740991)
);

create index stock_movement_items_product_id_idx on public.stock_movement_items (product_id);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  entity_type text not null,
  entity_id text not null,
  correlation_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_logs_action_valid check (
    char_length(action) between 1 and 100 and action ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  constraint audit_logs_entity_type_valid check (
    char_length(entity_type) between 1 and 64 and entity_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
  ),
  constraint audit_logs_entity_id_valid check (
    char_length(entity_id) between 1 and 128 and entity_id = btrim(entity_id)
  ),
  constraint audit_logs_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_correlation_id_idx on public.audit_logs (correlation_id);

create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  payload jsonb not null,
  status public.outbox_status not null default 'PENDING',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outbox_events_topic_valid check (
    char_length(topic) between 1 and 100 and topic ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  constraint outbox_events_aggregate_valid check (
    char_length(aggregate_type) between 1 and 64
    and aggregate_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
    and char_length(aggregate_id) between 1 and 128
    and aggregate_id = btrim(aggregate_id)
  ),
  constraint outbox_events_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint outbox_events_attempts_valid check (attempts >= 0),
  constraint outbox_events_lock_pair_valid check (
    (locked_at is null and locked_by is null)
    or (
      locked_at is not null and locked_by is not null
      and char_length(locked_by) between 1 and 100 and locked_by = btrim(locked_by)
    )
  ),
  constraint outbox_events_state_valid check (
    (status = 'PENDING' and locked_at is null and locked_by is null and published_at is null)
    or (status = 'PROCESSING' and locked_at is not null and locked_by is not null and published_at is null)
    or (status = 'PUBLISHED' and locked_at is null and locked_by is null and published_at is not null)
    or (status = 'FAILED' and locked_at is null and locked_by is null and published_at is null and last_error is not null)
  )
);

create index outbox_events_claim_idx
  on public.outbox_events (available_at, created_at)
  where status = 'PENDING';

create or replace function private.prevent_immutable_record_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'IMMUTABLE_RECORD';
end;
$$;

create trigger stock_movements_immutable before update or delete on public.stock_movements
for each row execute function private.prevent_immutable_record_change();
create trigger stock_movement_items_immutable before update or delete on public.stock_movement_items
for each row execute function private.prevent_immutable_record_change();
create trigger audit_logs_immutable before update or delete on public.audit_logs
for each row execute function private.prevent_immutable_record_change();
create trigger outbox_events_set_updated_at before update on public.outbox_events
for each row execute function private.set_updated_at();

create or replace function private.record_inventory_effect(
  p_movement_type public.stock_movement_type,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_product_id uuid,
  p_quantity bigint,
  p_actor_id uuid,
  p_reason text,
  p_correlation_id uuid,
  p_reversal_of uuid default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_movement_id uuid;
begin
  insert into public.stock_movements (
    movement_type, from_location_id, to_location_id, actor_id, reason,
    correlation_id, source_type, source_id, reversal_of
  ) values (
    p_movement_type, p_from_location_id, p_to_location_id, p_actor_id, p_reason,
    p_correlation_id, 'idempotency_key', current_setting('request.idempotency_key', true), p_reversal_of
  ) returning id into v_movement_id;

  insert into public.stock_movement_items (movement_id, product_id, quantity)
  values (v_movement_id, p_product_id, p_quantity);

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'inventory.movement.created', p_actor_id, 'stock_movement', v_movement_id::text,
    p_correlation_id,
    jsonb_build_object(
      'movement_type', p_movement_type,
      'product_id', p_product_id,
      'quantity', p_quantity,
      'from_location_id', p_from_location_id,
      'to_location_id', p_to_location_id,
      'reversal_of', p_reversal_of
    )
  );

  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'inventory.movement.created', 'stock_movement', v_movement_id::text,
    jsonb_build_object(
      'movement_id', v_movement_id,
      'movement_type', p_movement_type,
      'product_id', p_product_id,
      'quantity', p_quantity,
      'correlation_id', p_correlation_id
    )
  );

  return v_movement_id;
end;
$$;

create or replace function public.adjust_stock(
  p_location_id uuid,
  p_product_id uuid,
  p_quantity_delta bigint,
  p_reason text,
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
  v_scope text;
  v_claim record;
  v_balance public.inventory_balances%rowtype;
  v_new_on_hand bigint;
  v_movement_id uuid;
  v_result jsonb;
  v_type public.stock_movement_type;
begin
  if v_actor_id is null or not public.has_permission('inventory.manage') then
    raise exception using errcode = '42501', message = 'INVENTORY_MANAGE_REQUIRED';
  end if;
  if p_quantity_delta is null or p_quantity_delta = 0
    or p_quantity_delta not between -9007199254740991 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'INVALID_QUANTITY_DELTA';
  end if;
  if p_reason is null or char_length(p_reason) not between 1 and 500 or p_reason <> btrim(p_reason) then
    raise exception using errcode = '22023', message = 'INVALID_REASON';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;
  if not exists (select 1 from public.stock_locations where id = p_location_id and active) then
    raise exception using errcode = 'P0001', message = 'STOCK_LOCATION_NOT_FOUND';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and active) then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;

  v_scope := private.build_idempotency_scope('inventory', 'adjust', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope,
    p_idempotency_key,
    jsonb_build_object(
      'location_id', p_location_id,
      'product_id', p_product_id,
      'quantity_delta', p_quantity_delta,
      'reason', p_reason
    )
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  perform set_config('request.idempotency_key', p_idempotency_key, true);
  insert into public.inventory_balances (location_id, product_id)
  values (p_location_id, p_product_id)
  on conflict (location_id, product_id) do nothing;

  select * into strict v_balance from public.inventory_balances
  where location_id = p_location_id and product_id = p_product_id
  for update;

  v_new_on_hand := v_balance.on_hand_quantity + p_quantity_delta;
  if v_new_on_hand < v_balance.reserved_quantity or v_new_on_hand > 9007199254740991 then
    raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT';
  end if;

  update public.inventory_balances
  set on_hand_quantity = v_new_on_hand
  where id = v_balance.id;

  v_type := case when p_quantity_delta > 0 then 'AJUSTE_POSITIVO'::public.stock_movement_type
    else 'AJUSTE_NEGATIVO'::public.stock_movement_type end;
  v_movement_id := private.record_inventory_effect(
    v_type,
    case when p_quantity_delta < 0 then p_location_id else null end,
    case when p_quantity_delta > 0 then p_location_id else null end,
    p_product_id, abs(p_quantity_delta), v_actor_id, p_reason, p_correlation_id
  );

  v_result := jsonb_build_object(
    'movement_id', v_movement_id,
    'location_id', p_location_id,
    'product_id', p_product_id,
    'on_hand_quantity', v_new_on_hand,
    'reserved_quantity', v_balance.reserved_quantity,
    'available_quantity', v_new_on_hand - v_balance.reserved_quantity
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'stock_movement', v_movement_id::text
  );
  return v_result;
end;
$$;

create or replace function public.transfer_stock(
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_product_id uuid,
  p_quantity bigint,
  p_reason text,
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
  v_scope text;
  v_claim record;
  v_from public.inventory_balances%rowtype;
  v_to public.inventory_balances%rowtype;
  v_movement_id uuid;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('inventory.manage') then
    raise exception using errcode = '42501', message = 'INVENTORY_MANAGE_REQUIRED';
  end if;
  if p_from_location_id is null or p_to_location_id is null or p_from_location_id = p_to_location_id then
    raise exception using errcode = '22023', message = 'INVALID_TRANSFER_LOCATIONS';
  end if;
  if p_quantity is null or p_quantity not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'INVALID_QUANTITY';
  end if;
  if p_reason is null or char_length(p_reason) not between 1 and 500 or p_reason <> btrim(p_reason) then
    raise exception using errcode = '22023', message = 'INVALID_REASON';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;
  if (select count(*) from public.stock_locations where id in (p_from_location_id, p_to_location_id) and active) <> 2 then
    raise exception using errcode = 'P0001', message = 'STOCK_LOCATION_NOT_FOUND';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and active) then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;

  v_scope := private.build_idempotency_scope('inventory', 'transfer', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope,
    p_idempotency_key,
    jsonb_build_object(
      'from_location_id', p_from_location_id,
      'to_location_id', p_to_location_id,
      'product_id', p_product_id,
      'quantity', p_quantity,
      'reason', p_reason
    )
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  perform set_config('request.idempotency_key', p_idempotency_key, true);
  insert into public.inventory_balances (location_id, product_id)
  values (p_to_location_id, p_product_id)
  on conflict (location_id, product_id) do nothing;

  perform 1 from public.inventory_balances
  where location_id in (p_from_location_id, p_to_location_id) and product_id = p_product_id
  order by location_id
  for update;

  select * into v_from from public.inventory_balances
  where location_id = p_from_location_id and product_id = p_product_id;
  if not found or v_from.available_quantity < p_quantity then
    raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT';
  end if;
  select * into strict v_to from public.inventory_balances
  where location_id = p_to_location_id and product_id = p_product_id;
  if v_to.on_hand_quantity + p_quantity > 9007199254740991 then
    raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT';
  end if;

  update public.inventory_balances set on_hand_quantity = on_hand_quantity - p_quantity where id = v_from.id;
  update public.inventory_balances set on_hand_quantity = on_hand_quantity + p_quantity where id = v_to.id;

  v_movement_id := private.record_inventory_effect(
    'TRANSFERENCIA', p_from_location_id, p_to_location_id, p_product_id,
    p_quantity, v_actor_id, p_reason, p_correlation_id
  );
  v_result := jsonb_build_object(
    'movement_id', v_movement_id,
    'from_location_id', p_from_location_id,
    'to_location_id', p_to_location_id,
    'product_id', p_product_id,
    'quantity', p_quantity,
    'from_on_hand_quantity', v_from.on_hand_quantity - p_quantity,
    'to_on_hand_quantity', v_to.on_hand_quantity + p_quantity
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'stock_movement', v_movement_id::text
  );
  return v_result;
end;
$$;

create or replace function public.reverse_stock_movement(
  p_movement_id uuid,
  p_reason text,
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
  v_scope text;
  v_claim record;
  v_original public.stock_movements%rowtype;
  v_item public.stock_movement_items%rowtype;
  v_from_id uuid;
  v_to_id uuid;
  v_reverse_type public.stock_movement_type;
  v_from public.inventory_balances%rowtype;
  v_to public.inventory_balances%rowtype;
  v_reversal_id uuid;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('inventory.manage') then
    raise exception using errcode = '42501', message = 'INVENTORY_MANAGE_REQUIRED';
  end if;
  if p_reason is null or char_length(p_reason) not between 1 and 500 or p_reason <> btrim(p_reason) then
    raise exception using errcode = '22023', message = 'INVALID_REASON';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;

  v_scope := private.build_idempotency_scope('inventory', 'reverse', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object('movement_id', p_movement_id, 'reason', p_reason)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  select * into v_original from public.stock_movements where id = p_movement_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MOVEMENT_NOT_FOUND';
  end if;
  if v_original.reversal_of is not null
    or exists (select 1 from public.stock_movements where reversal_of = p_movement_id) then
    raise exception using errcode = 'P0001', message = 'MOVEMENT_ALREADY_REVERSED';
  end if;
  if v_original.movement_type not in ('AJUSTE_POSITIVO', 'AJUSTE_NEGATIVO', 'TRANSFERENCIA') then
    raise exception using errcode = 'P0001', message = 'MOVEMENT_REVERSAL_NOT_SUPPORTED';
  end if;
  select * into strict v_item from public.stock_movement_items where movement_id = p_movement_id;

  if v_original.movement_type = 'AJUSTE_POSITIVO' then
    v_reverse_type := 'AJUSTE_NEGATIVO';
    v_from_id := v_original.to_location_id;
    v_to_id := null;
  elsif v_original.movement_type = 'AJUSTE_NEGATIVO' then
    v_reverse_type := 'AJUSTE_POSITIVO';
    v_from_id := null;
    v_to_id := v_original.from_location_id;
  else
    v_reverse_type := 'TRANSFERENCIA';
    v_from_id := v_original.to_location_id;
    v_to_id := v_original.from_location_id;
  end if;

  perform set_config('request.idempotency_key', p_idempotency_key, true);
  if v_to_id is not null then
    insert into public.inventory_balances (location_id, product_id)
    values (v_to_id, v_item.product_id) on conflict (location_id, product_id) do nothing;
  end if;

  perform 1 from public.inventory_balances
  where location_id in (v_from_id, v_to_id) and product_id = v_item.product_id
  order by location_id
  for update;

  if v_from_id is not null then
    select * into strict v_from from public.inventory_balances
    where location_id = v_from_id and product_id = v_item.product_id;
    if v_from.available_quantity < v_item.quantity then
      raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT';
    end if;
  end if;
  if v_to_id is not null then
    select * into strict v_to from public.inventory_balances
    where location_id = v_to_id and product_id = v_item.product_id;
    if v_to.on_hand_quantity + v_item.quantity > 9007199254740991 then
      raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT';
    end if;
  end if;

  if v_from_id is not null then
    update public.inventory_balances set on_hand_quantity = on_hand_quantity - v_item.quantity where id = v_from.id;
  end if;
  if v_to_id is not null then
    update public.inventory_balances set on_hand_quantity = on_hand_quantity + v_item.quantity where id = v_to.id;
  end if;

  v_reversal_id := private.record_inventory_effect(
    v_reverse_type, v_from_id, v_to_id, v_item.product_id, v_item.quantity,
    v_actor_id, p_reason, p_correlation_id, p_movement_id
  );
  v_result := jsonb_build_object(
    'movement_id', v_reversal_id,
    'reversal_of', p_movement_id,
    'product_id', v_item.product_id,
    'quantity', v_item.quantity
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'stock_movement', v_reversal_id::text
  );
  return v_result;
end;
$$;

create or replace function private.claim_outbox_events(
  p_worker_id text,
  p_batch_size integer default 50,
  p_lease interval default interval '5 minutes'
)
returns setof public.outbox_events
language plpgsql
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 100 or p_worker_id <> btrim(p_worker_id)
    or p_batch_size not between 1 and 100 or p_lease <= interval '0 seconds' then
    raise exception using errcode = '22023', message = 'INVALID_OUTBOX_CLAIM';
  end if;
  return query
    with candidates as (
      select id from public.outbox_events
      where (
        (status = 'PENDING' and available_at <= now())
        or (status = 'PROCESSING' and locked_at < now() - p_lease)
      )
      order by available_at, created_at
      for update skip locked
      limit p_batch_size
    )
    update public.outbox_events event
    set status = 'PROCESSING', attempts = attempts + 1,
        locked_at = now(), locked_by = p_worker_id, last_error = null
    from candidates
    where event.id = candidates.id
    returning event.*;
end;
$$;

create or replace function private.ack_outbox_event(p_event_id uuid, p_worker_id text)
returns public.outbox_events
language plpgsql
set search_path = ''
as $$
declare v_event public.outbox_events%rowtype;
begin
  update public.outbox_events
  set status = 'PUBLISHED', published_at = now(), locked_at = null, locked_by = null
  where id = p_event_id and status = 'PROCESSING' and locked_by = p_worker_id
  returning * into v_event;
  if not found then
    raise exception using errcode = 'P0001', message = 'OUTBOX_CLAIM_MISMATCH';
  end if;
  return v_event;
end;
$$;

create or replace function private.retry_outbox_event(
  p_event_id uuid,
  p_worker_id text,
  p_error text,
  p_available_at timestamptz,
  p_max_attempts integer default 10
)
returns public.outbox_events
language plpgsql
set search_path = ''
as $$
declare v_event public.outbox_events%rowtype;
begin
  if p_error is null or char_length(p_error) not between 1 and 1000
    or p_available_at is null or p_max_attempts not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_OUTBOX_RETRY';
  end if;
  update public.outbox_events
  set status = case when attempts >= p_max_attempts then 'FAILED'::public.outbox_status else 'PENDING'::public.outbox_status end,
      available_at = p_available_at,
      locked_at = null,
      locked_by = null,
      last_error = p_error
  where id = p_event_id and status = 'PROCESSING' and locked_by = p_worker_id
  returning * into v_event;
  if not found then
    raise exception using errcode = 'P0001', message = 'OUTBOX_CLAIM_MISMATCH';
  end if;
  return v_event;
end;
$$;

alter table public.stock_movements enable row level security;
alter table public.stock_movement_items enable row level security;
alter table public.audit_logs enable row level security;
alter table public.outbox_events enable row level security;

revoke all on table public.stock_movements from public, anon, authenticated, service_role;
revoke all on table public.stock_movement_items from public, anon, authenticated, service_role;
revoke all on table public.audit_logs from public, anon, authenticated, service_role;
revoke all on table public.outbox_events from public, anon, authenticated, service_role;
grant select on table public.stock_movements to authenticated;
grant select on table public.stock_movement_items to authenticated;

create policy stock_movements_seller_read on public.stock_movements for select to authenticated
using (
  public.has_permission('inventory.read')
  and exists (
    select 1 from public.stock_locations
    where stock_locations.seller_id = auth.uid()
      and stock_locations.id in (stock_movements.from_location_id, stock_movements.to_location_id)
  )
);
create policy stock_movements_manager_read on public.stock_movements for select to authenticated
using (public.has_permission('inventory.manage'));
create policy stock_movement_items_visible_movement_read on public.stock_movement_items for select to authenticated
using (exists (select 1 from public.stock_movements where stock_movements.id = stock_movement_items.movement_id));

revoke all on function private.prevent_immutable_record_change() from public, anon, authenticated, service_role;
revoke all on function private.record_inventory_effect(public.stock_movement_type, uuid, uuid, uuid, bigint, uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.claim_outbox_events(text, integer, interval) from public, anon, authenticated, service_role;
revoke all on function private.ack_outbox_event(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.retry_outbox_event(uuid, text, text, timestamptz, integer) from public, anon, authenticated, service_role;

revoke all on function public.adjust_stock(uuid, uuid, bigint, text, text, uuid) from public;
revoke all on function public.transfer_stock(uuid, uuid, uuid, bigint, text, text, uuid) from public;
revoke all on function public.reverse_stock_movement(uuid, text, text, uuid) from public;
grant execute on function public.adjust_stock(uuid, uuid, bigint, text, text, uuid) to authenticated;
grant execute on function public.transfer_stock(uuid, uuid, uuid, bigint, text, text, uuid) to authenticated;
grant execute on function public.reverse_stock_movement(uuid, text, text, uuid) to authenticated;

comment on table public.stock_movements is 'Immutable inventory movement headers; corrections are linked reversal movements.';
comment on table public.stock_movement_items is 'Immutable product quantities belonging to inventory movements.';
comment on table public.audit_logs is 'Internal immutable audit trail; no direct Data API access.';
comment on table public.outbox_events is 'Transactional outbox; internal workers claim and acknowledge events after commit.';
