create unique index financial_ledger_refund_attempt_unique
  on public.financial_ledger_entries (payment_attempt_id)
  where entry_type = 'REFUND';

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
  v_from_status public.payment_attempt_status;
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
  if not (
    (v_attempt.status = 'CREATED' and p_target_status = 'CANCELLED')
    or (v_attempt.status = 'APPROVED' and p_target_status in ('REFUNDED', 'RECONCILIATION_PENDING', 'RECONCILED'))
    or (v_attempt.status = 'RECONCILIATION_PENDING' and p_target_status in ('REFUNDED', 'RECONCILED'))
    or (v_attempt.status = 'RECONCILED' and p_target_status = 'REFUNDED')
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_PAYMENT_TRANSITION';
  end if;

  v_from_status := v_attempt.status;
  update public.payment_attempts set status = p_target_status where id = v_attempt.id
  returning * into v_attempt;
  insert into public.payment_attempt_status_history (
    attempt_id, from_status, to_status, actor_id, reason, correlation_id
  ) values (
    v_attempt.id, v_from_status, p_target_status, p_actor_id, p_reason, p_correlation_id
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

create or replace function public.reverse_confirmed_sale(
  p_sale_id uuid,
  p_reason text,
  p_refund_reference text,
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
  v_sale_movement public.stock_movements%rowtype;
  v_reversal_movement_id uuid;
  v_refund_entry_id uuid;
  v_recorded_refund_reference text;
  v_scope text;
  v_claim record;
  v_items jsonb;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_reason is null or char_length(p_reason) not between 8 and 500 or p_reason <> btrim(p_reason) then
    raise exception using errcode = '22023', message = 'INVALID_REVERSAL_REASON';
  end if;
  if p_refund_reference is null
    or char_length(p_refund_reference) not between 4 and 128
    or p_refund_reference <> btrim(p_refund_reference)
    or p_refund_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$'
    or p_refund_reference ~ '[0-9]{12,}' then
    raise exception using errcode = '22023', message = 'INVALID_REFUND_REFERENCE';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;

  v_scope := private.build_idempotency_scope('sales', 'reverse_confirmed', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object(
      'sale_id', p_sale_id,
      'reason', p_reason,
      'refund_reference', p_refund_reference
    )
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  select * into v_attempt from public.payment_attempts
  where sale_id = p_sale_id order by created_at desc, id desc limit 1 for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;

  if v_sale.status = 'CANCELLED' then
    select id, metadata ->> 'refund_reference' into v_refund_entry_id, v_recorded_refund_reference
    from public.financial_ledger_entries
    where payment_attempt_id = v_attempt.id and entry_type = 'REFUND';
    select id into v_reversal_movement_id from public.stock_movements movement
    where movement.source_type = 'sale_reversal' and movement.source_id = p_sale_id::text;
    if v_refund_entry_id is null or v_reversal_movement_id is null or v_attempt.status <> 'REFUNDED' then
      raise exception using errcode = 'P0001', message = 'SALE_NOT_REVERSIBLE';
    end if;
    v_result := jsonb_build_object(
      'sale_id', v_sale.id,
      'status', v_sale.status,
      'payment_attempt', jsonb_build_object('attempt_id', v_attempt.id, 'status', v_attempt.status),
      'reversal', jsonb_build_object(
        'stock_movement_id', v_reversal_movement_id,
        'refund_entry_id', v_refund_entry_id,
        'amount_cents', v_attempt.amount_cents,
        'refund_reference', v_recorded_refund_reference
      ),
      'correlation_id', p_correlation_id
    );
    perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale.id::text);
    return v_result;
  end if;

  if v_sale.status <> 'CONFIRMED' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_CONFIRMED';
  end if;
  if exists (select 1 from public.raffle_numbers where sale_id = p_sale_id and status = 'PAID') then
    raise exception using errcode = 'P0001', message = 'PAID_RAFFLE_REVERSAL_REQUIRED';
  end if;
  if v_attempt.status not in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED') then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_REFUNDABLE';
  end if;

  select * into v_sale_movement from public.stock_movements
  where source_type = 'sale' and source_id = p_sale_id::text and movement_type = 'VENDA'
  order by created_at, id limit 1 for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SALE_MOVEMENT_NOT_FOUND';
  end if;
  if exists (select 1 from public.stock_movements where reversal_of = v_sale_movement.id) then
    raise exception using errcode = 'P0001', message = 'SALE_MOVEMENT_ALREADY_REVERSED';
  end if;

  select jsonb_agg(
    jsonb_build_object('product_id', item.product_id, 'quantity', item.quantity)
    order by item.product_id
  ) into v_items
  from public.stock_movement_items item where item.movement_id = v_sale_movement.id;
  if v_items is null then
    raise exception using errcode = 'P0001', message = 'SALE_MOVEMENT_ITEMS_NOT_FOUND';
  end if;

  perform balance.id
  from public.inventory_balances balance
  join public.stock_movement_items item on item.product_id = balance.product_id
  where item.movement_id = v_sale_movement.id and balance.location_id = v_sale.location_id
  order by balance.product_id
  for update of balance;
  if exists (
    select 1 from public.stock_movement_items item
    left join public.inventory_balances balance
      on balance.location_id = v_sale.location_id and balance.product_id = item.product_id
    where item.movement_id = v_sale_movement.id
      and (balance.id is null or balance.on_hand_quantity + item.quantity > 9007199254740991)
  ) then
    raise exception using errcode = 'P0001', message = 'STOCK_REVERSAL_CONFLICT';
  end if;

  update public.inventory_balances balance
  set on_hand_quantity = balance.on_hand_quantity + item.quantity
  from public.stock_movement_items item
  where item.movement_id = v_sale_movement.id
    and balance.location_id = v_sale.location_id
    and balance.product_id = item.product_id;

  insert into public.stock_movements (
    movement_type, to_location_id, actor_id, reason, correlation_id,
    source_type, source_id, reversal_of
  ) values (
    'CANCELAMENTO_VENDA', v_sale.location_id, v_actor_id, p_reason, p_correlation_id,
    'sale_reversal', p_sale_id::text, v_sale_movement.id
  ) returning id into v_reversal_movement_id;
  insert into public.stock_movement_items (movement_id, product_id, quantity)
  select v_reversal_movement_id, product_id, quantity
  from public.stock_movement_items where movement_id = v_sale_movement.id;

  insert into public.financial_ledger_entries (
    sale_id, payment_attempt_id, entry_type, amount_cents,
    actor_id, correlation_id, metadata
  ) values (
    v_sale.id, v_attempt.id, 'REFUND', -v_attempt.amount_cents,
    v_actor_id, p_correlation_id,
    jsonb_build_object('refund_reference', p_refund_reference, 'reason', p_reason, 'source', 'MANUAL')
  ) returning id into v_refund_entry_id;

  v_attempt := private.transition_payment_attempt(
    v_attempt.id, 'REFUNDED', v_actor_id, p_correlation_id,
    p_reason
  );
  update public.sales set status = 'CANCELLED' where id = v_sale.id
  returning * into v_sale;
  insert into public.sale_status_history (
    sale_id, from_status, to_status, actor_id, reason, correlation_id
  ) values (
    v_sale.id, 'CONFIRMED', 'CANCELLED', v_actor_id, p_reason, p_correlation_id
  );
  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'sales.status.changed', v_actor_id, 'sale', v_sale.id::text, p_correlation_id,
    jsonb_build_object('status', 'CANCELLED', 'reason', p_reason, 'reversal', true)
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'sales.status.changed', 'sale', v_sale.id::text,
    jsonb_build_object(
      'sale_id', v_sale.id,
      'status', 'CANCELLED',
      'correlation_id', p_correlation_id,
      'reversal', true
    )
  );

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'sales.confirmed.reversed', v_actor_id, 'sale', v_sale.id::text, p_correlation_id,
    jsonb_build_object(
      'payment_attempt_id', v_attempt.id,
      'stock_movement_id', v_reversal_movement_id,
      'refund_entry_id', v_refund_entry_id,
      'amount_cents', v_attempt.amount_cents,
      'refund_reference', p_refund_reference,
      'reason', p_reason,
      'items', v_items
    )
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'sales.confirmed.reversed', 'sale', v_sale.id::text,
    jsonb_build_object(
      'sale_id', v_sale.id,
      'payment_attempt_id', v_attempt.id,
      'stock_movement_id', v_reversal_movement_id,
      'refund_entry_id', v_refund_entry_id,
      'status', v_sale.status,
      'correlation_id', p_correlation_id
    )
  );

  v_result := jsonb_build_object(
    'sale_id', v_sale.id,
    'status', v_sale.status,
    'payment_attempt', jsonb_build_object('attempt_id', v_attempt.id, 'status', v_attempt.status),
    'reversal', jsonb_build_object(
      'stock_movement_id', v_reversal_movement_id,
      'refund_entry_id', v_refund_entry_id,
      'amount_cents', v_attempt.amount_cents,
      'refund_reference', p_refund_reference
    ),
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale.id::text
  );
  return v_result;
end;
$$;

revoke all on function public.reverse_confirmed_sale(uuid, text, text, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.reverse_confirmed_sale(uuid, text, text, text, uuid)
to authenticated;

comment on function public.reverse_confirmed_sale(uuid, text, text, text, uuid) is
  'Finance-only idempotent manual reversal of a confirmed sale, its stock movement and PicPay receivable.';
