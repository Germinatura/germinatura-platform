-- ADR 0010, PAY-004 and PAY-007: Payment Link lifecycle after creation, driven by the database and the jobs worker,
-- never by screen state.
-- * Inactivation: when a sale stops waiting for payment (paid by any means, expired or cancelled) its open links are
--   marked for inactivation and the worker inactivates them at the provider (idempotent, retried; persistent
--   failure opens recovery). A request still unclaimed simply fails.
-- * Status polling: the worker reads each open link's transactions through the official API and feeds them to the
--   same exactly-once path as the webhook (source STATUS_QUERY), so a lost notice is recovered.
-- * Provider refunds: finance asks for a refund of a provider transaction; the worker submits it once. Timeout or
--   5xx makes it UNCERTAIN (never resubmitted automatically). Only a provider REFUND event confirms it.
-- * Reconciliation: finance settles an uncertain link (found in the PicPay panel, or confirmed never created) and an
--   uncertain refund, so nothing is created or refunded twice blindly.

alter table public.payment_link_charges
  add column inactivation_requested_at timestamptz,
  add column inactivation_attempts integer not null default 0,
  add column inactivated_at timestamptz,
  add column last_status_check_at timestamptz,
  add column closed_at timestamptz;

create index payment_link_charges_inactivation_idx on public.payment_link_charges (inactivation_requested_at)
  where inactivation_requested_at is not null and inactivated_at is null;
create index payment_link_charges_status_check_idx on public.payment_link_charges (last_status_check_at nulls first)
  where provider_link_id is not null;

create or replace function private.guard_payment_link_charge()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_RECORD_IMMUTABLE';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'REQUESTED' then
      raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_MUST_START_REQUESTED';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.sale_id <> old.sale_id or new.attempt_id <> old.attempt_id
    or new.amount_cents <> old.amount_cents or new.order_number <> old.order_number
    or new.requested_by <> old.requested_by or new.correlation_id <> old.correlation_id
    or new.created_at <> old.created_at
    or (old.provider_link_id is not null and new.provider_link_id is distinct from old.provider_link_id)
    or (old.inactivated_at is not null and new.inactivated_at is distinct from old.inactivated_at) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_RECORD_IMMUTABLE';
  end if;
  if new.status <> old.status and not (
    (old.status = 'REQUESTED' and new.status in ('ACTIVE', 'FAILED', 'UNCERTAIN'))
    or (old.status = 'UNCERTAIN' and new.status in ('ACTIVE', 'FAILED'))
    or (old.status = 'ACTIVE' and new.status in ('PAID', 'INACTIVE'))
  ) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_TRANSITION_INVALID';
  end if;
  if new.status <> old.status and new.status in ('PAID', 'INACTIVE', 'FAILED') then
    new.closed_at := clock_timestamp();
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- A sale that stops waiting for payment closes its links. Paid links are also inactivated so they cannot take a
-- second payment.
create or replace function private.close_payment_links_for_sale()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'AWAITING_PAYMENT' and new.status in ('CONFIRMED', 'CANCELLED') then
    update public.payment_link_charges set status = 'FAILED', error_code = 'SALE_CLOSED'
    where sale_id = new.id and status = 'REQUESTED' and attempts = 0;
    update public.payment_link_charges
    set inactivation_requested_at = coalesce(inactivation_requested_at, clock_timestamp())
    where sale_id = new.id and status in ('REQUESTED', 'ACTIVE', 'UNCERTAIN') and inactivated_at is null;
  end if;
  return new;
end;
$$;

create trigger sales_close_payment_links after update of status on public.sales
for each row execute function private.close_payment_links_for_sale();

create table public.payment_link_refund_requests (
  id uuid primary key default gen_random_uuid(),
  transaction_id text not null,
  charge_id uuid references public.payment_link_charges(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  amount_cents bigint not null,
  reason text not null,
  status public.payment_link_refund_status not null default 'REQUESTED',
  source_recovery_item_id uuid references public.payment_recovery_items(id) on delete restrict,
  provider_refund_id text,
  provider_original_amount_cents bigint,
  error_code text,
  worker_id text,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  confirmed_at timestamptz,
  constraint payment_link_refund_amount_valid check (amount_cents between 1 and 999999998),
  constraint payment_link_refund_transaction_valid check (transaction_id ~ '^[A-Za-z0-9-]{8,64}$'),
  constraint payment_link_refund_reason_valid check (char_length(reason) between 3 and 300 and reason = btrim(reason)),
  constraint payment_link_refund_error_valid check (error_code is null or error_code ~ '^[A-Z0-9_]{2,64}$'),
  constraint payment_link_refund_confirmed_valid check ((status = 'CONFIRMED') = (confirmed_at is not null))
);
-- One refund in flight per provider transaction; a failed one can be asked again.
create unique index payment_link_refund_open_unique on public.payment_link_refund_requests (transaction_id)
  where status in ('REQUESTED', 'ACCEPTED', 'UNCERTAIN');
create index payment_link_refund_requested_idx on public.payment_link_refund_requests (created_at) where status = 'REQUESTED';

create or replace function private.guard_payment_link_refund_request()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_RECORD_IMMUTABLE';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'REQUESTED' then
      raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_MUST_START_REQUESTED';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.transaction_id <> old.transaction_id or new.amount_cents <> old.amount_cents
    or new.charge_id is distinct from old.charge_id or new.sale_id is distinct from old.sale_id
    or new.reason <> old.reason or new.requested_by <> old.requested_by or new.created_at <> old.created_at
    or new.source_recovery_item_id is distinct from old.source_recovery_item_id then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_RECORD_IMMUTABLE';
  end if;
  -- A provider event can confirm a refund before the worker records the API answer.
  if new.status <> old.status and not (
    (old.status = 'REQUESTED' and new.status in ('ACCEPTED', 'FAILED', 'UNCERTAIN', 'CONFIRMED'))
    or (old.status = 'ACCEPTED' and new.status = 'CONFIRMED')
    or (old.status = 'UNCERTAIN' and new.status in ('ACCEPTED', 'CONFIRMED', 'FAILED'))
  ) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_TRANSITION_INVALID';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger payment_link_refund_requests_guard before insert or update or delete on public.payment_link_refund_requests
for each row execute function private.guard_payment_link_refund_request();

create or replace function private.payment_link_refund_json(p_request public.payment_link_refund_requests)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'refund_id', p_request.id, 'transaction_id', p_request.transaction_id, 'charge_id', p_request.charge_id,
    'sale_id', p_request.sale_id, 'amount_cents', p_request.amount_cents, 'reason', p_request.reason,
    'status', p_request.status, 'error_code', p_request.error_code, 'created_at', p_request.created_at,
    'confirmed_at', p_request.confirmed_at
  );
$$;

create or replace function private.resolve_payment_recovery(p_item_id uuid, p_note text, p_actor_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if p_item_id is null then return; end if;
  update public.payment_recovery_items
  set status = 'RESOLVED', resolved_at = clock_timestamp(), resolved_by = p_actor_id, resolution_note = p_note
  where id = p_item_id and status = 'OPEN';
end;
$$;

-- Same exactly-once path as before; refunds now also settle the matching refund request.
create or replace function private.apply_payment_link_receipt(p_receipt_id uuid, p_actor_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_receipt public.payment_webhook_receipts%rowtype;
  v_charge public.payment_link_charges%rowtype;
  v_sale public.sales%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_request public.payment_link_refund_requests%rowtype;
  v_outcome public.payment_webhook_outcome;
  v_recovery_id uuid;
  v_sale_id uuid;
  v_actor uuid;
  v_ledger_id uuid;
  v_stock jsonb;
  v_refunded_applied boolean;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_receipt from public.payment_webhook_receipts where id = p_receipt_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_RECEIPT_NOT_FOUND';
  end if;

  begin
    if v_receipt.event_kind is null
      or (v_receipt.event_kind = 'PAYMENT' and v_receipt.transaction_status <> 'PAYED')
      or (v_receipt.event_kind = 'REFUND' and v_receipt.transaction_status not in ('REFUNDED', 'PARTREFUNDED')) then
      v_outcome := 'RECOVERY_OPENED';
      v_recovery_id := private.open_payment_recovery('UNSUPPORTED_EVENT', v_receipt.id::text, v_receipt.id, null, null,
        v_receipt.amount_cents, v_receipt.transaction_id, 'Evento do PicPay em formato não reconhecido; confira o conteúdo recebido.');
    elsif v_receipt.event_kind = 'REFUND' then
      select * into v_charge from public.payment_link_charges where provider_link_id = v_receipt.provider_link_id for update;
      select * into v_request from public.payment_link_refund_requests
      where status in ('REQUESTED', 'ACCEPTED', 'UNCERTAIN') and amount_cents = v_receipt.amount_cents
        and (transaction_id = v_receipt.original_transaction_id
          or (v_receipt.original_transaction_id is null and v_charge.id is not null and charge_id = v_charge.id))
      order by created_at, id limit 1 for update;
      if v_charge.id is null and v_request.id is null then
        v_outcome := 'RECOVERY_OPENED';
        v_recovery_id := private.open_payment_recovery('UNMATCHED_REFUND', v_receipt.dedup_key, v_receipt.id, null, null,
          v_receipt.amount_cents, v_receipt.transaction_id,
          'Estorno de um link de pagamento que não foi gerado por este sistema ou ainda não foi registrado.');
      else
        v_sale_id := coalesce(v_charge.sale_id, v_request.sale_id);
        insert into public.payment_link_provider_refunds (receipt_id, charge_id, sale_id, refund_transaction_id,
          original_transaction_id, amount_cents, provider_status)
        values (v_receipt.id, coalesce(v_charge.id, v_request.charge_id), v_sale_id, v_receipt.transaction_id,
          coalesce(v_receipt.original_transaction_id, v_request.transaction_id), v_receipt.amount_cents, v_receipt.transaction_status)
        on conflict (refund_transaction_id) do nothing;
        if v_request.id is not null then
          update public.payment_link_refund_requests set status = 'CONFIRMED', confirmed_at = v_now, worker_id = null, lease_expires_at = null
          where id = v_request.id;
          perform private.resolve_payment_recovery(v_request.source_recovery_item_id,
            'Estorno confirmado pelo PicPay.', p_actor_id);
          perform private.resolve_payment_recovery(
            (select id from public.payment_recovery_items where kind = 'REFUND_UNCERTAIN' and dedup_ref = v_request.id::text),
            'Estorno confirmado pelo PicPay.', p_actor_id);
        end if;
        -- Only a refund of the payment that confirmed the sale needs a sale reversal.
        v_refunded_applied := v_charge.paid_transaction_id is not null and v_charge.paid_transaction_id =
          coalesce(v_receipt.original_transaction_id, v_request.transaction_id, v_charge.paid_transaction_id);
        v_outcome := 'REFUND_RECORDED';
        if v_refunded_applied then
          v_recovery_id := private.open_payment_recovery('REFUND_CONFIRMED', v_receipt.transaction_id, v_receipt.id,
            v_charge.id, v_charge.sale_id, v_receipt.amount_cents, v_receipt.transaction_id,
            'Estorno confirmado pelo PicPay; registre a reversão correspondente da venda.');
        elsif v_request.id is null then
          v_recovery_id := private.open_payment_recovery('REFUND_CONFIRMED', v_receipt.transaction_id, v_receipt.id,
            v_charge.id, v_charge.sale_id, v_receipt.amount_cents, v_receipt.transaction_id,
            'Estorno confirmado pelo PicPay de um pagamento que não confirmou a venda; confira a devolução.');
        end if;
      end if;
    else
      select * into v_charge from public.payment_link_charges where provider_link_id = v_receipt.provider_link_id for update;
      if not found then
        v_outcome := 'RECOVERY_OPENED';
        v_recovery_id := private.open_payment_recovery('UNKNOWN_LINK', v_receipt.dedup_key, v_receipt.id, null, null,
          v_receipt.amount_cents, v_receipt.transaction_id,
          'Evento de um link de pagamento que não foi gerado por este sistema ou ainda não foi registrado.');
      elsif v_charge.paid_transaction_id = v_receipt.transaction_id then
        v_outcome := 'ALREADY_APPLIED';
        v_sale_id := v_charge.sale_id;
      elsif v_charge.status = 'PAID' then
        v_outcome := 'RECOVERY_OPENED';
        v_recovery_id := private.open_payment_recovery('DUPLICATE_PAYMENT', v_receipt.transaction_id, v_receipt.id,
          v_charge.id, v_charge.sale_id, v_receipt.amount_cents, v_receipt.transaction_id,
          'Segundo pagamento no mesmo link; a venda já foi confirmada. Avalie o estorno.');
      elsif v_receipt.amount_cents <> v_charge.amount_cents then
        v_outcome := 'RECOVERY_OPENED';
        v_recovery_id := private.open_payment_recovery('AMOUNT_MISMATCH', v_receipt.transaction_id, v_receipt.id,
          v_charge.id, v_charge.sale_id, v_receipt.amount_cents, v_receipt.transaction_id,
          'Valor pago diferente do valor do link; a venda não foi confirmada.');
      else
        select * into v_sale from public.sales where id = v_charge.sale_id for update;
        select * into v_attempt from public.payment_attempts where id = v_charge.attempt_id for update;
        v_sale_id := v_sale.id;
        if v_sale.status <> 'AWAITING_PAYMENT' or v_attempt.status <> 'CREATED' or v_charge.status <> 'ACTIVE' then
          v_outcome := 'RECOVERY_OPENED';
          v_recovery_id := private.open_payment_recovery(
            case when v_sale.status = 'CONFIRMED' then 'DUPLICATE_PAYMENT' else 'LATE_PAYMENT' end::public.payment_recovery_kind,
            v_receipt.transaction_id, v_receipt.id, v_charge.id, v_sale.id, v_receipt.amount_cents, v_receipt.transaction_id,
            case when v_sale.status = 'CONFIRMED'
              then 'A venda já tinha sido paga por outro meio; avalie o estorno do link.'
              else 'Pagamento recebido depois que a venda expirou ou foi cancelada; avalie estorno ou nova venda.' end);
        elsif v_attempt.amount_cents <> v_sale.total_cents or v_sale.total_cents <> v_charge.amount_cents then
          v_outcome := 'RECOVERY_OPENED';
          v_recovery_id := private.open_payment_recovery('AMOUNT_MISMATCH', v_receipt.transaction_id, v_receipt.id,
            v_charge.id, v_sale.id, v_receipt.amount_cents, v_receipt.transaction_id,
            'O total da venda mudou depois da geração do link; a venda não foi confirmada.');
        else
          v_actor := v_charge.requested_by;
          v_stock := private.consume_sale_reservation(v_sale.id, v_actor, v_charge.correlation_id);
          update public.payment_attempts
          set status = 'AWAITING_EXTERNAL_CONFIRMATION', integration_channel = 'PAYMENT_LINK',
              confirmation_source = v_receipt.source
          where id = v_attempt.id;
          insert into public.payment_attempt_status_history (attempt_id, from_status, to_status, actor_id, reason, correlation_id)
          values (v_attempt.id, 'CREATED', 'AWAITING_EXTERNAL_CONFIRMATION', v_actor,
            'Pagamento informado pelo PicPay (link de pagamento)', v_charge.correlation_id);
          update public.payment_attempts set status = 'APPROVED', confirmed_at = v_now where id = v_attempt.id;
          insert into public.payment_attempt_status_history (attempt_id, from_status, to_status, actor_id, reason, correlation_id)
          values (v_attempt.id, 'AWAITING_EXTERNAL_CONFIRMATION', 'APPROVED', v_actor,
            case when v_receipt.source = 'WEBHOOK' then 'Confirmado por webhook autenticado' else 'Confirmado por consulta oficial' end,
            v_charge.correlation_id);
          insert into public.financial_ledger_entries (sale_id, payment_attempt_id, entry_type, amount_cents, actor_id, correlation_id, metadata)
          values (v_sale.id, v_attempt.id, 'RECEIVABLE_PICPAY', v_sale.total_cents, v_actor, v_charge.correlation_id,
            jsonb_build_object('integration_channel', 'PAYMENT_LINK', 'confirmation_source', v_receipt.source,
              'provider_transaction_id', v_receipt.transaction_id, 'provider_link_id', v_charge.provider_link_id,
              'payment_type', v_receipt.payment_type))
          returning id into v_ledger_id;
          perform private.transition_sale_state(v_sale.id, 'CONFIRMED', v_actor, v_charge.correlation_id,
            'Pagamento por link de pagamento confirmado');
          update public.payment_link_charges
          set status = 'PAID', paid_transaction_id = v_receipt.transaction_id, worker_id = null, lease_expires_at = null
          where id = v_charge.id;
          insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
          values ('payments.payment_link.confirmed', v_actor, 'payment_attempt', v_attempt.id::text, v_charge.correlation_id,
            jsonb_build_object('sale_id', v_sale.id, 'charge_id', v_charge.id, 'receipt_id', v_receipt.id,
              'amount_cents', v_sale.total_cents, 'confirmation_source', v_receipt.source,
              'financial_ledger_entry_id', v_ledger_id));
          insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
          values ('payments.payment_link.confirmed', 'payment_attempt', v_attempt.id::text,
            jsonb_build_object('attempt_id', v_attempt.id, 'sale_id', v_sale.id, 'charge_id', v_charge.id,
              'integration_channel', 'PAYMENT_LINK', 'confirmation_source', v_receipt.source,
              'correlation_id', v_charge.correlation_id));
          v_outcome := 'APPLIED';
        end if;
      end if;
    end if;
  exception when others then
    v_outcome := 'RECOVERY_OPENED';
    v_sale_id := null;
    v_recovery_id := private.open_payment_recovery('APPLY_FAILED', v_receipt.id::text || ':' || sqlstate, v_receipt.id,
      null, null, v_receipt.amount_cents, v_receipt.transaction_id,
      'Falha ao aplicar o evento (' || left(sqlerrm, 120) || '); reprocesse depois de corrigir a causa.');
  end;

  insert into public.payment_webhook_outcomes (receipt_id, outcome, recovery_item_id, sale_id, actor_id)
  values (v_receipt.id, v_outcome, v_recovery_id, v_sale_id, p_actor_id);
  return jsonb_build_object('receipt_id', v_receipt.id, 'outcome', v_outcome,
    'recovery_item_id', v_recovery_id, 'sale_id', v_sale_id);
end;
$$;

-- Notices that arrived before the link was known are applied once it is.
create or replace function private.apply_pending_link_receipts(p_provider_link_id text, p_actor_id uuid)
returns integer language plpgsql set search_path = '' as $$
declare
  v_receipt_id uuid;
  v_count integer := 0;
begin
  for v_receipt_id in
    select receipt.id from public.payment_webhook_receipts receipt
    join lateral (select * from private.payment_link_receipt_outcome(receipt.id)) outcome on true
    join public.payment_recovery_items item on item.id = outcome.recovery_item_id
    where receipt.provider_link_id = p_provider_link_id and item.kind in ('UNKNOWN_LINK', 'UNMATCHED_REFUND')
      and item.status = 'OPEN'
    order by receipt.received_at, receipt.id
  loop
    perform private.apply_payment_link_receipt(v_receipt_id, p_actor_id);
    update public.payment_recovery_items
    set status = 'RESOLVED', resolved_at = clock_timestamp(), resolved_by = p_actor_id,
        resolution_note = 'Aplicado automaticamente quando o link foi registrado.'
    where receipt_id = v_receipt_id and kind in ('UNKNOWN_LINK', 'UNMATCHED_REFUND') and status = 'OPEN';
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.worker_record_payment_link_created(
  p_charge_id uuid, p_worker_id text, p_provider_link_id text, p_checkout_url text, p_brcode text, p_expires_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_charge public.payment_link_charges%rowtype;
begin
  perform private.assert_worker_role();
  v_charge := private.claimed_payment_link_charge(p_charge_id, p_worker_id);
  update public.payment_link_charges
  set status = 'ACTIVE', provider_link_id = p_provider_link_id, checkout_url = p_checkout_url, brcode = p_brcode,
      expires_at = p_expires_at, worker_id = null, lease_expires_at = null, error_code = null
  where id = v_charge.id
  returning * into v_charge;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.payment_link.created', v_charge.requested_by, 'payment_link_charge', v_charge.id::text,
    v_charge.correlation_id, jsonb_build_object('sale_id', v_charge.sale_id, 'provider_link_id', p_provider_link_id));
  perform private.apply_pending_link_receipts(p_provider_link_id, null);
  select * into v_charge from public.payment_link_charges where id = v_charge.id;
  return private.payment_link_charge_json(v_charge);
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_ALREADY_REGISTERED';
  when check_violation then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_LINK_DATA';
end;
$$;

-- Inactivation at the provider. Idempotent there (an already inactive link answers B038), so it is retried.
create or replace function public.worker_claim_payment_link_inactivations(
  p_worker_id text, p_limit integer default 10, p_lease_seconds integer default 120
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_charge public.payment_link_charges%rowtype;
  v_claims jsonb := '[]'::jsonb;
begin
  perform private.assert_worker_role();
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 128
    or p_limit not between 1 and 50 or p_lease_seconds not between 30 and 600 then
    raise exception using errcode = '22023', message = 'INVALID_CLAIM_WINDOW';
  end if;
  for v_charge in
    select * from public.payment_link_charges
    where inactivation_requested_at is not null and inactivated_at is null and status in ('ACTIVE', 'PAID')
      and provider_link_id is not null and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
    order by inactivation_requested_at, id for update skip locked limit p_limit
  loop
    update public.payment_link_charges
    set worker_id = p_worker_id, lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
        inactivation_attempts = inactivation_attempts + 1
    where id = v_charge.id;
    v_claims := v_claims || jsonb_build_array(jsonb_build_object('charge_id', v_charge.id, 'provider_link_id', v_charge.provider_link_id));
  end loop;
  return v_claims;
end;
$$;

create or replace function public.worker_record_payment_link_inactivation(p_charge_id uuid, p_worker_id text, p_error_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_charge public.payment_link_charges%rowtype;
begin
  perform private.assert_worker_role();
  if p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{2,64}$' then
    raise exception using errcode = '22023', message = 'INVALID_ERROR_CODE';
  end if;
  select * into v_charge from public.payment_link_charges where id = p_charge_id for update;
  if not found or v_charge.worker_id is distinct from p_worker_id or v_charge.inactivated_at is not null
    or v_charge.inactivation_requested_at is null then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_CLAIM_MISMATCH';
  end if;
  if p_error_code is null then
    update public.payment_link_charges
    set inactivated_at = clock_timestamp(), worker_id = null, lease_expires_at = null,
        status = case when status = 'ACTIVE' then 'INACTIVE' else status end
    where id = v_charge.id returning * into v_charge;
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('payments.payment_link.inactivated', v_charge.requested_by, 'payment_link_charge', v_charge.id::text,
      v_charge.correlation_id, jsonb_build_object('sale_id', v_charge.sale_id, 'status', v_charge.status));
  else
    update public.payment_link_charges set worker_id = null, lease_expires_at = null where id = v_charge.id
    returning * into v_charge;
    if v_charge.inactivation_attempts >= 8 then
      perform private.open_payment_recovery('INACTIVATION_FAILED', v_charge.id::text, null, v_charge.id, v_charge.sale_id,
        v_charge.amount_cents, null,
        'O link continua ativo no PicPay depois de várias tentativas de inativação; inative-o pelo painel.');
    end if;
  end if;
  return private.payment_link_charge_json(v_charge);
end;
$$;

-- Links whose transactions the worker reads: open ones every 2 minutes; closed ones for a day after closing, and
-- while a refund waits for confirmation, every 15 minutes.
create or replace function public.worker_claim_payment_link_status_checks(p_worker_id text, p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_charge public.payment_link_charges%rowtype;
  v_claims jsonb := '[]'::jsonb;
begin
  perform private.assert_worker_role();
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 128 or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_CLAIM_WINDOW';
  end if;
  for v_charge in
    select charge.* from public.payment_link_charges charge
    where charge.provider_link_id is not null and charge.created_at > clock_timestamp() - interval '30 days'
      and (
        (charge.status = 'ACTIVE' and coalesce(charge.last_status_check_at, '-infinity') < clock_timestamp() - interval '2 minutes')
        or (coalesce(charge.last_status_check_at, '-infinity') < clock_timestamp() - interval '15 minutes' and (
          charge.closed_at > clock_timestamp() - interval '1 day'
          or exists (select 1 from public.payment_link_refund_requests refund
            where refund.charge_id = charge.id and refund.status in ('REQUESTED', 'ACCEPTED', 'UNCERTAIN'))))
      )
    order by charge.last_status_check_at nulls first, charge.id
    for update skip locked limit p_limit
  loop
    update public.payment_link_charges set last_status_check_at = clock_timestamp() where id = v_charge.id;
    v_claims := v_claims || jsonb_build_array(jsonb_build_object('charge_id', v_charge.id, 'provider_link_id', v_charge.provider_link_id));
  end loop;
  return v_claims;
end;
$$;

create or replace function public.request_payment_link_refund(
  p_transaction_id text, p_amount_cents bigint, p_reason text, p_recovery_item_id uuid,
  p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_receipt public.payment_webhook_receipts%rowtype;
  v_charge public.payment_link_charges%rowtype;
  v_item public.payment_recovery_items%rowtype;
  v_request public.payment_link_refund_requests%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_committed bigint;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_REQUIRED';
  end if;
  if p_correlation_id is null or char_length(v_reason) not between 3 and 300
    or p_amount_cents is null or p_amount_cents not between 1 and 999999998 then
    raise exception using errcode = '22023', message = 'INVALID_REFUND_REQUEST';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'payment_link_refund', v_actor_id), p_idempotency_key,
    jsonb_build_object('transaction_id', p_transaction_id, 'amount_cents', p_amount_cents, 'reason', v_reason,
      'recovery_item_id', p_recovery_item_id)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  -- Only a payment the provider reported can be refunded, and never beyond what it paid.
  select * into v_receipt from public.payment_webhook_receipts
  where event_kind = 'PAYMENT' and transaction_status = 'PAYED' and transaction_id = p_transaction_id
  order by received_at limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_TRANSACTION_NOT_FOUND';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('payment_link_refund:' || p_transaction_id, 0));
  select coalesce(sum(amount_cents), 0) into v_committed from public.payment_link_refund_requests
  where transaction_id = p_transaction_id and status <> 'FAILED';
  if v_committed + p_amount_cents > v_receipt.amount_cents then
    raise exception using errcode = 'P0001', message = 'REFUND_EXCEEDS_PAYMENT';
  end if;
  if p_recovery_item_id is not null then
    select * into v_item from public.payment_recovery_items where id = p_recovery_item_id for update;
    if not found or v_item.status <> 'OPEN' or v_item.transaction_id is distinct from p_transaction_id then
      raise exception using errcode = 'P0001', message = 'PAYMENT_RECOVERY_NOT_FOUND';
    end if;
  end if;
  select * into v_charge from public.payment_link_charges where provider_link_id = v_receipt.provider_link_id;

  insert into public.payment_link_refund_requests (transaction_id, charge_id, sale_id, amount_cents, reason,
    source_recovery_item_id, requested_by, correlation_id)
  values (p_transaction_id, v_charge.id, v_charge.sale_id, p_amount_cents, v_reason, p_recovery_item_id,
    v_actor_id, p_correlation_id)
  returning * into v_request;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.payment_link.refund_requested', v_actor_id, 'payment_link_refund_request', v_request.id::text,
    p_correlation_id, jsonb_build_object('transaction_id', p_transaction_id, 'amount_cents', p_amount_cents,
      'sale_id', v_charge.sale_id, 'recovery_item_id', p_recovery_item_id));
  v_result := private.payment_link_refund_json(v_request);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_link_refund_request', v_request.id::text);
  return v_result;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'REFUND_ALREADY_IN_PROGRESS';
end;
$$;

-- Refunds are submitted once. A claim whose worker vanished may have reached the provider: uncertain, not resubmitted.
create or replace function public.worker_claim_payment_link_refunds(
  p_worker_id text, p_limit integer default 10, p_lease_seconds integer default 120
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_request public.payment_link_refund_requests%rowtype;
  v_claims jsonb := '[]'::jsonb;
begin
  perform private.assert_worker_role();
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 128
    or p_limit not between 1 and 50 or p_lease_seconds not between 30 and 600 then
    raise exception using errcode = '22023', message = 'INVALID_CLAIM_WINDOW';
  end if;
  for v_request in
    select * from public.payment_link_refund_requests
    where status = 'REQUESTED' and attempts > 0 and lease_expires_at <= clock_timestamp()
    order by created_at for update skip locked limit 50
  loop
    update public.payment_link_refund_requests
    set status = 'UNCERTAIN', error_code = 'WORKER_LEASE_EXPIRED', worker_id = null, lease_expires_at = null
    where id = v_request.id;
    perform private.open_payment_recovery('REFUND_UNCERTAIN', v_request.id::text, null, v_request.charge_id,
      v_request.sale_id, v_request.amount_cents, v_request.transaction_id,
      'O worker não confirmou o envio do estorno; confira no painel PicPay antes de pedir outro.');
  end loop;
  for v_request in
    select * from public.payment_link_refund_requests
    where status = 'REQUESTED' and attempts = 0
    order by created_at for update skip locked limit p_limit
  loop
    update public.payment_link_refund_requests
    set attempts = attempts + 1, worker_id = p_worker_id,
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where id = v_request.id;
    v_claims := v_claims || jsonb_build_array(jsonb_build_object('refund_id', v_request.id,
      'transaction_id', v_request.transaction_id, 'amount_cents', v_request.amount_cents));
  end loop;
  return v_claims;
end;
$$;

create or replace function public.worker_record_payment_link_refund(
  p_refund_id uuid, p_worker_id text, p_outcome text, p_provider_refund_id text, p_original_amount_cents bigint, p_error_code text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_request public.payment_link_refund_requests%rowtype;
begin
  perform private.assert_worker_role();
  if p_outcome not in ('ACCEPTED', 'FAILED', 'UNCERTAIN')
    or (p_outcome <> 'ACCEPTED' and (p_error_code is null or p_error_code !~ '^[A-Z0-9_]{2,64}$'))
    or (p_provider_refund_id is not null and p_provider_refund_id !~ '^[A-Za-z0-9-]{8,64}$') then
    raise exception using errcode = '22023', message = 'INVALID_REFUND_OUTCOME';
  end if;
  select * into v_request from public.payment_link_refund_requests where id = p_refund_id for update;
  if not found or v_request.status <> 'REQUESTED' or v_request.worker_id is distinct from p_worker_id then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_CLAIM_MISMATCH';
  end if;
  update public.payment_link_refund_requests
  set status = p_outcome::public.payment_link_refund_status, provider_refund_id = p_provider_refund_id,
      provider_original_amount_cents = p_original_amount_cents,
      error_code = case when p_outcome = 'ACCEPTED' then null else p_error_code end,
      worker_id = null, lease_expires_at = null
  where id = v_request.id returning * into v_request;
  if p_outcome = 'UNCERTAIN' then
    perform private.open_payment_recovery('REFUND_UNCERTAIN', v_request.id::text, null, v_request.charge_id,
      v_request.sale_id, v_request.amount_cents, v_request.transaction_id,
      'O PicPay não respondeu ao pedido de estorno; confira no painel antes de pedir outro.');
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.payment_link.refund_submitted', v_request.requested_by, 'payment_link_refund_request',
    v_request.id::text, v_request.correlation_id, jsonb_build_object('outcome', p_outcome, 'error_code', p_error_code));
  return private.payment_link_refund_json(v_request);
end;
$$;

-- Finance settles an uncertain link: found in the PicPay panel (becomes active and catches up on notices) or
-- confirmed never created (fails, so the seller may ask again).
create or replace function public.reconcile_uncertain_payment_link(
  p_charge_id uuid, p_provider_link_id text, p_checkout_url text, p_note text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_charge public.payment_link_charges%rowtype;
  v_sale public.sales%rowtype;
  v_note text := btrim(coalesce(p_note, ''));
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_REQUIRED';
  end if;
  if p_correlation_id is null or char_length(v_note) not between 3 and 500
    or ((p_provider_link_id is null) <> (p_checkout_url is null)) then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'payment_link_reconcile', v_actor_id), p_idempotency_key,
    jsonb_build_object('charge_id', p_charge_id, 'provider_link_id', p_provider_link_id, 'note', v_note)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select * into v_charge from public.payment_link_charges where id = p_charge_id for update;
  if not found or v_charge.status <> 'UNCERTAIN' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_NOT_UNCERTAIN';
  end if;
  select * into v_sale from public.sales where id = v_charge.sale_id;
  if p_provider_link_id is null then
    update public.payment_link_charges set status = 'FAILED', error_code = 'NOT_CREATED_CONFIRMED'
    where id = v_charge.id returning * into v_charge;
  else
    update public.payment_link_charges
    set status = 'ACTIVE', provider_link_id = p_provider_link_id, checkout_url = p_checkout_url, error_code = null,
        inactivation_requested_at = case when v_sale.status <> 'AWAITING_PAYMENT'
          then coalesce(inactivation_requested_at, clock_timestamp()) else inactivation_requested_at end
    where id = v_charge.id returning * into v_charge;
    perform private.apply_pending_link_receipts(p_provider_link_id, v_actor_id);
    select * into v_charge from public.payment_link_charges where id = v_charge.id;
  end if;
  perform private.resolve_payment_recovery(
    (select id from public.payment_recovery_items where kind = 'UNCERTAIN_CREATION' and dedup_ref = v_charge.id::text),
    v_note, v_actor_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.payment_link.reconciled', v_actor_id, 'payment_link_charge', v_charge.id::text, p_correlation_id,
    jsonb_build_object('found', p_provider_link_id is not null, 'status', v_charge.status, 'note', v_note));
  v_result := private.payment_link_charge_json(v_charge);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_link_charge', v_charge.id::text);
  return v_result;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_ALREADY_REGISTERED';
  when check_violation then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION';
end;
$$;

-- Finance settles an uncertain refund: seen in the PicPay panel (waits for the provider event) or not processed
-- (fails, so a new refund can be asked).
create or replace function public.reconcile_uncertain_payment_link_refund(
  p_refund_id uuid, p_processed boolean, p_note text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_request public.payment_link_refund_requests%rowtype;
  v_note text := btrim(coalesce(p_note, ''));
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_REQUIRED';
  end if;
  if p_correlation_id is null or p_processed is null or char_length(v_note) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'payment_link_refund_reconcile', v_actor_id), p_idempotency_key,
    jsonb_build_object('refund_id', p_refund_id, 'processed', p_processed, 'note', v_note)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select * into v_request from public.payment_link_refund_requests where id = p_refund_id for update;
  if not found or v_request.status <> 'UNCERTAIN' then
    raise exception using errcode = 'P0001', message = 'REFUND_NOT_UNCERTAIN';
  end if;
  update public.payment_link_refund_requests
  set status = case when p_processed then 'ACCEPTED' else 'FAILED' end::public.payment_link_refund_status,
      error_code = case when p_processed then null else 'NOT_PROCESSED_CONFIRMED' end
  where id = v_request.id returning * into v_request;
  perform private.resolve_payment_recovery(
    (select id from public.payment_recovery_items where kind = 'REFUND_UNCERTAIN' and dedup_ref = v_request.id::text),
    v_note, v_actor_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.payment_link.refund_reconciled', v_actor_id, 'payment_link_refund_request', v_request.id::text,
    p_correlation_id, jsonb_build_object('processed', p_processed, 'note', v_note));
  v_result := private.payment_link_refund_json(v_request);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_link_refund_request', v_request.id::text);
  return v_result;
end;
$$;

alter table public.payment_link_refund_requests enable row level security;
revoke all on table public.payment_link_refund_requests from public, anon, authenticated, service_role;

revoke all on function private.close_payment_links_for_sale() from public, anon, authenticated, service_role;
revoke all on function private.guard_payment_link_refund_request() from public, anon, authenticated, service_role;
revoke all on function private.payment_link_refund_json(public.payment_link_refund_requests) from public, anon, authenticated, service_role;
revoke all on function private.resolve_payment_recovery(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.apply_pending_link_receipts(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.worker_claim_payment_link_inactivations(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.worker_record_payment_link_inactivation(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.worker_claim_payment_link_status_checks(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.request_payment_link_refund(text, bigint, text, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.worker_claim_payment_link_refunds(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.worker_record_payment_link_refund(uuid, text, text, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.reconcile_uncertain_payment_link(uuid, text, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reconcile_uncertain_payment_link_refund(uuid, boolean, text, text, uuid) from public, anon, authenticated, service_role;

grant execute on function public.request_payment_link_refund(text, bigint, text, uuid, text, uuid) to authenticated;
grant execute on function public.reconcile_uncertain_payment_link(uuid, text, text, text, text, uuid) to authenticated;
grant execute on function public.reconcile_uncertain_payment_link_refund(uuid, boolean, text, text, uuid) to authenticated;
grant execute on function public.worker_claim_payment_link_inactivations(text, integer, integer) to service_role;
grant execute on function public.worker_record_payment_link_inactivation(uuid, text, text) to service_role;
grant execute on function public.worker_claim_payment_link_status_checks(text, integer) to service_role;
grant execute on function public.worker_claim_payment_link_refunds(text, integer, integer) to service_role;
grant execute on function public.worker_record_payment_link_refund(uuid, text, text, text, bigint, text) to service_role;
