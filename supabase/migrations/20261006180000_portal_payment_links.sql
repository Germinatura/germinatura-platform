-- ADR 0010 and PAY-004: the consumer pays an active reservation online with a Payment Link. The reservation turns
-- into a Portal sale awaiting payment (same conversion as before, keeping the frozen price and the stock hold), the
-- intent is persisted with the Portal page PicPay sends the customer back to, and the jobs worker creates the link.
-- Returning from PicPay confirms nothing: only the webhook or the official status query does.

alter table public.payment_link_charges
  add column redirect_url text,
  add constraint payment_link_charges_redirect_valid check (
    redirect_url is null or (char_length(redirect_url) <= 1000
      and redirect_url ~ '^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://(127\.0\.0\.1|localhost)(:[0-9]+)?)/pedidos/pagamento/[0-9a-f-]{36}$')
  );

create or replace function public.request_portal_payment_link(
  p_reservation_id uuid, p_return_base_url text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_reservation public.commercial_reservations%rowtype;
  v_sale public.sales%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_charge public.payment_link_charges%rowtype;
  v_claim record;
  v_converted jsonb;
  v_id uuid := gen_random_uuid();
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if p_correlation_id is null or p_return_base_url is null
    or p_return_base_url !~ '^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://(127\.0\.0\.1|localhost)(:[0-9]+)?)$' then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_LINK_REQUEST';
  end if;
  perform private.require_feature('payment_link');

  select * into v_reservation from public.commercial_reservations where id = p_reservation_id for update;
  if not found or v_reservation.customer_id <> v_actor_id then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'portal_payment_link', v_actor_id), p_idempotency_key,
    jsonb_build_object('reservation_id', p_reservation_id, 'return_base_url', p_return_base_url)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  -- An active reservation becomes a Portal sale; a converted one keeps the sale it already has.
  if v_reservation.status = 'ACTIVE' then
    v_converted := public.convert_commercial_reservation(v_reservation.id, p_idempotency_key || ':convert', p_correlation_id);
    if v_converted ->> 'status' <> 'CONVERTED' then
      raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_PAYABLE';
    end if;
    select * into v_reservation from public.commercial_reservations where id = v_reservation.id;
  elsif v_reservation.status <> 'CONVERTED' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_PAYABLE';
  end if;

  select * into v_sale from public.sales where id = v_reservation.converted_sale_id for update;
  if not found or v_sale.channel <> 'PORTAL' or v_sale.customer_id <> v_actor_id or v_sale.status <> 'AWAITING_PAYMENT' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_AWAITING_PAYMENT';
  end if;
  select * into v_attempt from public.payment_attempts
  where sale_id = v_sale.id order by created_at desc, id desc limit 1 for update;
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
      (id, sale_id, attempt_id, amount_cents, order_number, requested_by, correlation_id, redirect_url)
    values (v_id, v_sale.id, v_attempt.id, v_sale.total_cents,
      'G' || upper(substr(replace(v_id::text, '-', ''), 1, 14)), v_actor_id, p_correlation_id,
      p_return_base_url || '/pedidos/pagamento/' || v_id::text)
    returning * into v_charge;
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('payments.payment_link.requested', v_actor_id, 'payment_link_charge', v_charge.id::text, p_correlation_id,
      jsonb_build_object('sale_id', v_sale.id, 'attempt_id', v_attempt.id, 'amount_cents', v_charge.amount_cents,
        'reservation_id', v_reservation.id, 'channel', 'PORTAL'));
  end if;

  v_result := private.payment_link_charge_json(v_charge) || jsonb_build_object('reservation_id', v_reservation.id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_link_charge', v_charge.id::text);
  return v_result;
end;
$$;

-- Same claim as before, now handing the worker the page PicPay returns the customer to.
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
      'name', 'Germinatura ' || v_charge.order_number, 'redirect_url', v_charge.redirect_url,
      -- The provider takes a calendar date; the sale hold (Brasília time) bounds it.
      'expires_on', to_char(coalesce(v_expires, clock_timestamp()) at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')
    ));
  end loop;
  return v_claims;
end;
$$;

revoke all on function public.request_portal_payment_link(uuid, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.request_portal_payment_link(uuid, text, text, uuid) to authenticated;
