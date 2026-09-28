-- PAY-009a: a confirmed refund of a cash sale that hands physical cash back from a drawer is a new,
-- immutable negative drawer movement (REFUND_PAYOUT) linked to the sale and its REFUND ledger entry.
-- The original SALE_RECEIPT is never changed; expected cash = float + receipts - physical refunds.
-- Refunds by any other means leave the drawer untouched, and a closed shift is never recalculated:
-- the payout belongs to the open shift where the cash actually left the drawer.

alter table public.cash_movements drop constraint cash_movements_amount_cents_check;
alter table public.cash_movements drop constraint cash_movements_payment_attempt_id_key;
alter table public.cash_movements drop constraint cash_movements_shape_valid;
alter table public.cash_movements
  add column refund_entry_id uuid unique references public.financial_ledger_entries(id) on delete restrict;

alter table public.cash_movements add constraint cash_movements_amount_sign_valid check (
  (movement_type = 'REFUND_PAYOUT' and amount_cents between -9007199254740991 and -1)
  or (movement_type <> 'REFUND_PAYOUT' and amount_cents between 0 and 9007199254740991)
);
alter table public.cash_movements add constraint cash_movements_shape_valid check (
  (movement_type = 'OPENING_FLOAT' and sale_id is null and payment_attempt_id is null
    and tendered_cents is null and change_cents is null and refund_entry_id is null)
  or (movement_type = 'SALE_RECEIPT' and sale_id is not null and payment_attempt_id is not null
    and tendered_cents is not null and change_cents is not null and refund_entry_id is null
    and tendered_cents = amount_cents + change_cents)
  or (movement_type = 'REFUND_PAYOUT' and sale_id is not null and payment_attempt_id is not null
    and refund_entry_id is not null and tendered_cents is null and change_cents is null)
);
-- One receipt and at most one physical refund per payment attempt.
create unique index cash_movements_sale_receipt_attempt_unique
  on public.cash_movements (payment_attempt_id) where movement_type = 'SALE_RECEIPT';
create unique index cash_movements_refund_payout_attempt_unique
  on public.cash_movements (payment_attempt_id) where movement_type = 'REFUND_PAYOUT';

-- Defense in depth: nothing enters the drawer ledger of a closed shift.
create function private.guard_cash_movement_shift_open()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.seller_shifts where id = new.shift_id and status = 'OPEN') then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_NOT_OPEN';
  end if;
  return new;
end;
$$;
create trigger cash_movements_shift_open before insert on public.cash_movements
for each row execute function private.guard_cash_movement_shift_open();
revoke all on function private.guard_cash_movement_shift_open() from public, anon, authenticated, service_role;

create or replace function private.seller_shift_summary(p_shift_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'shift_id', shift.id, 'status', shift.status, 'location_id', shift.location_id,
    'opened_at', shift.opened_at, 'closed_at', shift.closed_at,
    'opening_cash_cents', shift.opening_cash_cents,
    'cash_sales_count', (select count(*) from public.cash_movements movement
      where movement.shift_id = shift.id and movement.movement_type = 'SALE_RECEIPT'),
    'cash_sales_total_cents', (select coalesce(sum(movement.amount_cents), 0) from public.cash_movements movement
      where movement.shift_id = shift.id and movement.movement_type = 'SALE_RECEIPT'),
    'cash_refunds_count', (select count(*) from public.cash_movements movement
      where movement.shift_id = shift.id and movement.movement_type = 'REFUND_PAYOUT'),
    'cash_refunds_total_cents', (select coalesce(-sum(movement.amount_cents), 0) from public.cash_movements movement
      where movement.shift_id = shift.id and movement.movement_type = 'REFUND_PAYOUT'),
    'expected_cash_cents', coalesce(shift.expected_cash_cents, (select coalesce(sum(movement.amount_cents), 0)
      from public.cash_movements movement where movement.shift_id = shift.id)),
    'counted_cash_cents', shift.counted_cash_cents, 'difference_cents', shift.difference_cents,
    'justification', shift.justification
  ) from public.seller_shifts shift where shift.id = p_shift_id;
$$;

-- Finance-only reversal of a confirmed sale. p_cash_payout_shift_id is the open shift whose drawer
-- physically hands the cash back; null means the refund happened by another means (drawer untouched).
create function public.reverse_confirmed_sale(
  p_sale_id uuid,
  p_reason text,
  p_refund_reference text,
  p_cash_payout_shift_id uuid,
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
  v_shift public.seller_shifts%rowtype;
  v_sale_movement public.stock_movements%rowtype;
  v_reversal_movement_id uuid;
  v_refund_entry_id uuid;
  v_recorded_refund_reference text;
  v_payout public.cash_movements%rowtype;
  v_drawer_cents bigint;
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
  -- The payout shift joins the fingerprint only when present, so earlier keys keep replaying.
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object(
      'sale_id', p_sale_id,
      'reason', p_reason,
      'refund_reference', p_refund_reference
    ) || case when p_cash_payout_shift_id is null then '{}'::jsonb
      else jsonb_build_object('cash_payout_shift_id', p_cash_payout_shift_id) end
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
    select * into v_payout from public.cash_movements
    where payment_attempt_id = v_attempt.id and movement_type = 'REFUND_PAYOUT';
    -- A new key cannot move cash for a sale already reversed without it (or from another drawer).
    if p_cash_payout_shift_id is not null and v_payout.shift_id is distinct from p_cash_payout_shift_id then
      raise exception using errcode = 'P0001', message = 'SALE_ALREADY_REVERSED';
    end if;
    v_result := jsonb_build_object(
      'sale_id', v_sale.id,
      'status', v_sale.status,
      'payment_attempt', jsonb_build_object('attempt_id', v_attempt.id, 'status', v_attempt.status),
      'reversal', jsonb_build_object(
        'stock_movement_id', v_reversal_movement_id,
        'refund_entry_id', v_refund_entry_id,
        'amount_cents', v_attempt.amount_cents,
        'refund_reference', v_recorded_refund_reference,
        'cash_payout', case when v_payout.id is null then null else jsonb_build_object(
          'movement_id', v_payout.id, 'shift_id', v_payout.shift_id, 'amount_cents', -v_payout.amount_cents) end
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

  if p_cash_payout_shift_id is not null then
    if v_attempt.integration_channel is distinct from 'DINHEIRO' then
      raise exception using errcode = 'P0001', message = 'CASH_PAYOUT_NOT_CASH_SALE';
    end if;
    -- Same lock as cash receipts and the shift close, so a closing count never misses the payout.
    select * into v_shift from public.seller_shifts where id = p_cash_payout_shift_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_NOT_FOUND';
    end if;
    if v_shift.status <> 'OPEN' then
      raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_NOT_OPEN';
    end if;
    select coalesce(sum(amount_cents), 0) into v_drawer_cents from public.cash_movements where shift_id = v_shift.id;
    if v_drawer_cents < v_attempt.amount_cents then
      raise exception using errcode = 'P0001', message = 'CASH_DRAWER_INSUFFICIENT';
    end if;
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
    jsonb_build_object('refund_reference', p_refund_reference, 'reason', p_reason, 'source', 'MANUAL',
      'refund_method', case when p_cash_payout_shift_id is null then 'OTHER' else 'CASH_DRAWER' end,
      'cash_payout_shift_id', p_cash_payout_shift_id)
  ) returning id into v_refund_entry_id;

  if p_cash_payout_shift_id is not null then
    insert into public.cash_movements (
      shift_id, movement_type, amount_cents, sale_id, payment_attempt_id, refund_entry_id, actor_id, correlation_id
    ) values (
      v_shift.id, 'REFUND_PAYOUT', -v_attempt.amount_cents, v_sale.id, v_attempt.id, v_refund_entry_id,
      v_actor_id, p_correlation_id
    ) returning * into v_payout;
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('shifts.cash.refund_paid_out', v_actor_id, 'seller_shift', v_shift.id::text, p_correlation_id,
      jsonb_build_object('sale_id', v_sale.id, 'payment_attempt_id', v_attempt.id, 'cash_movement_id', v_payout.id,
        'refund_entry_id', v_refund_entry_id, 'amount_cents', v_attempt.amount_cents));
    insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
    values ('shifts.cash.refund_paid_out', 'seller_shift', v_shift.id::text,
      jsonb_build_object('shift_id', v_shift.id, 'sale_id', v_sale.id, 'cash_movement_id', v_payout.id,
        'correlation_id', p_correlation_id));
  end if;

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
      'cash_payout_shift_id', p_cash_payout_shift_id,
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
      'refund_reference', p_refund_reference,
      'cash_payout', case when v_payout.id is null then null else jsonb_build_object(
        'movement_id', v_payout.id, 'shift_id', v_payout.shift_id, 'amount_cents', -v_payout.amount_cents) end
    ),
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale.id::text
  );
  return v_result;
end;
$$;

-- The original signature stays as "refund by another means" so existing callers keep working.
create or replace function public.reverse_confirmed_sale(
  p_sale_id uuid,
  p_reason text,
  p_refund_reference text,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.reverse_confirmed_sale(
    p_sale_id, p_reason, p_refund_reference, null::uuid, p_idempotency_key, p_correlation_id
  );
$$;

revoke all on function public.reverse_confirmed_sale(uuid, text, text, uuid, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.reverse_confirmed_sale(uuid, text, text, uuid, text, uuid)
to authenticated;

comment on column public.cash_movements.refund_entry_id is 'REFUND ledger entry a REFUND_PAYOUT hands back in physical cash.';
comment on function public.reverse_confirmed_sale(uuid, text, text, uuid, text, uuid) is
  'Finance-only idempotent reversal of a confirmed sale; an optional open shift records the physical cash payout.';
