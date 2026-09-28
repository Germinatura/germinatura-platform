-- PAY-009 / ADR 0010: physical cash with its own drawer per seller shift, change computed in cents and a
-- counted close with justified divergence. Cash is an internal channel and never a PicPay receivable.

-- Cash confirmations are MANUAL without a proof reference; PicPay manual channels still require one.
alter table public.payment_attempts drop constraint payment_attempts_manual_origin_valid;
alter table public.payment_attempts add constraint payment_attempts_manual_origin_valid check (
  confirmation_source <> 'MANUAL'
  or (integration_channel = 'DINHEIRO' and proof_reference is null)
  or (
    integration_channel in ('MAQUININHA', 'PIX_AREA')
    and proof_reference is not null
    and char_length(proof_reference) between 4 and 128
    and proof_reference = btrim(proof_reference)
    and proof_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$'
    and proof_reference !~ '[0-9]{12,}'
  )
);

alter table public.financial_ledger_entries add constraint financial_ledger_cash_receipt_positive
  check (entry_type <> 'CASH_RECEIPT' or amount_cents > 0);
create unique index financial_ledger_cash_receipt_attempt_unique
  on public.financial_ledger_entries (payment_attempt_id) where entry_type = 'CASH_RECEIPT';

-- Cash follows the same feature-flag guard as the other manual channels (ADR 0010 approved it).
insert into public.feature_flags (key, description, enabled)
values ('cash_payment', 'Recebimento em dinheiro físico no turno do vendedor', true);

create or replace function private.guard_manual_payment_feature()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.confirmation_source is null and new.confirmation_source = 'MANUAL' then
    if new.integration_channel = 'MAQUININHA' then
      perform private.require_feature('card_present');
    elsif new.integration_channel = 'PIX_AREA' then
      perform private.require_feature('pix_area_manual');
    elsif new.integration_channel = 'DINHEIRO' then
      perform private.require_feature('cash_payment');
    else
      raise exception using errcode = 'P0001', message = 'FEATURE_DISABLED';
    end if;
  end if;
  return new;
end;
$$;

create type public.seller_shift_status as enum ('OPEN', 'CLOSED');

create table public.seller_shifts (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles(id) on delete restrict,
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  status public.seller_shift_status not null default 'OPEN',
  opened_at timestamptz not null default now(),
  opening_cash_cents bigint not null check (opening_cash_cents between 0 and 9007199254740991),
  closed_at timestamptz,
  expected_cash_cents bigint check (expected_cash_cents between 0 and 9007199254740991),
  counted_cash_cents bigint check (counted_cash_cents between 0 and 9007199254740991),
  difference_cents bigint generated always as (counted_cash_cents - expected_cash_cents) stored,
  justification text check (justification is null or (char_length(justification) between 8 and 500 and justification = btrim(justification))),
  opened_correlation_id uuid not null,
  closed_correlation_id uuid,
  constraint seller_shifts_close_consistent check (
    (status = 'OPEN' and closed_at is null and expected_cash_cents is null and counted_cash_cents is null
      and justification is null and closed_correlation_id is null)
    or (status = 'CLOSED' and closed_at is not null and expected_cash_cents is not null
      and counted_cash_cents is not null and closed_correlation_id is not null
      and (counted_cash_cents = expected_cash_cents or justification is not null))
  )
);
create unique index seller_shifts_one_open_per_seller on public.seller_shifts (seller_id) where status = 'OPEN';
create index seller_shifts_seller_opened_idx on public.seller_shifts (seller_id, opened_at desc, id);

-- A shift may only be closed once; nothing else changes after opening.
create function private.guard_seller_shift_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception using errcode = 'P0001', message = 'IMMUTABLE_RECORD'; end if;
  if old.status = 'CLOSED' or new.status <> 'CLOSED'
    or new.seller_id <> old.seller_id or new.location_id <> old.location_id
    or new.opened_at <> old.opened_at or new.opening_cash_cents <> old.opening_cash_cents
    or new.opened_correlation_id <> old.opened_correlation_id then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_TRANSITION_INVALID';
  end if;
  return new;
end;
$$;
create trigger seller_shifts_guard before update or delete on public.seller_shifts
for each row execute function private.guard_seller_shift_change();

create type public.cash_movement_type as enum ('OPENING_FLOAT', 'SALE_RECEIPT');

-- Immutable drawer ledger: the expected cash of a shift is the sum of its movements.
create table public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.seller_shifts(id) on delete restrict,
  movement_type public.cash_movement_type not null,
  amount_cents bigint not null check (amount_cents between 0 and 9007199254740991),
  sale_id uuid references public.sales(id) on delete restrict,
  payment_attempt_id uuid unique references public.payment_attempts(id) on delete restrict,
  tendered_cents bigint check (tendered_cents between 0 and 9007199254740991),
  change_cents bigint check (change_cents between 0 and 9007199254740991),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint cash_movements_shape_valid check (
    (movement_type = 'OPENING_FLOAT' and sale_id is null and payment_attempt_id is null
      and tendered_cents is null and change_cents is null)
    or (movement_type = 'SALE_RECEIPT' and sale_id is not null and payment_attempt_id is not null
      and tendered_cents is not null and change_cents is not null
      and tendered_cents = amount_cents + change_cents)
  )
);
create index cash_movements_shift_created_idx on public.cash_movements (shift_id, created_at, id);
create trigger cash_movements_immutable before update or delete on public.cash_movements
for each row execute function private.prevent_immutable_record_change();

alter table public.seller_shifts enable row level security;
alter table public.cash_movements enable row level security;
revoke all on public.seller_shifts from public, anon, authenticated, service_role;
revoke all on public.cash_movements from public, anon, authenticated, service_role;
grant select on public.seller_shifts to authenticated;
grant select on public.cash_movements to authenticated;
create policy seller_shifts_own_or_finance_read on public.seller_shifts for select to authenticated
using (seller_id = (select auth.uid()) or (select public.has_permission('finance.manage')));
create policy cash_movements_own_or_finance_read on public.cash_movements for select to authenticated
using (exists (select 1 from public.seller_shifts shift where shift.id = cash_movements.shift_id
  and (shift.seller_id = (select auth.uid()) or (select public.has_permission('finance.manage')))));

create function private.seller_shift_summary(p_shift_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'shift_id', shift.id, 'status', shift.status, 'location_id', shift.location_id,
    'opened_at', shift.opened_at, 'closed_at', shift.closed_at,
    'opening_cash_cents', shift.opening_cash_cents,
    'cash_sales_count', (select count(*) from public.cash_movements movement
      where movement.shift_id = shift.id and movement.movement_type = 'SALE_RECEIPT'),
    'cash_sales_total_cents', (select coalesce(sum(movement.amount_cents), 0) from public.cash_movements movement
      where movement.shift_id = shift.id and movement.movement_type = 'SALE_RECEIPT'),
    'expected_cash_cents', coalesce(shift.expected_cash_cents, (select coalesce(sum(movement.amount_cents), 0)
      from public.cash_movements movement where movement.shift_id = shift.id)),
    'counted_cash_cents', shift.counted_cash_cents, 'difference_cents', shift.difference_cents,
    'justification', shift.justification
  ) from public.seller_shifts shift where shift.id = p_shift_id;
$$;

-- Opens the seller's single shift at a location the seller may sell from.
create function public.open_seller_shift(
  p_location_id uuid, p_opening_cash_cents bigint, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_claim record; v_shift_id uuid := gen_random_uuid(); v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if p_correlation_id is null or p_opening_cash_cents is null or p_opening_cash_cents not between 0 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'INVALID_SELLER_SHIFT';
  end if;
  if not exists (
    select 1 from public.stock_locations location
    where location.id = p_location_id and location.active
      and (public.has_permission('inventory.manage')
        or (location.location_type = 'SELLER' and location.seller_id = v_actor_id))
  ) then
    raise exception using errcode = '42501', message = 'SELLER_SHIFT_LOCATION_FORBIDDEN';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('shifts', 'open', v_actor_id), p_idempotency_key,
    jsonb_build_object('location_id', p_location_id, 'opening_cash_cents', p_opening_cash_cents));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if exists (select 1 from public.seller_shifts where seller_id = v_actor_id and status = 'OPEN') then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_ALREADY_OPEN';
  end if;
  insert into public.seller_shifts (id, seller_id, location_id, opening_cash_cents, opened_correlation_id)
  values (v_shift_id, v_actor_id, p_location_id, p_opening_cash_cents, p_correlation_id);
  if p_opening_cash_cents > 0 then
    insert into public.cash_movements (shift_id, movement_type, amount_cents, actor_id, correlation_id)
    values (v_shift_id, 'OPENING_FLOAT', p_opening_cash_cents, v_actor_id, p_correlation_id);
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('shifts.opened', v_actor_id, 'seller_shift', v_shift_id::text, p_correlation_id,
    jsonb_build_object('location_id', p_location_id, 'opening_cash_cents', p_opening_cash_cents));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('shifts.opened', 'seller_shift', v_shift_id::text,
    jsonb_build_object('shift_id', v_shift_id, 'seller_id', v_actor_id, 'location_id', p_location_id));
  v_result := private.seller_shift_summary(v_shift_id) || jsonb_build_object('correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'seller_shift', v_shift_id::text);
  return v_result;
end;
$$;

-- PAY-009: confirms a PDV sale paid in cash inside the seller's open shift at the sale location.
create function public.confirm_cash_payment(
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
  if not found or v_sale.created_by <> v_actor_id or v_sale.channel <> 'PDV' then
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

-- Closes the seller's shift with a physical count; a divergence needs a justification.
create function public.close_seller_shift(
  p_shift_id uuid, p_counted_cash_cents bigint, p_justification text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_shift public.seller_shifts%rowtype; v_claim record;
  v_expected bigint; v_justification text := nullif(btrim(p_justification), ''); v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if p_correlation_id is null or p_counted_cash_cents is null or p_counted_cash_cents not between 0 and 9007199254740991
    or (v_justification is not null and char_length(v_justification) not between 8 and 500) then
    raise exception using errcode = '22023', message = 'INVALID_SELLER_SHIFT_CLOSE';
  end if;
  select * into v_shift from public.seller_shifts where id = p_shift_id for update;
  if not found or v_shift.seller_id <> v_actor_id then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('shifts', 'close', v_actor_id), p_idempotency_key,
    jsonb_build_object('shift_id', p_shift_id, 'counted_cash_cents', p_counted_cash_cents, 'justification', v_justification));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if v_shift.status <> 'OPEN' then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_NOT_OPEN';
  end if;
  select coalesce(sum(amount_cents), 0) into v_expected from public.cash_movements where shift_id = v_shift.id;
  if p_counted_cash_cents <> v_expected and v_justification is null then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_JUSTIFICATION_REQUIRED';
  end if;
  update public.seller_shifts
  set status = 'CLOSED', closed_at = clock_timestamp(), expected_cash_cents = v_expected,
    counted_cash_cents = p_counted_cash_cents, justification = v_justification, closed_correlation_id = p_correlation_id
  where id = v_shift.id;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('shifts.closed', v_actor_id, 'seller_shift', v_shift.id::text, p_correlation_id,
    jsonb_build_object('expected_cash_cents', v_expected, 'counted_cash_cents', p_counted_cash_cents,
      'difference_cents', p_counted_cash_cents - v_expected, 'justification', v_justification));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('shifts.closed', 'seller_shift', v_shift.id::text,
    jsonb_build_object('shift_id', v_shift.id, 'seller_id', v_actor_id, 'difference_cents', p_counted_cash_cents - v_expected));
  v_result := private.seller_shift_summary(v_shift.id) || jsonb_build_object('correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'seller_shift', v_shift.id::text);
  return v_result;
end;
$$;

-- Current open shift of the caller (or null) for the PDV "Meu turno" screen.
create function public.get_my_seller_shift()
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.seller_shift_summary(shift.id) from public.seller_shifts shift
  where shift.seller_id = auth.uid() and shift.status = 'OPEN';
$$;

revoke all on function private.guard_seller_shift_change() from public, anon, authenticated, service_role;
revoke all on function private.seller_shift_summary(uuid) from public, anon, authenticated, service_role;
revoke all on function public.open_seller_shift(uuid, bigint, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.confirm_cash_payment(uuid, bigint, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.close_seller_shift(uuid, bigint, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_seller_shift() from public, anon, authenticated, service_role;
grant execute on function public.open_seller_shift(uuid, bigint, text, uuid) to authenticated;
grant execute on function public.confirm_cash_payment(uuid, bigint, text, uuid) to authenticated;
grant execute on function public.close_seller_shift(uuid, bigint, text, text, uuid) to authenticated;
grant execute on function public.get_my_seller_shift() to authenticated;

comment on table public.seller_shifts is 'PAY-009: seller cash shift; expected cash = opening float + cash receipts; divergence needs justification.';
comment on table public.cash_movements is 'Immutable drawer ledger of a seller shift; cash is an internal channel, not a PicPay receivable.';
comment on function public.confirm_cash_payment(uuid, bigint, text, uuid) is 'Confirms a PDV sale paid in cash within the seller open shift, computing change in cents.';
