create type public.payment_attempt_status as enum (
  'CREATED',
  'PENDING',
  'AWAITING_EXTERNAL_CONFIRMATION',
  'APPROVED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
  'RECONCILIATION_PENDING',
  'RECONCILED'
);

create type public.payment_integration_channel as enum (
  'PIX_AREA',
  'CHECKOUT_API',
  'PICPAY_WALLET',
  'PAYMENT_LINK',
  'MAQUININHA',
  'TAP'
);

create type public.payment_confirmation_source as enum (
  'WEBHOOK',
  'STATUS_QUERY',
  'MANUAL',
  'RECONCILIATION_IMPORT'
);

create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  status public.payment_attempt_status not null default 'CREATED',
  amount_cents bigint not null,
  currency text not null default 'BRL',
  integration_channel public.payment_integration_channel,
  confirmation_source public.payment_confirmation_source,
  operator_id uuid not null references public.profiles(id) on delete restrict,
  idempotency_key text not null,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_attempts_operator_key_unique unique (operator_id, idempotency_key),
  constraint payment_attempts_amount_valid check (amount_cents between 0 and 9007199254740991),
  constraint payment_attempts_currency_brl check (currency = 'BRL'),
  constraint payment_attempts_key_valid check (
    char_length(idempotency_key) between 1 and 128
    and idempotency_key = btrim(idempotency_key)
    and idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint payment_attempts_initial_origin_valid check (
    status <> 'CREATED' or (integration_channel is null and confirmation_source is null)
  )
);

create index payment_attempts_sale_created_idx on public.payment_attempts (sale_id, created_at desc);
create index payment_attempts_status_created_idx on public.payment_attempts (status, created_at);
create index payment_attempts_correlation_idx on public.payment_attempts (correlation_id);

create table public.payment_attempt_status_history (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.payment_attempts(id) on delete restrict,
  from_status public.payment_attempt_status,
  to_status public.payment_attempt_status not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint payment_attempt_history_change_valid check (
    from_status is null or from_status <> to_status
  ),
  constraint payment_attempt_history_reason_valid check (
    reason is null or (char_length(reason) between 1 and 500 and reason = btrim(reason))
  )
);

create index payment_attempt_history_attempt_created_idx
  on public.payment_attempt_status_history (attempt_id, created_at, id);
create index payment_attempt_history_correlation_idx
  on public.payment_attempt_status_history (correlation_id);

create unique index stock_reservations_sale_origin_unique
  on public.stock_reservations (origin_id)
  where origin_type = 'sale';

create or replace function private.guard_payment_attempt_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'CREATED'
    or new.integration_channel is not null
    or new.confirmation_source is not null then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_MUST_START_CREATED';
  end if;
  return new;
end;
$$;

create or replace function private.prevent_payment_attempt_hard_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_HARD_DELETE_FORBIDDEN';
end;
$$;

create or replace function private.record_initial_payment_attempt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.payment_attempt_status_history (
    attempt_id, from_status, to_status, actor_id, correlation_id
  ) values (
    new.id, null, 'CREATED', new.operator_id, new.correlation_id
  );

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'payments.attempt.created', new.operator_id, 'payment_attempt', new.id::text,
    new.correlation_id,
    jsonb_build_object(
      'sale_id', new.sale_id,
      'status', new.status,
      'amount_cents', new.amount_cents,
      'currency', new.currency
    )
  );

  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'payments.attempt.created', 'payment_attempt', new.id::text,
    jsonb_build_object(
      'attempt_id', new.id,
      'sale_id', new.sale_id,
      'status', new.status,
      'correlation_id', new.correlation_id
    )
  );
  return new;
end;
$$;

create or replace function private.transition_payment_attempt(
  p_attempt_id uuid,
  p_target_status public.payment_attempt_status,
  p_actor_id uuid,
  p_correlation_id uuid,
  p_reason text default null
)
returns public.payment_attempts
language plpgsql
set search_path = ''
as $$
declare
  v_attempt public.payment_attempts%rowtype;
begin
  if p_actor_id is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_TRANSITION_CONTEXT';
  end if;
  if p_reason is not null and (
    char_length(p_reason) not between 1 and 500 or p_reason <> btrim(p_reason)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_TRANSITION_REASON';
  end if;
  if not exists (select 1 from public.profiles where id = p_actor_id and active) then
    raise exception using errcode = '42501', message = 'PAYMENT_ACTOR_INACTIVE';
  end if;

  select * into v_attempt from public.payment_attempts where id = p_attempt_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status = p_target_status then
    return v_attempt;
  end if;
  if not (v_attempt.status = 'CREATED' and p_target_status = 'CANCELLED') then
    raise exception using errcode = 'P0001', message = 'INVALID_PAYMENT_TRANSITION';
  end if;

  update public.payment_attempts set status = p_target_status where id = v_attempt.id
  returning * into v_attempt;
  insert into public.payment_attempt_status_history (
    attempt_id, from_status, to_status, actor_id, reason, correlation_id
  ) values (
    v_attempt.id, 'CREATED', p_target_status, p_actor_id, p_reason, p_correlation_id
  );
  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'payments.attempt.status.changed', p_actor_id, 'payment_attempt', v_attempt.id::text,
    p_correlation_id, jsonb_build_object('status', p_target_status, 'reason', p_reason)
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'payments.attempt.status.changed', 'payment_attempt', v_attempt.id::text,
    jsonb_build_object(
      'attempt_id', v_attempt.id,
      'sale_id', v_attempt.sale_id,
      'status', p_target_status,
      'correlation_id', p_correlation_id
    )
  );
  return v_attempt;
end;
$$;

-- The foundation implementation inferred from_status from history ordered by a
-- transaction-stable timestamp. Consecutive transitions in one transaction can
-- share that timestamp, so the locked aggregate state is the only authoritative
-- transition origin.
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
  v_from_status public.sale_status;
begin
  if p_actor_id is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_SALE_TRANSITION_CONTEXT';
  end if;
  if p_reason is not null and (
    char_length(p_reason) not between 1 and 500 or p_reason <> btrim(p_reason)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SALE_TRANSITION_REASON';
  end if;
  if not exists (select 1 from public.profiles where id = p_actor_id and active) then
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

  v_from_status := v_sale.status;
  update public.sales set status = p_target_status where id = v_sale.id
  returning * into v_sale;
  insert into public.sale_status_history (
    sale_id, from_status, to_status, actor_id, reason, correlation_id
  ) values (
    v_sale.id, v_from_status, p_target_status, p_actor_id, p_reason, p_correlation_id
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

create trigger payment_attempts_guard_insert before insert on public.payment_attempts
for each row execute function private.guard_payment_attempt_insert();
create trigger payment_attempts_prevent_hard_delete before delete on public.payment_attempts
for each row execute function private.prevent_payment_attempt_hard_delete();
create trigger payment_attempts_set_updated_at before update on public.payment_attempts
for each row execute function private.set_updated_at();
create trigger payment_attempts_record_initial after insert on public.payment_attempts
for each row execute function private.record_initial_payment_attempt();
create trigger payment_attempt_status_history_immutable before update or delete
on public.payment_attempt_status_history
for each row execute function private.prevent_immutable_record_change();

create or replace function private.price_sale_items(
  p_channel public.promotion_channel,
  p_items jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item record;
  v_price record;
  v_product_sku text;
  v_quoted_at timestamptz;
  v_available_groups bigint;
  v_groups bigint;
  v_original_subtotal bigint;
  v_effective_subtotal bigint;
  v_discount bigint;
  v_original_total bigint := 0;
  v_discount_total bigint := 0;
  v_total bigint := 0;
  v_promotion_snapshot jsonb;
  v_lines jsonb := '[]'::jsonb;
begin
  for v_item in
    select item.product_id, item.quantity
    from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint)
    order by item.product_id
  loop
    if exists (
      select 1
      from public.get_pricing_quote_inputs(p_channel, array[v_item.product_id]) candidate
      where candidate.promotion_id is not null
        and candidate.group_quantity is not null
        and candidate.group_price_cents is not null
        and candidate.group_price_cents >= candidate.amount_cents * candidate.group_quantity
    ) then
      raise exception using errcode = 'P0001', message = 'INVALID_PROMOTION_GROUP_PRICE';
    end if;

    select candidate.* into v_price
    from public.get_pricing_quote_inputs(p_channel, array[v_item.product_id]) candidate
    order by
      case when candidate.promotion_id is not null
        and least(
          floor(v_item.quantity::numeric / candidate.group_quantity)::bigint,
          coalesce(candidate.max_groups_per_line::bigint, 9007199254740991)
        ) > 0 then 0 else 1 end,
      candidate.priority desc nulls last,
      case when candidate.promotion_id is not null then
        candidate.group_price_cents * least(
          floor(v_item.quantity::numeric / candidate.group_quantity)::bigint,
          coalesce(candidate.max_groups_per_line::bigint, 9007199254740991)
        )
        + candidate.amount_cents * (
          v_item.quantity - candidate.group_quantity * least(
            floor(v_item.quantity::numeric / candidate.group_quantity)::bigint,
            coalesce(candidate.max_groups_per_line::bigint, 9007199254740991)
          )
        )
      else candidate.amount_cents * v_item.quantity end,
      candidate.promotion_id
    limit 1;

    if not found then
      raise exception using errcode = 'P0001', message = 'PRODUCT_UNAVAILABLE';
    end if;
    select sku into v_product_sku from public.products where id = v_item.product_id;

    if v_quoted_at is null then
      v_quoted_at := v_price.quoted_at;
    elsif v_quoted_at <> v_price.quoted_at then
      raise exception using errcode = 'P0001', message = 'PRICING_INSTANT_MISMATCH';
    end if;

    v_original_subtotal := v_price.amount_cents * v_item.quantity;
    v_available_groups := case when v_price.promotion_id is null then 0
      else floor(v_item.quantity::numeric / v_price.group_quantity)::bigint end;
    v_groups := case when v_price.promotion_id is null then 0
      else least(v_available_groups, coalesce(v_price.max_groups_per_line::bigint, v_available_groups)) end;

    if v_groups > 0 then
      v_effective_subtotal := (v_price.group_price_cents * v_groups)
        + (v_price.amount_cents * (v_item.quantity - (v_groups * v_price.group_quantity)));
      v_discount := v_original_subtotal - v_effective_subtotal;
      v_promotion_snapshot := jsonb_build_object(
        'promotion_id', v_price.promotion_id,
        'type', v_price.rule_type,
        'priority', v_price.priority,
        'group_quantity', v_price.group_quantity,
        'group_price_cents', v_price.group_price_cents,
        'max_groups_per_line', v_price.max_groups_per_line,
        'groups', v_groups,
        'promoted_quantity', v_groups * v_price.group_quantity,
        'remainder_quantity', v_item.quantity - (v_groups * v_price.group_quantity),
        'savings_cents', v_discount
      );
    else
      v_effective_subtotal := v_original_subtotal;
      v_discount := 0;
      v_promotion_snapshot := null;
    end if;

    if v_original_subtotal > 9007199254740991
      or v_effective_subtotal > 9007199254740991 then
      raise exception using errcode = '22003', message = 'MONEY_OVERFLOW';
    end if;

    v_original_total := v_original_total + v_original_subtotal;
    v_discount_total := v_discount_total + v_discount;
    v_total := v_total + v_effective_subtotal;
    if v_original_total > 9007199254740991 or v_total > 9007199254740991 then
      raise exception using errcode = '22003', message = 'MONEY_OVERFLOW';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_item.product_id,
      'product_sku', v_product_sku,
      'product_name', v_price.product_name,
      'quantity', v_item.quantity,
      'unit_price_cents', v_price.amount_cents,
      'original_subtotal_cents', v_original_subtotal,
      'discount_cents', v_discount,
      'total_cents', v_effective_subtotal,
      'promotion_id', case when v_groups > 0 then v_price.promotion_id else null end,
      'promotion_snapshot', v_promotion_snapshot
    ));
  end loop;

  return jsonb_build_object(
    'quoted_at', v_quoted_at,
    'currency', 'BRL',
    'rounding', 'NONE',
    'lines', v_lines,
    'original_total_cents', v_original_total,
    'discount_total_cents', v_discount_total,
    'total_cents', v_total
  );
end;
$$;

create or replace function private.reserve_stock_for_sale(
  p_sale_id uuid,
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
  v_reservation_id uuid := gen_random_uuid();
  v_movement_id uuid;
  v_expires_at timestamptz := clock_timestamp() + interval '10 minutes';
begin
  if not exists (
    select 1 from public.sales sale
    where sale.id = p_sale_id and sale.location_id = p_location_id
      and sale.created_by = p_actor_id and sale.status = 'DRAFT'
  ) then
    raise exception using errcode = 'P0001', message = 'SALE_RESERVATION_CONTEXT_INVALID';
  end if;

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
    v_reservation_id, 'RESERVA', p_location_id, p_items, p_actor_id,
    'Reserva de estoque da venda', p_correlation_id
  );
  insert into public.stock_reservations (
    id, location_id, actor_id, origin_type, origin_id,
    reservation_movement_id, expires_at
  ) values (
    v_reservation_id, p_location_id, p_actor_id, 'sale', p_sale_id::text,
    v_movement_id, v_expires_at
  );
  insert into public.stock_reservation_items (reservation_id, product_id, quantity)
  select v_reservation_id, item.product_id, item.quantity
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint);

  update public.inventory_balances balance
  set reserved_quantity = balance.reserved_quantity + item.quantity
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint)
  where balance.location_id = p_location_id and balance.product_id = item.product_id;

  return jsonb_build_object(
    'reservation_id', v_reservation_id,
    'status', 'ACTIVE',
    'expires_at', v_expires_at,
    'reservation_movement_id', v_movement_id
  );
end;
$$;

create or replace function public.checkout_sale(
  p_channel public.promotion_channel,
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
  v_sale_id uuid := gen_random_uuid();
  v_attempt_id uuid := gen_random_uuid();
  v_reservation jsonb;
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;
  if p_channel not in ('PORTAL', 'PDV') then
    raise exception using errcode = '22023', message = 'SALE_CHANNEL_UNSUPPORTED';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_SALE_ITEMS';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) element
    where jsonb_typeof(element) <> 'object'
      or element - 'product_id' - 'quantity' <> '{}'::jsonb
      or not (element ? 'product_id' and element ? 'quantity')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SALE_ITEMS';
  end if;

  select
    jsonb_agg(jsonb_build_object('product_id', item.product_id, 'quantity', item.quantity) order by item.product_id),
    count(*), count(distinct item.product_id),
    count(*) filter (where item.product_id is null or item.quantity not between 1 and 9007199254740991)
  into v_items, v_item_count, v_distinct_count, v_invalid_count
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint);
  if v_invalid_count > 0 or v_item_count <> v_distinct_count then
    raise exception using errcode = '22023', message = 'INVALID_SALE_ITEMS';
  end if;

  if p_channel = 'PDV' then
    if not public.has_permission('sales.create') or not exists (
      select 1 from public.stock_locations location
      where location.id = p_location_id and location.active
        and (
          public.has_permission('inventory.manage')
          or (location.location_type = 'SELLER' and location.seller_id = v_actor_id)
        )
    ) then
      raise exception using errcode = '42501', message = 'SALE_LOCATION_FORBIDDEN';
    end if;
  elsif not public.has_permission('portal.access') or not exists (
    select 1 from public.stock_locations location
    where location.id = p_location_id and location.active and location.location_type = 'CENTRAL'
  ) then
    raise exception using errcode = '42501', message = 'SALE_LOCATION_FORBIDDEN';
  end if;

  v_scope := private.build_idempotency_scope('sales', 'checkout', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object('channel', p_channel, 'location_id', p_location_id, 'items', v_items)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  v_quote := private.price_sale_items(p_channel, v_items);
  insert into public.sales (
    id, channel, location_id, created_by, customer_id,
    original_total_cents, discount_total_cents, total_cents,
    quoted_at, correlation_id
  ) values (
    v_sale_id, p_channel, p_location_id, v_actor_id,
    case when p_channel = 'PORTAL' then v_actor_id else null end,
    (v_quote ->> 'original_total_cents')::bigint,
    (v_quote ->> 'discount_total_cents')::bigint,
    (v_quote ->> 'total_cents')::bigint,
    (v_quote ->> 'quoted_at')::timestamptz,
    p_correlation_id
  );

  insert into public.sale_items (
    sale_id, product_id, product_sku, product_name, quantity,
    unit_price_cents, original_subtotal_cents, discount_cents, total_cents,
    promotion_id, promotion_snapshot
  )
  select
    v_sale_id, line.product_id, line.product_sku, line.product_name, line.quantity,
    line.unit_price_cents, line.original_subtotal_cents, line.discount_cents, line.total_cents,
    line.promotion_id, line.promotion_snapshot
  from jsonb_to_recordset(v_quote -> 'lines') as line(
    product_id uuid, product_sku text, product_name text, quantity bigint,
    unit_price_cents bigint, original_subtotal_cents bigint, discount_cents bigint,
    total_cents bigint, promotion_id uuid, promotion_snapshot jsonb
  );
  perform private.assert_sale_totals(v_sale_id);

  v_reservation := private.reserve_stock_for_sale(
    v_sale_id, p_location_id, v_items, v_actor_id, p_correlation_id
  );

  insert into public.payment_attempts (
    id, sale_id, amount_cents, operator_id, idempotency_key, correlation_id
  ) values (
    v_attempt_id, v_sale_id, (v_quote ->> 'total_cents')::bigint,
    v_actor_id, p_idempotency_key, p_correlation_id
  );
  perform private.transition_sale_state(
    v_sale_id, 'AWAITING_PAYMENT', v_actor_id, p_correlation_id, null
  );

  v_result := jsonb_build_object(
    'sale_id', v_sale_id,
    'status', 'AWAITING_PAYMENT',
    'channel', p_channel,
    'location_id', p_location_id,
    'quote', v_quote,
    'reservation', v_reservation,
    'payment_attempt', jsonb_build_object(
      'attempt_id', v_attempt_id,
      'status', 'CREATED',
      'amount_cents', (v_quote ->> 'total_cents')::bigint,
      'integration_channel', null,
      'confirmation_source', null
    ),
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale_id::text
  );
  return v_result;
end;
$$;

create or replace function public.cancel_sale(
  p_sale_id uuid,
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
  v_sale public.sales%rowtype;
  v_reservation public.stock_reservations%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_scope text;
  v_claim record;
  v_reservation_result jsonb;
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or not (
    v_sale.created_by = v_actor_id
    or (public.has_permission('sales.create') and public.has_permission('sales.read.all'))
  ) then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;
  if v_sale.status = 'CONFIRMED' then
    raise exception using errcode = 'P0001', message = 'CONFIRMED_SALE_REVERSAL_REQUIRED';
  end if;

  v_scope := private.build_idempotency_scope('sales', 'cancel', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key, jsonb_build_object('sale_id', p_sale_id)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  select * into v_reservation from public.stock_reservations
  where origin_type = 'sale' and origin_id = p_sale_id::text
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SALE_RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.status = 'ACTIVE' then
    v_reservation_result := private.finalize_stock_reservation(
      v_reservation.id, 'RELEASED', v_actor_id, p_correlation_id
    );
  else
    v_reservation_result := jsonb_build_object(
      'reservation_id', v_reservation.id,
      'status', v_reservation.status,
      'release_movement_id', v_reservation.release_movement_id
    );
  end if;

  select * into v_attempt from public.payment_attempts
  where sale_id = p_sale_id order by created_at desc, id desc limit 1 for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status <> 'CANCELLED' then
    v_attempt := private.transition_payment_attempt(
      v_attempt.id, 'CANCELLED', v_actor_id, p_correlation_id, 'Venda pendente cancelada'
    );
  end if;
  if v_sale.status <> 'CANCELLED' then
    v_sale := private.transition_sale_state(
      v_sale.id, 'CANCELLED', v_actor_id, p_correlation_id, 'Venda pendente cancelada'
    );
  end if;

  v_result := jsonb_build_object(
    'sale_id', v_sale.id,
    'status', v_sale.status,
    'reservation', v_reservation_result,
    'payment_attempt', jsonb_build_object(
      'attempt_id', v_attempt.id,
      'status', v_attempt.status
    ),
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale.id::text
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
  if v_reservation.origin_type = 'sale' then
    raise exception using errcode = 'P0001', message = 'SALE_RESERVATION_RELEASE_REQUIRES_CANCELLATION';
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

alter table public.payment_attempts enable row level security;
alter table public.payment_attempt_status_history enable row level security;
revoke all on table public.payment_attempts from public, anon, authenticated, service_role;
revoke all on table public.payment_attempt_status_history from public, anon, authenticated, service_role;
grant select on table public.payment_attempts to authenticated;
grant select on table public.payment_attempt_status_history to authenticated;

create policy payment_attempts_visible_sale_read on public.payment_attempts for select to authenticated
using (exists (select 1 from public.sales where sales.id = payment_attempts.sale_id));
create policy payment_attempt_history_visible_attempt_read
on public.payment_attempt_status_history for select to authenticated
using (exists (
  select 1 from public.payment_attempts
  where payment_attempts.id = payment_attempt_status_history.attempt_id
));

revoke all on function private.guard_payment_attempt_insert() from public, anon, authenticated, service_role;
revoke all on function private.prevent_payment_attempt_hard_delete() from public, anon, authenticated, service_role;
revoke all on function private.record_initial_payment_attempt() from public, anon, authenticated, service_role;
revoke all on function private.transition_payment_attempt(uuid, public.payment_attempt_status, uuid, uuid, text)
from public, anon, authenticated, service_role;
revoke all on function private.transition_sale_state(uuid, public.sale_status, uuid, uuid, text)
from public, anon, authenticated, service_role;
revoke all on function private.price_sale_items(public.promotion_channel, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.reserve_stock_for_sale(uuid, uuid, jsonb, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.checkout_sale(public.promotion_channel, uuid, jsonb, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.checkout_sale(public.promotion_channel, uuid, jsonb, text, uuid) to authenticated;
revoke all on function public.cancel_sale(uuid, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.cancel_sale(uuid, text, uuid) to authenticated;
revoke all on function public.release_stock_reservation(uuid, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.release_stock_reservation(uuid, text, uuid) to authenticated;

comment on table public.payment_attempts is
  'Payment attempts start provider-neutral and CREATED; channel/source are selected only by later governed flows.';
comment on table public.payment_attempt_status_history is
  'Immutable audit trail for every provider-neutral payment attempt state transition.';
comment on function public.checkout_sale(public.promotion_channel, uuid, jsonb, text, uuid) is
  'Atomically recalculates pricing, snapshots the sale, reserves stock and creates a provider-neutral payment attempt.';
comment on function public.cancel_sale(uuid, text, uuid) is
  'Idempotently cancels a pending sale, releases its stock reservation and cancels its unconfirmed payment attempt.';
comment on function public.release_stock_reservation(uuid, text, uuid) is
  'Releases standalone holds; sale-origin holds must use cancel_sale to preserve aggregate consistency.';
