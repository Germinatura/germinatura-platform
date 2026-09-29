-- ADR 0010, PAY-004 and PAY-007: PicPay Payment Link foundation, built before sandbox access and kept fail-closed.
-- A seller asks for a link for a pending sale; the intent is persisted here before any provider call. The jobs
-- worker (the only holder of provider credentials) creates the link and records the result, or marks it uncertain
-- when the provider may have created it without answering (no remote idempotency is documented, so it is never
-- retried blindly). Webhook deliveries are stored raw and immutable, deduplicated by transaction and status, and
-- applied once: a payment confirms the sale with the same effects as the manual channels (stock, receivable, sale
-- CONFIRMED). Unknown links, divergent amounts, late or duplicate payments and provider refunds open recovery
-- items for finance instead of producing revenue. Finance can replay a receipt; effects stay exactly-once.

insert into public.feature_flags (key, description, enabled)
values ('payment_link', 'Link de pagamento PicPay; ligar somente após homologação do sandbox', false);

create type public.payment_link_charge_status as enum ('REQUESTED', 'ACTIVE', 'FAILED', 'UNCERTAIN', 'PAID', 'INACTIVE');
create type public.payment_recovery_kind as enum (
  'UNKNOWN_LINK', 'AMOUNT_MISMATCH', 'LATE_PAYMENT', 'DUPLICATE_PAYMENT', 'UNCERTAIN_CREATION',
  'REFUND_CONFIRMED', 'UNMATCHED_REFUND', 'UNSUPPORTED_EVENT', 'APPLY_FAILED'
);
create type public.payment_webhook_outcome as enum ('APPLIED', 'ALREADY_APPLIED', 'RECOVERY_OPENED', 'REFUND_RECORDED');

create table public.payment_link_charges (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  attempt_id uuid not null references public.payment_attempts(id) on delete restrict,
  amount_cents bigint not null,
  order_number text not null unique,
  status public.payment_link_charge_status not null default 'REQUESTED',
  provider_link_id text unique,
  checkout_url text,
  brcode text,
  expires_at timestamptz,
  paid_transaction_id text unique,
  error_code text,
  worker_id text,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  -- The provider accepts at most R$ 9.999.999,99 and an order number of up to 15 characters.
  constraint payment_link_charges_amount_valid check (amount_cents between 1 and 999999999),
  constraint payment_link_charges_order_number_valid check (order_number ~ '^G[0-9A-F]{14}$'),
  constraint payment_link_charges_link_id_valid check (provider_link_id is null or provider_link_id ~ '^[A-Za-z0-9-]{8,64}$'),
  constraint payment_link_charges_checkout_valid check (checkout_url is null or (checkout_url ~ '^https://' and char_length(checkout_url) <= 1000)),
  constraint payment_link_charges_brcode_valid check (brcode is null or char_length(brcode) <= 2048),
  constraint payment_link_charges_error_valid check (error_code is null or error_code ~ '^[A-Z0-9_]{2,64}$'),
  constraint payment_link_charges_link_present check (
    status not in ('ACTIVE', 'PAID', 'INACTIVE') or (provider_link_id is not null and checkout_url is not null)
  ),
  constraint payment_link_charges_paid_transaction check ((status = 'PAID') = (paid_transaction_id is not null))
);

-- One open link per payment attempt; a failed request can be asked again.
create unique index payment_link_charges_open_attempt_unique
  on public.payment_link_charges (attempt_id) where status in ('REQUESTED', 'ACTIVE', 'UNCERTAIN');
create index payment_link_charges_requested_idx on public.payment_link_charges (created_at) where status = 'REQUESTED';
create index payment_link_charges_sale_idx on public.payment_link_charges (sale_id, created_at desc);

create table public.payment_link_charge_events (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.payment_link_charges(id) on delete restrict,
  from_status public.payment_link_charge_status,
  to_status public.payment_link_charge_status not null,
  error_code text,
  created_at timestamptz not null default clock_timestamp()
);
create index payment_link_charge_events_charge_idx on public.payment_link_charge_events (charge_id, created_at);

-- Raw provider events, kept as received. Normalized columns are null when the payload is not understood.
create table public.payment_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'PICPAY_PAYMENT_LINK',
  source public.payment_confirmation_source not null,
  event_type text,
  event_kind text,
  provider_link_id text,
  transaction_id text,
  original_transaction_id text,
  transaction_status text,
  amount_cents bigint,
  payment_type text,
  dedup_key text not null unique,
  payload jsonb not null,
  received_at timestamptz not null default clock_timestamp(),
  constraint payment_webhook_receipts_provider_valid check (provider = 'PICPAY_PAYMENT_LINK'),
  constraint payment_webhook_receipts_source_valid check (source in ('WEBHOOK', 'STATUS_QUERY')),
  constraint payment_webhook_receipts_kind_valid check (event_kind is null or event_kind in ('PAYMENT', 'REFUND')),
  constraint payment_webhook_receipts_event_type_valid check (event_type is null or char_length(event_type) <= 64),
  constraint payment_webhook_receipts_amount_valid check (amount_cents is null or amount_cents between 0 and 999999999),
  constraint payment_webhook_receipts_payload_size check (pg_column_size(payload) <= 65536)
);
create index payment_webhook_receipts_link_idx on public.payment_webhook_receipts (provider_link_id, received_at);

-- Every authenticated delivery, including repeated ones.
create table public.payment_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.payment_webhook_receipts(id) on delete restrict,
  duplicate boolean not null,
  received_at timestamptz not null default clock_timestamp()
);
create index payment_webhook_deliveries_receipt_idx on public.payment_webhook_deliveries (receipt_id, received_at);

create table public.payment_recovery_items (
  id uuid primary key default gen_random_uuid(),
  kind public.payment_recovery_kind not null,
  dedup_ref text not null,
  status text not null default 'OPEN',
  receipt_id uuid references public.payment_webhook_receipts(id) on delete restrict,
  charge_id uuid references public.payment_link_charges(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  amount_cents bigint,
  transaction_id text,
  detail text not null,
  opened_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete restrict,
  resolution_note text,
  constraint payment_recovery_items_status_valid check (status in ('OPEN', 'RESOLVED')),
  constraint payment_recovery_items_resolution_valid check (
    (status = 'OPEN' and resolved_at is null and resolved_by is null and resolution_note is null)
    or (status = 'RESOLVED' and resolved_at is not null and resolution_note is not null
      and char_length(resolution_note) between 3 and 500 and resolution_note = btrim(resolution_note))
  ),
  constraint payment_recovery_items_unique unique (kind, dedup_ref)
);
create index payment_recovery_items_open_idx on public.payment_recovery_items (opened_at) where status = 'OPEN';

create table public.payment_webhook_outcomes (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.payment_webhook_receipts(id) on delete restrict,
  outcome public.payment_webhook_outcome not null,
  recovery_item_id uuid references public.payment_recovery_items(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  actor_id uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);
create index payment_webhook_outcomes_receipt_idx on public.payment_webhook_outcomes (receipt_id, created_at desc, id desc);

-- Refunds confirmed by the provider. Linking them to the sale reversal is a finance step.
create table public.payment_link_provider_refunds (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null unique references public.payment_webhook_receipts(id) on delete restrict,
  charge_id uuid references public.payment_link_charges(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  refund_transaction_id text not null unique,
  original_transaction_id text,
  amount_cents bigint not null,
  provider_status text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint payment_link_provider_refunds_status_valid check (provider_status in ('REFUNDED', 'PARTREFUNDED')),
  constraint payment_link_provider_refunds_amount_valid check (amount_cents between 1 and 999999999)
);

create or replace function private.prevent_payment_link_record_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_RECORD_IMMUTABLE';
end;
$$;

create trigger payment_link_charge_events_immutable before update or delete on public.payment_link_charge_events
for each row execute function private.prevent_payment_link_record_change();
create trigger payment_webhook_receipts_immutable before update or delete on public.payment_webhook_receipts
for each row execute function private.prevent_payment_link_record_change();
create trigger payment_webhook_deliveries_immutable before update or delete on public.payment_webhook_deliveries
for each row execute function private.prevent_payment_link_record_change();
create trigger payment_webhook_outcomes_immutable before update or delete on public.payment_webhook_outcomes
for each row execute function private.prevent_payment_link_record_change();
create trigger payment_link_provider_refunds_immutable before update or delete on public.payment_link_provider_refunds
for each row execute function private.prevent_payment_link_record_change();

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
    or (old.provider_link_id is not null and new.provider_link_id is distinct from old.provider_link_id) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_RECORD_IMMUTABLE';
  end if;
  if new.status <> old.status and not (
    (old.status = 'REQUESTED' and new.status in ('ACTIVE', 'FAILED', 'UNCERTAIN'))
    or (old.status = 'UNCERTAIN' and new.status in ('ACTIVE', 'FAILED'))
    or (old.status = 'ACTIVE' and new.status in ('PAID', 'INACTIVE'))
  ) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_TRANSITION_INVALID';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger payment_link_charges_guard before insert or update or delete on public.payment_link_charges
for each row execute function private.guard_payment_link_charge();

create or replace function private.record_payment_link_charge_event()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status <> old.status then
    insert into public.payment_link_charge_events (charge_id, from_status, to_status, error_code)
    values (new.id, case when tg_op = 'INSERT' then null else old.status end, new.status, new.error_code);
  end if;
  return new;
end;
$$;

create trigger payment_link_charges_history after insert or update on public.payment_link_charges
for each row execute function private.record_payment_link_charge_event();

create or replace function private.guard_payment_recovery_item()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_RECORD_IMMUTABLE';
  end if;
  if old.status <> 'OPEN' or new.status <> 'RESOLVED'
    or new.kind <> old.kind or new.dedup_ref <> old.dedup_ref or new.detail <> old.detail
    or new.receipt_id is distinct from old.receipt_id or new.charge_id is distinct from old.charge_id
    or new.sale_id is distinct from old.sale_id or new.amount_cents is distinct from old.amount_cents
    or new.transaction_id is distinct from old.transaction_id or new.opened_at <> old.opened_at then
    raise exception using errcode = 'P0001', message = 'PAYMENT_RECOVERY_TRANSITION_INVALID';
  end if;
  return new;
end;
$$;

create trigger payment_recovery_items_guard before update or delete on public.payment_recovery_items
for each row execute function private.guard_payment_recovery_item();

create or replace function private.payment_link_charge_json(p_charge public.payment_link_charges)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'charge_id', p_charge.id, 'sale_id', p_charge.sale_id, 'attempt_id', p_charge.attempt_id,
    'amount_cents', p_charge.amount_cents, 'order_number', p_charge.order_number, 'status', p_charge.status,
    'checkout_url', p_charge.checkout_url, 'brcode', p_charge.brcode, 'expires_at', p_charge.expires_at,
    'error_code', p_charge.error_code, 'created_at', p_charge.created_at, 'updated_at', p_charge.updated_at
  );
$$;

-- Opens (or finds) the recovery item for one problem; the same problem never opens twice.
create or replace function private.open_payment_recovery(
  p_kind public.payment_recovery_kind, p_dedup_ref text, p_receipt_id uuid, p_charge_id uuid, p_sale_id uuid,
  p_amount_cents bigint, p_transaction_id text, p_detail text
)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.payment_recovery_items
    (kind, dedup_ref, receipt_id, charge_id, sale_id, amount_cents, transaction_id, detail)
  values (p_kind, p_dedup_ref, p_receipt_id, p_charge_id, p_sale_id, p_amount_cents, p_transaction_id, p_detail)
  on conflict (kind, dedup_ref) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.payment_recovery_items where kind = p_kind and dedup_ref = p_dedup_ref;
  end if;
  return v_id;
end;
$$;

create or replace function public.request_payment_link(
  p_sale_id uuid, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_charge public.payment_link_charges%rowtype;
  v_claim record;
  v_result jsonb;
  v_id uuid := gen_random_uuid();
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;
  perform private.require_feature('payment_link');

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.created_by <> v_actor_id or v_sale.channel not in ('PDV', 'RESERVA') then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;

  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'payment_link_request', v_actor_id), p_idempotency_key,
    jsonb_build_object('sale_id', p_sale_id)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  if v_sale.status <> 'AWAITING_PAYMENT' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_AWAITING_PAYMENT';
  end if;
  select * into v_attempt from public.payment_attempts
  where sale_id = p_sale_id order by created_at desc, id desc limit 1 for update;
  if not found or v_attempt.operator_id <> v_actor_id or v_attempt.status <> 'CREATED' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_CONFIRMABLE';
  end if;
  if v_attempt.amount_cents <> v_sale.total_cents or v_sale.total_cents not between 1 and 999999999 then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AMOUNT_MISMATCH';
  end if;

  select * into v_charge from public.payment_link_charges
  where attempt_id = v_attempt.id and status in ('REQUESTED', 'ACTIVE', 'UNCERTAIN');
  if not found then
    insert into public.payment_link_charges
      (id, sale_id, attempt_id, amount_cents, order_number, requested_by, correlation_id)
    values (v_id, v_sale.id, v_attempt.id, v_sale.total_cents,
      'G' || upper(substr(replace(v_id::text, '-', ''), 1, 14)), v_actor_id, p_correlation_id)
    returning * into v_charge;
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('payments.payment_link.requested', v_actor_id, 'payment_link_charge', v_charge.id::text, p_correlation_id,
      jsonb_build_object('sale_id', v_sale.id, 'attempt_id', v_attempt.id, 'amount_cents', v_charge.amount_cents));
  end if;

  v_result := private.payment_link_charge_json(v_charge);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_link_charge', v_charge.id::text);
  return v_result;
end;
$$;

create or replace function public.get_payment_link_charge(p_charge_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_charge public.payment_link_charges%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into v_charge from public.payment_link_charges where id = p_charge_id;
  if not found or (v_charge.requested_by <> auth.uid() and not public.has_permission('finance.manage')) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_NOT_FOUND';
  end if;
  return private.payment_link_charge_json(v_charge);
end;
$$;

-- Hands requested links to the worker. A request whose lease expired after a claim may already exist at the
-- provider, so it becomes UNCERTAIN for finance instead of being created again.
create or replace function public.worker_claim_payment_link_requests(
  p_worker_id text, p_limit integer default 10, p_lease_seconds integer default 120
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_charge public.payment_link_charges%rowtype;
  v_sale public.sales%rowtype;
  v_expires timestamptz;
  v_claims jsonb := '[]'::jsonb;
begin
  perform private.assert_worker_role();
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'INVALID_WORKER_ID';
  end if;
  if p_limit not between 1 and 50 or p_lease_seconds not between 30 and 600 then
    raise exception using errcode = '22023', message = 'INVALID_CLAIM_WINDOW';
  end if;

  for v_charge in
    select * from public.payment_link_charges
    where status = 'REQUESTED' and attempts > 0 and lease_expires_at <= clock_timestamp()
    order by created_at for update skip locked limit 50
  loop
    update public.payment_link_charges
    set status = 'UNCERTAIN', error_code = 'WORKER_LEASE_EXPIRED', worker_id = null, lease_expires_at = null
    where id = v_charge.id;
    perform private.open_payment_recovery('UNCERTAIN_CREATION', v_charge.id::text, null, v_charge.id,
      v_charge.sale_id, v_charge.amount_cents, null,
      'O worker não confirmou a criação do link; confira no painel PicPay se ele existe antes de gerar outro.');
  end loop;

  if not public.is_feature_enabled('payment_link') then
    return v_claims;
  end if;

  for v_charge in
    select * from public.payment_link_charges
    where status = 'REQUESTED' and attempts = 0
    order by created_at for update skip locked limit p_limit
  loop
    select * into v_sale from public.sales where id = v_charge.sale_id;
    if v_sale.status <> 'AWAITING_PAYMENT' then
      update public.payment_link_charges set status = 'FAILED', error_code = 'SALE_NOT_AWAITING_PAYMENT'
      where id = v_charge.id;
      continue;
    end if;
    select min(expires_at) into v_expires from public.stock_reservations
    where origin_type = 'sale' and origin_id = v_sale.id::text and status = 'ACTIVE';
    update public.payment_link_charges
    set attempts = attempts + 1, worker_id = p_worker_id,
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where id = v_charge.id;
    v_claims := v_claims || jsonb_build_array(jsonb_build_object(
      'charge_id', v_charge.id, 'order_number', v_charge.order_number, 'amount_cents', v_charge.amount_cents,
      'name', 'Germinatura ' || v_charge.order_number,
      -- The provider takes a calendar date; the sale hold (Brasília time) bounds it.
      'expires_on', to_char(coalesce(v_expires, clock_timestamp()) at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')
    ));
  end loop;
  return v_claims;
end;
$$;

create or replace function private.claimed_payment_link_charge(p_charge_id uuid, p_worker_id text)
returns public.payment_link_charges language plpgsql set search_path = '' as $$
declare v_charge public.payment_link_charges%rowtype;
begin
  select * into v_charge from public.payment_link_charges where id = p_charge_id for update;
  if not found or v_charge.status <> 'REQUESTED' or v_charge.worker_id is distinct from p_worker_id then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_CLAIM_MISMATCH';
  end if;
  return v_charge;
end;
$$;

create or replace function private.payment_link_receipt_outcome(p_receipt_id uuid)
returns public.payment_webhook_outcomes language sql stable set search_path = '' as $$
  select * from public.payment_webhook_outcomes where receipt_id = p_receipt_id
  order by created_at desc, id desc limit 1;
$$;

-- Applies one stored event. Effects are exactly-once: the paid transaction id is unique per charge and every
-- other case only opens (or finds) a recovery item. Any unexpected failure rolls back the partial effects and
-- keeps the receipt with an APPLY_FAILED recovery item.
create or replace function private.apply_payment_link_receipt(p_receipt_id uuid, p_actor_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_receipt public.payment_webhook_receipts%rowtype;
  v_charge public.payment_link_charges%rowtype;
  v_sale public.sales%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_outcome public.payment_webhook_outcome;
  v_recovery_id uuid;
  v_sale_id uuid;
  v_actor uuid;
  v_ledger_id uuid;
  v_stock jsonb;
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
    else
      select * into v_charge from public.payment_link_charges where provider_link_id = v_receipt.provider_link_id for update;
      if not found then
        v_outcome := 'RECOVERY_OPENED';
        v_recovery_id := private.open_payment_recovery(
          case when v_receipt.event_kind = 'REFUND' then 'UNMATCHED_REFUND' else 'UNKNOWN_LINK' end::public.payment_recovery_kind,
          v_receipt.dedup_key, v_receipt.id, null, null, v_receipt.amount_cents, v_receipt.transaction_id,
          'Evento de um link de pagamento que não foi gerado por este sistema ou ainda não foi registrado.');
      elsif v_receipt.event_kind = 'REFUND' then
        v_sale_id := v_charge.sale_id;
        insert into public.payment_link_provider_refunds (receipt_id, charge_id, sale_id, refund_transaction_id,
          original_transaction_id, amount_cents, provider_status)
        values (v_receipt.id, v_charge.id, v_charge.sale_id, v_receipt.transaction_id,
          v_receipt.original_transaction_id, v_receipt.amount_cents, v_receipt.transaction_status)
        on conflict (refund_transaction_id) do nothing;
        v_outcome := 'REFUND_RECORDED';
        v_recovery_id := private.open_payment_recovery('REFUND_CONFIRMED', v_receipt.transaction_id, v_receipt.id,
          v_charge.id, v_charge.sale_id, v_receipt.amount_cents, v_receipt.transaction_id,
          case when v_receipt.original_transaction_id is not null
            and v_receipt.original_transaction_id is distinct from v_charge.paid_transaction_id
            then 'Estorno confirmado pelo PicPay de um pagamento que não confirmou a venda; confira a devolução.'
            else 'Estorno confirmado pelo PicPay; registre a reversão correspondente da venda.' end);
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
        if v_sale.status <> 'AWAITING_PAYMENT' or v_attempt.status <> 'CREATED' then
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

create or replace function public.worker_record_payment_link_created(
  p_charge_id uuid, p_worker_id text, p_provider_link_id text, p_checkout_url text, p_brcode text, p_expires_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_charge public.payment_link_charges%rowtype;
  v_receipt_id uuid;
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

  -- A payment notice can arrive before the creation is recorded; apply it now that the link is known.
  for v_receipt_id in
    select receipt.id from public.payment_webhook_receipts receipt
    join lateral (select * from private.payment_link_receipt_outcome(receipt.id)) outcome on true
    join public.payment_recovery_items item on item.id = outcome.recovery_item_id
    where receipt.provider_link_id = p_provider_link_id and item.kind in ('UNKNOWN_LINK', 'UNMATCHED_REFUND')
      and item.status = 'OPEN'
    order by receipt.received_at
  loop
    perform private.apply_payment_link_receipt(v_receipt_id, null);
    update public.payment_recovery_items
    set status = 'RESOLVED', resolved_at = clock_timestamp(),
        resolution_note = 'Aplicado automaticamente quando a criação do link foi registrada.'
    where receipt_id = v_receipt_id and kind in ('UNKNOWN_LINK', 'UNMATCHED_REFUND') and status = 'OPEN';
  end loop;
  return private.payment_link_charge_json(v_charge);
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'PAYMENT_LINK_ALREADY_REGISTERED';
  when check_violation then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_LINK_DATA';
end;
$$;

create or replace function public.worker_record_payment_link_failure(
  p_charge_id uuid, p_worker_id text, p_uncertain boolean, p_error_code text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_charge public.payment_link_charges%rowtype;
begin
  perform private.assert_worker_role();
  if p_error_code is null or p_error_code !~ '^[A-Z0-9_]{2,64}$' then
    raise exception using errcode = '22023', message = 'INVALID_ERROR_CODE';
  end if;
  v_charge := private.claimed_payment_link_charge(p_charge_id, p_worker_id);
  update public.payment_link_charges
  set status = case when p_uncertain then 'UNCERTAIN' else 'FAILED' end::public.payment_link_charge_status,
      error_code = p_error_code, worker_id = null, lease_expires_at = null
  where id = v_charge.id
  returning * into v_charge;
  if p_uncertain then
    perform private.open_payment_recovery('UNCERTAIN_CREATION', v_charge.id::text, null, v_charge.id, v_charge.sale_id,
      v_charge.amount_cents, null,
      'O PicPay não respondeu à criação do link; confira no painel se ele existe antes de gerar outro.');
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.payment_link.failed', v_charge.requested_by, 'payment_link_charge', v_charge.id::text,
    v_charge.correlation_id, jsonb_build_object('sale_id', v_charge.sale_id, 'uncertain', p_uncertain, 'error_code', p_error_code));
  return private.payment_link_charge_json(v_charge);
end;
$$;

-- Stores one authenticated delivery (webhook or official status query) and applies it once.
create or replace function public.worker_record_payment_link_event(
  p_source public.payment_confirmation_source, p_event_type text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_transaction jsonb;
  v_charge jsonb;
  v_kind text;
  v_link text;
  v_transaction_id text;
  v_status text;
  v_amount bigint;
  v_dedup text;
  v_receipt_id uuid;
  v_outcome public.payment_webhook_outcomes%rowtype;
begin
  perform private.assert_worker_role();
  if p_source not in ('WEBHOOK', 'STATUS_QUERY') or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_EVENT';
  end if;
  v_transaction := p_payload #> '{data,transaction}';
  v_charge := p_payload #> '{data,charge}';
  v_kind := p_payload ->> 'type';
  v_link := v_charge ->> 'paymentLinkId';
  v_transaction_id := v_transaction ->> 'id';
  v_status := v_transaction ->> 'status';
  if jsonb_typeof(v_transaction -> 'amount') = 'number' and (v_transaction ->> 'amount') ~ '^[0-9]{1,9}$' then
    v_amount := (v_transaction ->> 'amount')::bigint;
  end if;
  if v_kind in ('PAYMENT', 'REFUND') and v_link ~ '^[A-Za-z0-9-]{8,64}$' and v_transaction_id ~ '^[A-Za-z0-9-]{8,64}$'
    and v_status ~ '^[A-Z]{3,20}$' and v_amount is not null then
    v_dedup := v_kind || ':' || v_transaction_id || ':' || v_status;
  else
    v_kind := null; v_link := null; v_transaction_id := null; v_status := null; v_amount := null;
    v_dedup := 'RAW:' || encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
  end if;

  insert into public.payment_webhook_receipts (source, event_type, event_kind, provider_link_id, transaction_id,
    original_transaction_id, transaction_status, amount_cents, payment_type, dedup_key, payload)
  values (p_source, left(p_event_type, 64), v_kind, v_link, v_transaction_id,
    case when v_kind is null then null else nullif(v_transaction ->> 'originalTransactionId', '') end,
    v_status, v_amount, case when v_kind is null then null else left(v_transaction ->> 'paymentType', 32) end,
    v_dedup, p_payload)
  on conflict (dedup_key) do nothing
  returning id into v_receipt_id;

  if v_receipt_id is null then
    select id into v_receipt_id from public.payment_webhook_receipts where dedup_key = v_dedup;
    insert into public.payment_webhook_deliveries (receipt_id, duplicate) values (v_receipt_id, true);
    v_outcome := private.payment_link_receipt_outcome(v_receipt_id);
    return jsonb_build_object('receipt_id', v_receipt_id, 'duplicate', true, 'outcome', v_outcome.outcome,
      'recovery_item_id', v_outcome.recovery_item_id, 'sale_id', v_outcome.sale_id);
  end if;
  insert into public.payment_webhook_deliveries (receipt_id, duplicate) values (v_receipt_id, false);
  return private.apply_payment_link_receipt(v_receipt_id, null) || jsonb_build_object('duplicate', false);
end;
$$;

-- Finance re-runs a receipt whose recovery may now succeed (for example after the link was registered).
create or replace function public.replay_payment_webhook_receipt(
  p_receipt_id uuid, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_previous public.payment_webhook_outcomes%rowtype;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_REQUIRED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;
  perform 1 from public.payment_webhook_receipts where id = p_receipt_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_RECEIPT_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'payment_link_replay', v_actor_id), p_idempotency_key,
    jsonb_build_object('receipt_id', p_receipt_id)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  v_previous := private.payment_link_receipt_outcome(p_receipt_id);
  if v_previous.outcome in ('APPLIED', 'ALREADY_APPLIED', 'REFUND_RECORDED') then
    v_result := jsonb_build_object('receipt_id', p_receipt_id, 'outcome', 'ALREADY_APPLIED',
      'recovery_item_id', v_previous.recovery_item_id, 'sale_id', v_previous.sale_id);
    insert into public.payment_webhook_outcomes (receipt_id, outcome, recovery_item_id, sale_id, actor_id)
    values (p_receipt_id, 'ALREADY_APPLIED', v_previous.recovery_item_id, v_previous.sale_id, v_actor_id);
  else
    v_result := private.apply_payment_link_receipt(p_receipt_id, v_actor_id);
    if v_result ->> 'outcome' = 'APPLIED' and v_previous.recovery_item_id is not null then
      update public.payment_recovery_items
      set status = 'RESOLVED', resolved_at = clock_timestamp(), resolved_by = v_actor_id,
          resolution_note = 'Evento reprocessado e aplicado à venda.'
      where id = v_previous.recovery_item_id and status = 'OPEN';
    end if;
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.payment_link.replayed', v_actor_id, 'payment_webhook_receipt', p_receipt_id::text, p_correlation_id,
    jsonb_build_object('outcome', v_result ->> 'outcome', 'previous_outcome', v_previous.outcome));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_webhook_receipt', p_receipt_id::text);
  return v_result;
end;
$$;

create or replace function public.list_payment_recovery_items(p_status text default 'OPEN', p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_REQUIRED';
  end if;
  if p_status not in ('OPEN', 'RESOLVED') or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'INVALID_FILTER';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', item.id, 'kind', item.kind, 'status', item.status, 'receipt_id', item.receipt_id,
      'charge_id', item.charge_id, 'sale_id', item.sale_id, 'amount_cents', item.amount_cents,
      'transaction_id', item.transaction_id, 'detail', item.detail, 'opened_at', item.opened_at,
      'resolved_at', item.resolved_at, 'resolution_note', item.resolution_note,
      'resolved_by_name', coalesce(nullif(btrim(resolver.display_name), ''), resolver.email)
    ) order by item.opened_at desc, item.id)
    from (select * from public.payment_recovery_items where status = p_status
          order by opened_at desc, id limit p_limit) item
    left join public.profiles resolver on resolver.id = item.resolved_by
  ), '[]'::jsonb);
end;
$$;

create or replace function public.resolve_payment_recovery_item(
  p_item_id uuid, p_note text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_item public.payment_recovery_items%rowtype;
  v_note text := btrim(coalesce(p_note, ''));
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_REQUIRED';
  end if;
  if char_length(v_note) not between 3 and 500 or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_RESOLUTION';
  end if;
  select * into v_item from public.payment_recovery_items where id = p_item_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_RECOVERY_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'payment_recovery_resolution', v_actor_id), p_idempotency_key,
    jsonb_build_object('item_id', p_item_id, 'note', v_note)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if v_item.status <> 'OPEN' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_RECOVERY_ALREADY_RESOLVED';
  end if;
  update public.payment_recovery_items
  set status = 'RESOLVED', resolved_at = clock_timestamp(), resolved_by = v_actor_id, resolution_note = v_note
  where id = v_item.id returning * into v_item;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.recovery.resolved', v_actor_id, 'payment_recovery_item', v_item.id::text, p_correlation_id,
    jsonb_build_object('kind', v_item.kind, 'note', v_note));
  v_result := jsonb_build_object('id', v_item.id, 'status', v_item.status, 'resolved_at', v_item.resolved_at);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_recovery_item', v_item.id::text);
  return v_result;
end;
$$;

alter table public.payment_link_charges enable row level security;
alter table public.payment_link_charge_events enable row level security;
alter table public.payment_webhook_receipts enable row level security;
alter table public.payment_webhook_deliveries enable row level security;
alter table public.payment_recovery_items enable row level security;
alter table public.payment_webhook_outcomes enable row level security;
alter table public.payment_link_provider_refunds enable row level security;
revoke all on table public.payment_link_charges, public.payment_link_charge_events, public.payment_webhook_receipts,
  public.payment_webhook_deliveries, public.payment_recovery_items, public.payment_webhook_outcomes,
  public.payment_link_provider_refunds from public, anon, authenticated, service_role;

revoke all on function private.prevent_payment_link_record_change() from public, anon, authenticated, service_role;
revoke all on function private.guard_payment_link_charge() from public, anon, authenticated, service_role;
revoke all on function private.record_payment_link_charge_event() from public, anon, authenticated, service_role;
revoke all on function private.guard_payment_recovery_item() from public, anon, authenticated, service_role;
revoke all on function private.payment_link_charge_json(public.payment_link_charges) from public, anon, authenticated, service_role;
revoke all on function private.open_payment_recovery(public.payment_recovery_kind, text, uuid, uuid, uuid, bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function private.claimed_payment_link_charge(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.payment_link_receipt_outcome(uuid) from public, anon, authenticated, service_role;
revoke all on function private.apply_payment_link_receipt(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.request_payment_link(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_payment_link_charge(uuid) from public, anon, authenticated, service_role;
revoke all on function public.worker_claim_payment_link_requests(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.worker_record_payment_link_created(uuid, text, text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.worker_record_payment_link_failure(uuid, text, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.worker_record_payment_link_event(public.payment_confirmation_source, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.replay_payment_webhook_receipt(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_payment_recovery_items(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.resolve_payment_recovery_item(uuid, text, text, uuid) from public, anon, authenticated, service_role;

grant execute on function public.request_payment_link(uuid, text, uuid) to authenticated;
grant execute on function public.get_payment_link_charge(uuid) to authenticated;
grant execute on function public.replay_payment_webhook_receipt(uuid, text, uuid) to authenticated;
grant execute on function public.list_payment_recovery_items(text, integer) to authenticated;
grant execute on function public.resolve_payment_recovery_item(uuid, text, text, uuid) to authenticated;
grant execute on function public.worker_claim_payment_link_requests(text, integer, integer) to service_role;
grant execute on function public.worker_record_payment_link_created(uuid, text, text, text, text, timestamptz) to service_role;
grant execute on function public.worker_record_payment_link_failure(uuid, text, boolean, text) to service_role;
grant execute on function public.worker_record_payment_link_event(public.payment_confirmation_source, text, jsonb) to service_role;
