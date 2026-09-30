-- Etapa 8.4 (RAF-005, spec 4.4 e 5.11): finance refunds a paid raffle sale.
-- Rule (RAF-002): while sales are open (ACTIVE/PAUSED) a paid sale is refunded individually and its numbers
-- return to the board; after CLOSED only a whole-raffle cancellation before the draw allows refunds;
-- after DRAWN nothing changes the eligible universe. Refunded numbers are kept in an immutable record.

create table public.raffle_sale_refunds (
  sale_id uuid primary key references public.sales(id) on delete restrict,
  campaign_id uuid not null references public.raffle_campaigns(id) on delete restrict,
  numbers integer[] not null check (cardinality(numbers) between 1 and 100),
  customer_id uuid references public.profiles(id) on delete restrict,
  campaign_status text not null check (campaign_status in ('ACTIVE', 'PAUSED', 'CANCELLED')),
  refund_entry_id uuid not null references public.financial_ledger_entries(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
create index raffle_sale_refunds_customer_idx on public.raffle_sale_refunds (customer_id, created_at desc) where customer_id is not null;
alter table public.raffle_sale_refunds enable row level security;
revoke all on public.raffle_sale_refunds from public, anon, authenticated;

create or replace function private.prevent_raffle_refund_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'RAFFLE_REFUND_IMMUTABLE';
end;
$$;
create trigger raffle_sale_refunds_immutable before update or delete on public.raffle_sale_refunds
for each row execute function private.prevent_raffle_refund_change();
revoke all on function private.prevent_raffle_refund_change() from public, anon, authenticated, service_role;

-- The goods reversal keeps its body; the public entry point now dispatches raffle sales to their own reversal.
alter function public.reverse_confirmed_sale(uuid, text, text, uuid, text, uuid) set schema private;
alter function private.reverse_confirmed_sale(uuid, text, text, uuid, text, uuid) rename to reverse_confirmed_goods_sale;
revoke all on function private.reverse_confirmed_goods_sale(uuid, text, text, uuid, text, uuid) from public, anon, authenticated, service_role;

create or replace function private.raffle_refund_block(p_campaign public.raffle_campaigns)
returns text language sql stable set search_path = '' as $$
  select case
    when p_campaign.status in ('ACTIVE', 'PAUSED', 'CANCELLED')
      and not exists (select 1 from public.raffle_draws draw where draw.campaign_id = p_campaign.id) then null
    when p_campaign.status = 'DRAWN' or exists (select 1 from public.raffle_draws draw where draw.campaign_id = p_campaign.id)
      then 'RAFFLE_ALREADY_DRAWN'
    else 'RAFFLE_CLOSED_REFUND_REQUIRES_CANCELLATION' end;
$$;
revoke all on function private.raffle_refund_block(public.raffle_campaigns) from public, anon, authenticated, service_role;

create function private.reverse_paid_raffle_sale(
  p_sale_id uuid, p_reason text, p_refund_reference text, p_cash_payout_shift_id uuid,
  p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_campaign public.raffle_campaigns%rowtype;
  v_shift public.seller_shifts%rowtype;
  v_payout public.cash_movements%rowtype;
  v_refund public.raffle_sale_refunds%rowtype;
  v_numbers integer[];
  v_campaign_id uuid;
  v_block text;
  v_drawer_cents bigint;
  v_refund_entry_id uuid;
  v_claim record;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_reason is null or char_length(p_reason) not between 8 and 500 or p_reason <> btrim(p_reason) then
    raise exception using errcode = '22023', message = 'INVALID_REVERSAL_REASON';
  end if;
  if p_refund_reference is null or char_length(p_refund_reference) not between 4 and 128
    or p_refund_reference <> btrim(p_refund_reference)
    or p_refund_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$' or p_refund_reference ~ '[0-9]{12,}' then
    raise exception using errcode = '22023', message = 'INVALID_REFUND_REFERENCE';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;
  -- Same scope and fingerprint as the goods reversal: one key means one reversal whatever the sale holds.
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('sales', 'reverse_confirmed', v_actor_id), p_idempotency_key,
    jsonb_build_object('sale_id', p_sale_id, 'reason', p_reason, 'refund_reference', p_refund_reference)
      || case when p_cash_payout_shift_id is null then '{}'::jsonb
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
    -- A new key for a sale already refunded: report what happened, never refund twice.
    select * into v_refund from public.raffle_sale_refunds where sale_id = p_sale_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'SALE_NOT_REVERSIBLE';
    end if;
    raise exception using errcode = 'P0001', message = 'SALE_ALREADY_REVERSED';
  end if;
  if v_sale.status <> 'CONFIRMED' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_CONFIRMED';
  end if;
  if v_attempt.status not in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED') then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_REFUNDABLE';
  end if;

  select campaign_id into v_campaign_id from public.raffle_numbers where sale_id = p_sale_id and status = 'PAID' limit 1;
  -- The campaign lock serializes the refund with the close, the draw and the cancellation.
  select * into v_campaign from public.raffle_campaigns where id = v_campaign_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'RAFFLE_SALE_NOT_FOUND';
  end if;
  v_block := private.raffle_refund_block(v_campaign);
  if v_block is not null then
    raise exception using errcode = 'P0001', message = v_block;
  end if;
  select array_agg(number order by number) into v_numbers from (
    select number from public.raffle_numbers where campaign_id = v_campaign.id and sale_id = p_sale_id and status = 'PAID'
    order by number for update
  ) locked;

  if p_cash_payout_shift_id is not null then
    if v_attempt.integration_channel is distinct from 'DINHEIRO' then
      raise exception using errcode = 'P0001', message = 'CASH_PAYOUT_NOT_CASH_SALE';
    end if;
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

  insert into public.financial_ledger_entries (sale_id, payment_attempt_id, entry_type, amount_cents, actor_id, correlation_id, metadata)
  values (v_sale.id, v_attempt.id, 'REFUND', -v_attempt.amount_cents, v_actor_id, p_correlation_id,
    jsonb_build_object('refund_reference', p_refund_reference, 'reason', p_reason, 'source', 'MANUAL',
      'refund_method', case when p_cash_payout_shift_id is null then 'OTHER' else 'CASH_DRAWER' end,
      'cash_payout_shift_id', p_cash_payout_shift_id, 'raffle_campaign_id', v_campaign.id, 'raffle_numbers', to_jsonb(v_numbers)))
  returning id into v_refund_entry_id;

  if p_cash_payout_shift_id is not null then
    insert into public.cash_movements (shift_id, movement_type, amount_cents, sale_id, payment_attempt_id, refund_entry_id, actor_id, correlation_id)
    values (v_shift.id, 'REFUND_PAYOUT', -v_attempt.amount_cents, v_sale.id, v_attempt.id, v_refund_entry_id, v_actor_id, p_correlation_id)
    returning * into v_payout;
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('shifts.cash.refund_paid_out', v_actor_id, 'seller_shift', v_shift.id::text, p_correlation_id,
      jsonb_build_object('sale_id', v_sale.id, 'payment_attempt_id', v_attempt.id, 'cash_movement_id', v_payout.id,
        'refund_entry_id', v_refund_entry_id, 'amount_cents', v_attempt.amount_cents));
    insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
    values ('shifts.cash.refund_paid_out', 'seller_shift', v_shift.id::text,
      jsonb_build_object('shift_id', v_shift.id, 'sale_id', v_sale.id, 'cash_movement_id', v_payout.id, 'correlation_id', p_correlation_id));
  end if;

  insert into public.raffle_sale_refunds (sale_id, campaign_id, numbers, customer_id, campaign_status, refund_entry_id, actor_id, correlation_id)
  values (v_sale.id, v_campaign.id, v_numbers, v_sale.customer_id, v_campaign.status::text, v_refund_entry_id, v_actor_id, p_correlation_id);
  -- The numbers leave the eligible universe; while sales are open they can be sold again.
  update public.raffle_numbers set status = 'AVAILABLE', reserved_by = null, sale_id = null, payment_attempt_id = null,
    reserved_at = null, expires_at = null, paid_at = null
  where campaign_id = v_campaign.id and sale_id = v_sale.id and status = 'PAID';

  v_attempt := private.transition_payment_attempt(v_attempt.id, 'REFUNDED', v_actor_id, p_correlation_id, p_reason);
  update public.sales set status = 'CANCELLED' where id = v_sale.id returning * into v_sale;
  insert into public.sale_status_history (sale_id, from_status, to_status, actor_id, reason, correlation_id)
  values (v_sale.id, 'CONFIRMED', 'CANCELLED', v_actor_id, p_reason, p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('sales.status.changed', v_actor_id, 'sale', v_sale.id::text, p_correlation_id,
    jsonb_build_object('status', 'CANCELLED', 'reason', p_reason, 'reversal', true));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('sales.status.changed', 'sale', v_sale.id::text,
    jsonb_build_object('sale_id', v_sale.id, 'status', 'CANCELLED', 'correlation_id', p_correlation_id, 'reversal', true));
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('raffles.sale.refunded', v_actor_id, 'sale', v_sale.id::text, p_correlation_id,
    jsonb_build_object('campaign_id', v_campaign.id, 'campaign_status', v_campaign.status, 'numbers', to_jsonb(v_numbers),
      'payment_attempt_id', v_attempt.id, 'refund_entry_id', v_refund_entry_id, 'amount_cents', v_attempt.amount_cents,
      'refund_reference', p_refund_reference, 'cash_payout_shift_id', p_cash_payout_shift_id, 'reason', p_reason));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('raffles.sale.refunded', 'sale', v_sale.id::text,
    jsonb_build_object('sale_id', v_sale.id, 'campaign_id', v_campaign.id, 'customer_id', v_sale.customer_id,
      'refund_entry_id', v_refund_entry_id, 'correlation_id', p_correlation_id));

  v_result := jsonb_build_object(
    'sale_id', v_sale.id, 'status', v_sale.status,
    'payment_attempt', jsonb_build_object('attempt_id', v_attempt.id, 'status', v_attempt.status),
    'reversal', jsonb_build_object(
      'stock_movement_id', null, 'refund_entry_id', v_refund_entry_id, 'amount_cents', v_attempt.amount_cents,
      'refund_reference', p_refund_reference,
      'cash_payout', case when v_payout.id is null then null else jsonb_build_object(
        'movement_id', v_payout.id, 'shift_id', v_payout.shift_id, 'amount_cents', -v_payout.amount_cents) end,
      'raffle', jsonb_build_object('campaign_id', v_campaign.id, 'numbers', to_jsonb(v_numbers))),
    'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale.id::text);
  return v_result;
end;
$$;
revoke all on function private.reverse_paid_raffle_sale(uuid, text, text, uuid, text, uuid) from public, anon, authenticated, service_role;

create function public.reverse_confirmed_sale(
  p_sale_id uuid, p_reason text, p_refund_reference text, p_cash_payout_shift_id uuid,
  p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.raffle_numbers where sale_id = p_sale_id and status = 'PAID')
    or exists (select 1 from public.raffle_sale_refunds where sale_id = p_sale_id) then
    return private.reverse_paid_raffle_sale(p_sale_id, p_reason, p_refund_reference, p_cash_payout_shift_id, p_idempotency_key, p_correlation_id);
  end if;
  return private.reverse_confirmed_goods_sale(p_sale_id, p_reason, p_refund_reference, p_cash_payout_shift_id, p_idempotency_key, p_correlation_id);
end;
$$;
revoke all on function public.reverse_confirmed_sale(uuid, text, text, uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.reverse_confirmed_sale(uuid, text, text, uuid, text, uuid) to authenticated;
comment on function public.reverse_confirmed_sale(uuid, text, text, uuid, text, uuid) is
  'Finance-only idempotent reversal of a confirmed sale (goods or raffle numbers); an optional open shift records the physical cash payout.';

-- The finance detail mirrors the raffle rule, so the screen only offers what the command accepts.
alter function public.get_sale_admin(uuid) set schema private;
alter function private.get_sale_admin(uuid) rename to get_sale_admin_base;
revoke all on function private.get_sale_admin_base(uuid) from public, anon, authenticated, service_role;

create function public.get_sale_admin(p_sale_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_detail jsonb := private.get_sale_admin_base(p_sale_id);
  v_campaign public.raffle_campaigns%rowtype;
  v_numbers integer[];
  v_refund public.raffle_sale_refunds%rowtype;
  v_block text;
begin
  select * into v_refund from public.raffle_sale_refunds where sale_id = p_sale_id;
  if found then
    select * into v_campaign from public.raffle_campaigns where id = v_refund.campaign_id;
    v_numbers := v_refund.numbers;
  else
    select campaign.* into v_campaign from public.raffle_campaigns campaign
    where campaign.id = (select campaign_id from public.raffle_numbers where sale_id = p_sale_id limit 1);
    select array_agg(number order by number) into v_numbers from public.raffle_numbers where sale_id = p_sale_id;
  end if;
  if v_campaign.id is null then
    return v_detail || jsonb_build_object('raffle', null);
  end if;
  v_block := private.raffle_refund_block(v_campaign);
  v_detail := v_detail || jsonb_build_object('raffle', jsonb_build_object('campaign_id', v_campaign.id,
    'campaign_name', v_campaign.name, 'campaign_status', v_campaign.status, 'numbers', to_jsonb(v_numbers)));
  if v_detail ->> 'status' = 'CONFIRMED' and v_detail #>> '{reversal,blocked_reason}' = 'PAID_RAFFLE_REVERSAL_REQUIRED' then
    v_detail := jsonb_set(v_detail, '{reversal}', (v_detail -> 'reversal') || jsonb_build_object(
      'allowed', v_block is null
        and v_detail #>> '{payment,status}' in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED'),
      'blocked_reason', coalesce(v_block, case when v_detail #>> '{payment,status}' in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED')
        then null else 'PAYMENT_ATTEMPT_NOT_REFUNDABLE' end)));
  end if;
  return v_detail;
end;
$$;
revoke all on function public.get_sale_admin(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_sale_admin(uuid) to authenticated;
comment on function public.get_sale_admin(uuid) is
  'Finance sale detail with payment, ledger, drawer movements, history, raffle numbers and reversal eligibility.';

-- Meus bilhetes keeps refunded purchases, from the immutable refund record.
create or replace function public.list_my_raffle_tickets()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null or not public.has_permission('raffles.buy') then
    raise exception using errcode = '42501', message = 'RAFFLE_BUY_FORBIDDEN';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'sale_id', sale.id, 'campaign_id', campaign.id, 'campaign_name', campaign.name, 'campaign_status', campaign.status,
      'numbers', tickets.numbers, 'sale_status', sale.status, 'total_cents', sale.total_cents, 'created_at', sale.created_at,
      'expires_at', tickets.expires_at, 'paid_at', tickets.paid_at,
      'payment', (select jsonb_build_object('status', attempt.status, 'integration_channel', attempt.integration_channel,
          'confirmation_source', attempt.confirmation_source)
        from public.payment_attempts attempt where attempt.sale_id = sale.id order by attempt.created_at desc, attempt.id desc limit 1),
      'open_payment_link_id', (select charge.id from public.payment_link_charges charge
        where charge.sale_id = sale.id and charge.status in ('REQUESTED', 'ACTIVE', 'UNCERTAIN') order by charge.created_at desc limit 1),
      'won', not tickets.refunded and draw.winner_number is not null and draw.winner_number = any(tickets.numbers)
    ) order by sale.created_at desc, sale.id)
    from (
      select item.sale_id, item.campaign_id, array_agg(item.number order by item.number) numbers,
        min(item.expires_at) expires_at, max(item.paid_at) paid_at, false refunded
      from public.raffle_numbers item
      where item.reserved_by = v_actor_id and item.sale_id is not null
      group by item.sale_id, item.campaign_id
      union all
      select refund.sale_id, refund.campaign_id, refund.numbers, null, null, true
      from public.raffle_sale_refunds refund where refund.customer_id = v_actor_id
    ) tickets
    join public.sales sale on sale.id = tickets.sale_id and sale.customer_id = v_actor_id
    join public.raffle_campaigns campaign on campaign.id = tickets.campaign_id
    left join public.raffle_draws draw on draw.campaign_id = campaign.id
  ), '[]'::jsonb);
end;
$$;

comment on table public.raffle_sale_refunds is 'Immutable record of the numbers a refunded raffle sale held (RAF-005).';
