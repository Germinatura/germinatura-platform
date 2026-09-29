-- Spec 4.3 / 5.10 (RES-003): pickup of a prepared reservation at the PDV. One atomic command turns the
-- READY reservation into a RESERVA-channel sale (the consumer stays the customer, the operator is created_by),
-- charges it with the frozen reservation price through the existing cash or manual confirmation and marks the
-- reservation COMPLETED. If the charge fails nothing changes and the reservation stays ready.

-- Manual and cash confirmations also accept the RESERVA sales created by the pickup command.
create or replace function public.confirm_cash_payment(
  p_sale_id uuid, p_tendered_cents bigint, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_sale public.sales%rowtype; v_attempt public.payment_attempts%rowtype;
  v_shift public.seller_shifts%rowtype; v_claim record; v_stock_result jsonb; v_ledger_id uuid;
  v_change bigint; v_confirmed_at timestamptz := clock_timestamp(); v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if p_correlation_id is null or p_tendered_cents is null or p_tendered_cents not between 0 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'INVALID_CASH_PAYMENT';
  end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.created_by <> v_actor_id or v_sale.channel not in ('PDV', 'RESERVA') then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'cash_confirmation', v_actor_id), p_idempotency_key,
    jsonb_build_object('sale_id', p_sale_id, 'tendered_cents', p_tendered_cents));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  if v_sale.status <> 'AWAITING_PAYMENT' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_AWAITING_PAYMENT';
  end if;
  select * into v_shift from public.seller_shifts
  where seller_id = v_actor_id and status = 'OPEN' for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_REQUIRED';
  end if;
  if v_shift.location_id <> v_sale.location_id then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_LOCATION_MISMATCH';
  end if;
  if p_tendered_cents < v_sale.total_cents then
    raise exception using errcode = 'P0001', message = 'CASH_TENDERED_INSUFFICIENT';
  end if;
  v_change := p_tendered_cents - v_sale.total_cents;
  select * into v_attempt from public.payment_attempts
  where sale_id = p_sale_id order by created_at desc, id desc limit 1 for update;
  if not found or v_attempt.operator_id <> v_actor_id then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status <> 'CREATED' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_CONFIRMABLE';
  end if;
  if v_attempt.amount_cents <> v_sale.total_cents then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AMOUNT_MISMATCH';
  end if;

  v_stock_result := private.consume_sale_reservation(v_sale.id, v_actor_id, p_correlation_id);
  update public.payment_attempts
  set status = 'APPROVED', integration_channel = 'DINHEIRO', confirmation_source = 'MANUAL', confirmed_at = v_confirmed_at
  where id = v_attempt.id returning * into v_attempt;
  insert into public.payment_attempt_status_history (attempt_id, from_status, to_status, actor_id, reason, correlation_id)
  values (v_attempt.id, 'CREATED', 'APPROVED', v_actor_id, 'Recebimento em dinheiro registrado no turno', p_correlation_id);
  insert into public.financial_ledger_entries (
    sale_id, payment_attempt_id, entry_type, amount_cents, actor_id, correlation_id, metadata
  ) values (
    v_sale.id, v_attempt.id, 'CASH_RECEIPT', v_sale.total_cents, v_actor_id, p_correlation_id,
    jsonb_build_object('integration_channel', 'DINHEIRO', 'confirmation_source', 'MANUAL', 'shift_id', v_shift.id)
  ) returning id into v_ledger_id;
  insert into public.cash_movements (
    shift_id, movement_type, amount_cents, sale_id, payment_attempt_id, tendered_cents, change_cents, actor_id, correlation_id
  ) values (
    v_shift.id, 'SALE_RECEIPT', v_sale.total_cents, v_sale.id, v_attempt.id, p_tendered_cents, v_change, v_actor_id, p_correlation_id
  );
  v_sale := private.transition_sale_state(v_sale.id, 'CONFIRMED', v_actor_id, p_correlation_id, 'Pagamento em dinheiro recebido');

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.cash.confirmed', v_actor_id, 'payment_attempt', v_attempt.id::text, p_correlation_id,
    jsonb_build_object('sale_id', v_sale.id, 'amount_cents', v_attempt.amount_cents, 'tendered_cents', p_tendered_cents,
      'change_cents', v_change, 'shift_id', v_shift.id, 'financial_ledger_entry_id', v_ledger_id));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('payments.cash.confirmed', 'payment_attempt', v_attempt.id::text,
    jsonb_build_object('attempt_id', v_attempt.id, 'sale_id', v_sale.id, 'shift_id', v_shift.id, 'correlation_id', p_correlation_id));

  v_result := jsonb_build_object(
    'sale_id', v_sale.id, 'sale_status', v_sale.status,
    'payment_attempt', jsonb_build_object('attempt_id', v_attempt.id, 'status', v_attempt.status,
      'amount_cents', v_attempt.amount_cents, 'integration_channel', v_attempt.integration_channel,
      'confirmation_source', v_attempt.confirmation_source, 'confirmed_at', v_attempt.confirmed_at),
    'cash', jsonb_build_object('shift_id', v_shift.id, 'tendered_cents', p_tendered_cents, 'change_cents', v_change),
    'stock', v_stock_result, 'financial_ledger_entry_id', v_ledger_id, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale.id::text);
  return v_result;
end;
$$;

create or replace function public.confirm_manual_payment(
  p_sale_id uuid,
  p_integration_channel public.payment_integration_channel,
  p_proof_reference text,
  p_card_method public.card_payment_method,
  p_terminal_id uuid,
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
  v_attempt public.payment_attempts%rowtype;
  v_scope text;
  v_claim record;
  v_stock_result jsonb;
  v_ledger_id uuid;
  v_confirmed_at timestamptz := clock_timestamp();
  v_result jsonb;
  v_terminal public.payment_terminals%rowtype;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if p_integration_channel not in ('MAQUININHA', 'PIX_AREA') then
    raise exception using errcode = '22023', message = 'MANUAL_PAYMENT_CHANNEL_UNSUPPORTED';
  end if;
  if p_proof_reference is null
    or char_length(p_proof_reference) not between 4 and 128
    or p_proof_reference <> btrim(p_proof_reference)
    or p_proof_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$'
    or p_proof_reference ~ '[0-9]{12,}' then
    raise exception using errcode = '22023', message = 'INVALID_NON_SENSITIVE_PROOF_REFERENCE';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;
  -- Spec 6.7: the Maquininha records its card method; Área Pix has neither method nor terminal.
  if p_integration_channel = 'MAQUININHA' and p_card_method is null then
    raise exception using errcode = '22023', message = 'CARD_METHOD_REQUIRED';
  end if;
  if p_integration_channel = 'PIX_AREA' and (p_card_method is not null or p_terminal_id is not null) then
    raise exception using errcode = '22023', message = 'CARD_DETAILS_NOT_ALLOWED';
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.created_by <> v_actor_id or v_sale.channel not in ('PDV', 'RESERVA') then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;

  v_scope := private.build_idempotency_scope('payments', 'manual_confirmation', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object(
      'sale_id', p_sale_id,
      'integration_channel', p_integration_channel,
      'proof_reference', p_proof_reference
    ) || jsonb_strip_nulls(jsonb_build_object('card_method', p_card_method, 'terminal_id', p_terminal_id))
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  if v_sale.status <> 'AWAITING_PAYMENT' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_AWAITING_PAYMENT';
  end if;
  if p_card_method in ('VOUCHER_ALIMENTACAO', 'VOUCHER_REFEICAO') then
    perform private.require_feature('meal_voucher');
  end if;
  if p_terminal_id is not null then
    select * into v_terminal from public.payment_terminals where id = p_terminal_id for share;
    if not found or not v_terminal.active then
      raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_UNAVAILABLE';
    end if;
  elsif p_integration_channel = 'MAQUININHA' and exists (select 1 from public.payment_terminals where active) then
    -- Once the establishment registers its terminals, every Maquininha payment names one.
    raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_REQUIRED';
  end if;
  select * into v_attempt
  from public.payment_attempts
  where sale_id = p_sale_id
  order by created_at desc, id desc limit 1
  for update;
  if not found or v_attempt.operator_id <> v_actor_id then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status <> 'CREATED' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_CONFIRMABLE';
  end if;
  if v_attempt.amount_cents <> v_sale.total_cents then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AMOUNT_MISMATCH';
  end if;

  v_stock_result := private.consume_sale_reservation(
    v_sale.id, v_actor_id, p_correlation_id
  );

  update public.payment_attempts
  set status = 'AWAITING_EXTERNAL_CONFIRMATION',
      integration_channel = p_integration_channel,
      confirmation_source = 'MANUAL',
      proof_reference = p_proof_reference,
      card_method = p_card_method,
      terminal_id = p_terminal_id
  where id = v_attempt.id;
  insert into public.payment_attempt_status_history (
    attempt_id, from_status, to_status, actor_id, reason, correlation_id
  ) values (
    v_attempt.id, 'CREATED', 'AWAITING_EXTERNAL_CONFIRMATION', v_actor_id,
    'Operador registrou confirmação externa manual', p_correlation_id
  );

  update public.payment_attempts
  set status = 'APPROVED', confirmed_at = v_confirmed_at
  where id = v_attempt.id
  returning * into v_attempt;
  insert into public.payment_attempt_status_history (
    attempt_id, from_status, to_status, actor_id, reason, correlation_id
  ) values (
    v_attempt.id, 'AWAITING_EXTERNAL_CONFIRMATION', 'APPROVED', v_actor_id,
    'Confirmação manual concluída', p_correlation_id
  );

  insert into public.financial_ledger_entries (
    sale_id, payment_attempt_id, entry_type, amount_cents,
    actor_id, correlation_id,
    metadata
  ) values (
    v_sale.id, v_attempt.id, 'RECEIVABLE_PICPAY', v_sale.total_cents,
    v_actor_id, p_correlation_id,
    jsonb_build_object(
      'integration_channel', p_integration_channel,
      'confirmation_source', 'MANUAL'
    ) || jsonb_strip_nulls(jsonb_build_object('card_method', p_card_method, 'terminal_id', p_terminal_id))
  ) returning id into v_ledger_id;

  v_sale := private.transition_sale_state(
    v_sale.id, 'CONFIRMED', v_actor_id, p_correlation_id,
    'Pagamento manual externo confirmado'
  );

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'payments.manual.confirmed', v_actor_id, 'payment_attempt', v_attempt.id::text,
    p_correlation_id,
    jsonb_build_object(
      'sale_id', v_sale.id,
      'amount_cents', v_attempt.amount_cents,
      'integration_channel', p_integration_channel,
      'confirmation_source', 'MANUAL',
      'card_method', p_card_method,
      'terminal_id', p_terminal_id,
      'financial_ledger_entry_id', v_ledger_id
    )
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'payments.manual.confirmed', 'payment_attempt', v_attempt.id::text,
    jsonb_build_object(
      'attempt_id', v_attempt.id,
      'sale_id', v_sale.id,
      'status', v_attempt.status,
      'integration_channel', p_integration_channel,
      'confirmation_source', 'MANUAL',
      'correlation_id', p_correlation_id
    )
  );

  v_result := jsonb_build_object(
    'sale_id', v_sale.id,
    'sale_status', v_sale.status,
    'payment_attempt', jsonb_build_object(
      'attempt_id', v_attempt.id,
      'status', v_attempt.status,
      'amount_cents', v_attempt.amount_cents,
      'integration_channel', v_attempt.integration_channel,
      'confirmation_source', v_attempt.confirmation_source,
      'confirmed_at', v_attempt.confirmed_at,
      'proof_reference', v_attempt.proof_reference,
      'card_method', v_attempt.card_method,
      'terminal', case when v_terminal.id is null then null
        else jsonb_build_object('id', v_terminal.id, 'code', v_terminal.code, 'label', v_terminal.label) end
    ),
    'stock', v_stock_result,
    'financial_ledger_entry_id', v_ledger_id,
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale.id::text
  );
  return v_result;
exception
  when unique_violation then
    if sqlerrm like '%payment_attempts_manual_proof_unique%' then
      raise exception using errcode = 'P0001', message = 'PROOF_REFERENCE_ALREADY_USED';
    end if;
    raise;
end;
$$;

-- The operator may hand over reservations held at a location it operates (same rule as opening a shift).
create function private.can_operate_location(p_actor_id uuid, p_location_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.stock_locations location
    where location.id = p_location_id and location.active
      and (public.has_permission('inventory.manage')
        or (location.location_type = 'SELLER' and location.seller_id = p_actor_id))
  );
$$;

-- Prepared reservations waiting for pickup at the operator's locations, searchable by customer.
create function public.list_pickup_reservations(p_query text default null, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_query text := nullif(btrim(p_query), '');
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if (v_query is not null and char_length(v_query) > 80) or p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_FILTER';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'reservation_id', page.id, 'customer_name', page.customer_name, 'location_id', page.location_id,
        'location_name', page.location_name, 'total_cents', page.total_cents, 'discount_total_cents', page.discount_total_cents,
        'ready_at', page.ready_at, 'pickup_deadline', page.pickup_deadline, 'pickup_instructions', page.pickup_instructions,
        'items', (select jsonb_agg(jsonb_build_object('product_name', line ->> 'product_name',
            'quantity', (line ->> 'quantity')::bigint, 'total_cents', (line ->> 'total_cents')::bigint))
          from jsonb_array_elements(page.quote_snapshot -> 'lines') line))
      order by page.pickup_deadline, page.id)
    from (
      select reservation.*, coalesce(nullif(btrim(customer.display_name), ''), customer.email) as customer_name,
        location.name as location_name
      from public.commercial_reservations reservation
      join public.profiles customer on customer.id = reservation.customer_id
      join public.stock_locations location on location.id = reservation.location_id
      where reservation.status = 'READY' and reservation.pickup_deadline > clock_timestamp()
        and private.can_operate_location(v_actor_id, reservation.location_id)
        and (v_query is null or customer.display_name ilike '%' || v_query || '%' or customer.email ilike '%' || v_query || '%')
      order by reservation.pickup_deadline, reservation.id
      limit p_limit
    ) page
  ), '[]'::jsonb);
end;
$$;

-- Atomic pickup: RESERVA sale at the frozen price, paid through the existing confirmation, reservation COMPLETED.
create function public.complete_reservation_pickup(
  p_reservation_id uuid,
  p_integration_channel public.payment_integration_channel,
  p_tendered_cents bigint,
  p_proof_reference text,
  p_card_method public.card_payment_method,
  p_terminal_id uuid,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_reservation public.commercial_reservations%rowtype;
  v_claim record;
  v_sale_id uuid := gen_random_uuid();
  v_attempt_id uuid := gen_random_uuid();
  v_payment jsonb;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if p_correlation_id is null or p_integration_channel is null
    or p_integration_channel not in ('DINHEIRO', 'MAQUININHA', 'PIX_AREA')
    or (p_integration_channel = 'DINHEIRO' and p_tendered_cents is null)
    or (p_integration_channel <> 'DINHEIRO' and p_tendered_cents is not null)
    or p_idempotency_key is null or char_length(p_idempotency_key) > 100 then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_PAYMENT';
  end if;
  select * into v_reservation from public.commercial_reservations where id = p_reservation_id for update;
  if not found or not private.can_operate_location(v_actor_id, v_reservation.location_id) then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('reservations', 'pickup', v_actor_id), p_idempotency_key,
    jsonb_build_object('reservation_id', p_reservation_id, 'integration_channel', p_integration_channel,
      'tendered_cents', p_tendered_cents, 'proof_reference', p_proof_reference, 'card_method', p_card_method,
      'terminal_id', p_terminal_id));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if v_reservation.status <> 'READY' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_READY';
  end if;
  if v_reservation.pickup_deadline <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_EXPIRED';
  end if;

  -- The sale reuses the frozen reservation snapshot: no repricing at pickup.
  insert into public.sales (
    id, channel, location_id, created_by, customer_id,
    original_total_cents, discount_total_cents, total_cents, quoted_at, correlation_id
  ) values (
    v_sale_id, 'RESERVA', v_reservation.location_id, v_actor_id, v_reservation.customer_id,
    v_reservation.original_total_cents, v_reservation.discount_total_cents, v_reservation.total_cents,
    (v_reservation.quote_snapshot ->> 'quoted_at')::timestamptz, p_correlation_id
  );
  insert into public.sale_items (
    sale_id, product_id, product_sku, product_name, quantity,
    unit_price_cents, original_subtotal_cents, discount_cents, total_cents, promotion_id, promotion_snapshot
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
  -- The held stock now belongs to the sale and is consumed by the confirmation right below.
  update public.stock_reservations
  set origin_type = 'sale', origin_id = v_sale_id::text, expires_at = greatest(expires_at, clock_timestamp() + interval '5 minutes')
  where id = v_reservation.stock_reservation_id and status = 'ACTIVE';
  if not found then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_STOCK_NOT_ACTIVE';
  end if;
  insert into public.payment_attempts (id, sale_id, amount_cents, operator_id, idempotency_key, correlation_id)
  values (v_attempt_id, v_sale_id, v_reservation.total_cents, v_actor_id, p_idempotency_key, p_correlation_id);
  perform private.transition_sale_state(v_sale_id, 'AWAITING_PAYMENT', v_actor_id, p_correlation_id, 'Retirada de reserva');

  if p_integration_channel = 'DINHEIRO' then
    v_payment := public.confirm_cash_payment(v_sale_id, p_tendered_cents, p_idempotency_key || ':pay', p_correlation_id);
  else
    v_payment := public.confirm_manual_payment(v_sale_id, p_integration_channel, p_proof_reference, p_card_method,
      p_terminal_id, p_idempotency_key || ':pay', p_correlation_id);
  end if;

  update public.commercial_reservations
  set status = 'COMPLETED', converted_sale_id = v_sale_id, converted_at = clock_timestamp(), completed_at = clock_timestamp()
  where id = v_reservation.id;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('reservations.completed', v_actor_id, 'commercial_reservation', v_reservation.id::text, p_correlation_id,
    jsonb_build_object('sale_id', v_sale_id, 'customer_id', v_reservation.customer_id,
      'total_cents', v_reservation.total_cents, 'integration_channel', p_integration_channel));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('reservations.completed', 'commercial_reservation', v_reservation.id::text,
    jsonb_build_object('reservation_id', v_reservation.id, 'customer_id', v_reservation.customer_id,
      'sale_id', v_sale_id, 'correlation_id', p_correlation_id));

  v_result := jsonb_build_object(
    'reservation_id', v_reservation.id, 'status', 'COMPLETED', 'sale_id', v_sale_id,
    'total_cents', v_reservation.total_cents, 'integration_channel', p_integration_channel,
    'change_cents', v_payment -> 'cash' -> 'change_cents',
    'card_method', v_payment -> 'payment_attempt' -> 'card_method',
    'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation.id::text);
  return v_result;
end;
$$;

revoke all on function private.can_operate_location(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_pickup_reservations(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.complete_reservation_pickup(uuid, public.payment_integration_channel, bigint, text, public.card_payment_method, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_pickup_reservations(text, integer) to authenticated;
grant execute on function public.complete_reservation_pickup(uuid, public.payment_integration_channel, bigint, text, public.card_payment_method, uuid, text, uuid)
  to authenticated;

comment on function public.complete_reservation_pickup(uuid, public.payment_integration_channel, bigint, text, public.card_payment_method, uuid, text, uuid) is
  'Atomic pickup of a READY reservation: RESERVA sale at the frozen price, paid in cash or by manual confirmation, reservation COMPLETED.';

-- "Minhas vendas" also lists the reservation pickups the operator handed over.
create or replace function public.list_my_sales(p_filter text default null, p_cursor uuid default null, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_cursor public.sales%rowtype;
  v_rows jsonb;
  v_count integer;
begin
  if v_actor_id is null or not public.has_permission('sales.read.own') or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if (p_filter is not null and p_filter not in ('PENDING', 'CONFIRMED', 'CANCELLED'))
    or p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_SALES_FILTER';
  end if;
  if p_cursor is not null then
    select * into v_cursor from public.sales where id = p_cursor and created_by = v_actor_id;
    if not found then
      raise exception using errcode = '22023', message = 'INVALID_SALES_CURSOR';
    end if;
  end if;

  with page as (
    select sale.*, attempt.id as attempt_id, attempt.status as attempt_status,
      attempt.integration_channel, attempt.confirmation_source, attempt.confirmed_at,
      attempt.card_method, terminal.code as terminal_code,
      reservation.expires_at as reservation_expires_at,
      case
        when sale.status = 'AWAITING_PAYMENT' then 'AWAITING_PAYMENT'
        when attempt.status = 'RECONCILIATION_PENDING' then 'RECONCILIATION_PENDING'
      end as pending_reason
    from public.sales sale
    left join lateral (
      select * from public.payment_attempts candidate where candidate.sale_id = sale.id
      order by candidate.created_at desc, candidate.id desc limit 1
    ) attempt on true
    left join public.payment_terminals terminal on terminal.id = attempt.terminal_id
    left join public.stock_reservations reservation
      on reservation.origin_type = 'sale' and reservation.origin_id = sale.id::text and reservation.status = 'ACTIVE'
    where sale.created_by = v_actor_id and sale.channel in ('PDV', 'RESERVA') and sale.status <> 'DRAFT'
      and (p_cursor is null or (sale.created_at, sale.id) < (v_cursor.created_at, v_cursor.id))
      and (p_filter is null
        or (p_filter = 'PENDING' and (sale.status = 'AWAITING_PAYMENT' or attempt.status = 'RECONCILIATION_PENDING'))
        or (p_filter = 'CONFIRMED' and sale.status = 'CONFIRMED')
        or (p_filter = 'CANCELLED' and sale.status = 'CANCELLED'))
    order by sale.created_at desc, sale.id desc
    limit p_limit + 1
  )
  select jsonb_agg(jsonb_build_object(
      'sale_id', page.id, 'status', page.status, 'channel', page.channel, 'created_at', page.created_at, 'location_id', page.location_id,
      'original_total_cents', page.original_total_cents, 'discount_total_cents', page.discount_total_cents,
      'total_cents', page.total_cents, 'pending_reason', page.pending_reason,
      'reservation_expires_at', page.reservation_expires_at,
      'payment', case when page.attempt_id is null then null else jsonb_build_object(
        'attempt_id', page.attempt_id, 'status', page.attempt_status, 'integration_channel', page.integration_channel,
        'confirmation_source', page.confirmation_source, 'confirmed_at', page.confirmed_at,
        'card_method', page.card_method, 'terminal_code', page.terminal_code) end,
      'items', (select jsonb_agg(jsonb_build_object('product_name', item.product_name, 'quantity', item.quantity,
          'total_cents', item.total_cents) order by item.product_name, item.id)
        from public.sale_items item where item.sale_id = page.id)
    ) order by page.created_at desc, page.id desc), count(*)
  into v_rows, v_count
  from page;

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(value order by ordinality) from jsonb_array_elements(coalesce(v_rows, '[]'::jsonb)) with ordinality
      where ordinality <= p_limit), '[]'::jsonb),
    'next_cursor', case when v_count > p_limit then (v_rows -> (p_limit - 1)) ->> 'sale_id' end,
    'pending_count', (select count(*) from public.sales sale
      where sale.created_by = v_actor_id and sale.channel in ('PDV', 'RESERVA')
        and (sale.status = 'AWAITING_PAYMENT' or exists (
          select 1 from public.payment_attempts attempt
          where attempt.sale_id = sale.id and attempt.status = 'RECONCILIATION_PENDING'))));
end;
$$;
