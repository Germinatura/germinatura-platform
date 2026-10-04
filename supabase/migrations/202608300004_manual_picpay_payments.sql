create type public.financial_ledger_entry_type as enum (
  'RECEIVABLE_PICPAY',
  'FEE',
  'SETTLEMENT',
  'REFUND',
  'DIVERGENCE'
);

alter table public.payment_attempts
  add column proof_reference text,
  add column confirmed_at timestamptz,
  add constraint payment_attempts_confirmation_pair_valid check (
    (integration_channel is null and confirmation_source is null)
    or (integration_channel is not null and confirmation_source is not null)
  ),
  add constraint payment_attempts_manual_origin_valid check (
    confirmation_source <> 'MANUAL'
    or (
      integration_channel in ('MAQUININHA', 'PIX_AREA')
      and proof_reference is not null
      and char_length(proof_reference) between 4 and 128
      and proof_reference = btrim(proof_reference)
      and proof_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$'
      and proof_reference !~ '[0-9]{12,}'
    )
  ),
  add constraint payment_attempts_confirmation_time_valid check (
    confirmed_at is null
    or (
      confirmation_source is not null
      and status in ('APPROVED', 'REFUNDED', 'RECONCILIATION_PENDING', 'RECONCILED')
    )
  ),
  add constraint payment_attempts_proof_source_valid check (
    proof_reference is null or confirmation_source = 'MANUAL'
  );

create unique index payment_attempts_manual_proof_unique
  on public.payment_attempts (proof_reference)
  where confirmation_source = 'MANUAL';

create table public.financial_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  payment_attempt_id uuid not null references public.payment_attempts(id) on delete restrict,
  entry_type public.financial_ledger_entry_type not null,
  amount_cents bigint not null,
  currency text not null default 'BRL',
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint financial_ledger_amount_valid check (
    amount_cents between -9007199254740991 and 9007199254740991
    and amount_cents <> 0
  ),
  constraint financial_ledger_currency_brl check (currency = 'BRL'),
  constraint financial_ledger_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint financial_ledger_receivable_positive check (
    entry_type <> 'RECEIVABLE_PICPAY' or amount_cents > 0
  )
);

create unique index financial_ledger_receivable_attempt_unique
  on public.financial_ledger_entries (payment_attempt_id)
  where entry_type = 'RECEIVABLE_PICPAY';
create index financial_ledger_sale_created_idx
  on public.financial_ledger_entries (sale_id, created_at, id);
create index financial_ledger_type_created_idx
  on public.financial_ledger_entries (entry_type, created_at, id);
create index financial_ledger_correlation_idx
  on public.financial_ledger_entries (correlation_id);

create trigger financial_ledger_entries_immutable before update or delete
on public.financial_ledger_entries
for each row execute function private.prevent_immutable_record_change();

create or replace function private.consume_sale_reservation(
  p_sale_id uuid,
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
  v_movement_id uuid := gen_random_uuid();
begin
  select * into v_reservation
  from public.stock_reservations
  where origin_type = 'sale' and origin_id = p_sale_id::text
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SALE_RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = 'SALE_RESERVATION_NOT_ACTIVE';
  end if;
  if v_reservation.expires_at <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'SALE_RESERVATION_EXPIRED';
  end if;

  select jsonb_agg(
    jsonb_build_object('product_id', product_id, 'quantity', quantity)
    order by product_id
  ) into v_items
  from public.stock_reservation_items
  where reservation_id = v_reservation.id;

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
      on balance.location_id = v_reservation.location_id
      and balance.product_id = item.product_id
    where balance.id is null
      or balance.reserved_quantity < item.quantity
      or balance.on_hand_quantity < item.quantity
  ) then
    raise exception using errcode = 'P0001', message = 'SALE_STOCK_CONSUMPTION_CONFLICT';
  end if;

  update public.inventory_balances balance
  set on_hand_quantity = balance.on_hand_quantity - item.quantity,
      reserved_quantity = balance.reserved_quantity - item.quantity
  from jsonb_to_recordset(v_items) as item(product_id uuid, quantity bigint)
  where balance.location_id = v_reservation.location_id
    and balance.product_id = item.product_id;

  insert into public.stock_movements (
    id, movement_type, from_location_id, actor_id, reason,
    correlation_id, source_type, source_id
  ) values (
    v_movement_id, 'VENDA', v_reservation.location_id, p_actor_id,
    'Consumo de reserva por venda confirmada', p_correlation_id,
    'sale', p_sale_id::text
  );
  insert into public.stock_movement_items (movement_id, product_id, quantity)
  select v_movement_id, item.product_id, item.quantity
  from jsonb_to_recordset(v_items) as item(product_id uuid, quantity bigint);

  update public.stock_reservations
  set status = 'CONSUMED', consumed_at = clock_timestamp()
  where id = v_reservation.id;

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'inventory.sale.consumed', p_actor_id, 'sale', p_sale_id::text,
    p_correlation_id,
    jsonb_build_object(
      'reservation_id', v_reservation.id,
      'movement_id', v_movement_id,
      'items', v_items
    )
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'inventory.sale.consumed', 'sale', p_sale_id::text,
    jsonb_build_object(
      'sale_id', p_sale_id,
      'reservation_id', v_reservation.id,
      'movement_id', v_movement_id,
      'correlation_id', p_correlation_id
    )
  );

  return jsonb_build_object(
    'reservation_id', v_reservation.id,
    'status', 'CONSUMED',
    'sale_movement_id', v_movement_id
  );
end;
$$;

create or replace function public.confirm_manual_payment(
  p_sale_id uuid,
  p_integration_channel public.payment_integration_channel,
  p_proof_reference text,
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

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.created_by <> v_actor_id or v_sale.channel <> 'PDV' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;

  v_scope := private.build_idempotency_scope('payments', 'manual_confirmation', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object(
      'sale_id', p_sale_id,
      'integration_channel', p_integration_channel,
      'proof_reference', p_proof_reference
    )
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
      proof_reference = p_proof_reference
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
    )
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
      'proof_reference', v_attempt.proof_reference
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

alter table public.financial_ledger_entries enable row level security;
revoke all on table public.financial_ledger_entries from public, anon, authenticated, service_role;
grant select on table public.financial_ledger_entries to authenticated;
create policy financial_ledger_finance_read
on public.financial_ledger_entries for select to authenticated
using (public.has_permission('finance.manage'));

revoke all on function private.consume_sale_reservation(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.confirm_manual_payment(uuid, public.payment_integration_channel, text, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.confirm_manual_payment(uuid, public.payment_integration_channel, text, text, uuid)
to authenticated;

comment on table public.financial_ledger_entries is
  'Immutable signed-cent operational ledger for PicPay receivables, fees, settlements, refunds and divergences.';
comment on function public.confirm_manual_payment(uuid, public.payment_integration_channel, text, text, uuid) is
  'Records human-confirmed MAQUININHA or PIX_AREA payment and atomically consumes stock, confirms the sale and creates its receivable.';
