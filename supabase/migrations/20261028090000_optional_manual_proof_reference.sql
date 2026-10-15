-- H2c (PDV): the external reference of a manual Maquininha / Área Pix confirmation becomes optional.
--
-- The operator still confirms outside the system that the payment happened (manual confirmation is unchanged); the
-- reference is only typed when the receipt carries a useful identifier. Absent = NULL, never generated. When present it
-- keeps every current rule: 4-128 characters, trimmed, non-sensitive format, never 12+ digits (card data), unique among
-- manual confirmations (payment_attempts_manual_proof_unique; NULLs never collide). The sale stays traceable by sale,
-- attempt, operator, time, amount, method, terminal and audit. Signature, idempotency fingerprint, acréscimo (PR D),
-- ledger, stock and audit flow of confirm_manual_payment are unchanged; only the reference check moves.

set local lock_timeout = '5s';

-- 1. Constraint: a manual PicPay channel may have no reference; a reference, when present, keeps the same format.
alter table cohort_data.payment_attempts drop constraint payment_attempts_manual_origin_valid;
alter table cohort_data.payment_attempts add constraint payment_attempts_manual_origin_valid check (
  confirmation_source <> 'MANUAL'
  or (integration_channel = 'DINHEIRO' and proof_reference is null)
  or (
    integration_channel in ('MAQUININHA', 'PIX_AREA')
    and (
      proof_reference is null
      or (
        char_length(proof_reference) between 4 and 128
        and proof_reference = btrim(proof_reference)
        and proof_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$'
        and proof_reference !~ '[0-9]{12,}'
      )
    )
  )
) not valid;
alter table cohort_data.payment_attempts validate constraint payment_attempts_manual_origin_valid;

-- 2. The confirmation accepts a missing reference (same signature and flow as 20261024150000).
create or replace function public.confirm_manual_payment(
  p_sale_id uuid,
  p_integration_channel public.payment_integration_channel,
  p_proof_reference text,
  p_card_method public.card_payment_method,
  p_terminal_id uuid,
  p_idempotency_key text,
  p_correlation_id uuid,
  p_surcharge_cents bigint default null,
  p_waive_surcharge boolean default false,
  p_surcharge_waiver_reason text default null
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
  v_surcharge jsonb;
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
  -- H2c: the reference on the receipt is optional (the PicPay Mini gives the operator nothing useful to type). Absent
  -- means NULL, never a made-up value; when present it keeps the non-sensitive format (never card data).
  if p_proof_reference is not null and (
    char_length(p_proof_reference) not between 4 and 128
    or p_proof_reference <> btrim(p_proof_reference)
    or p_proof_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$'
    or p_proof_reference ~ '[0-9]{12,}') then
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
    ) || jsonb_strip_nulls(jsonb_build_object('card_method', p_card_method, 'terminal_id', p_terminal_id,
      'surcharge_cents', p_surcharge_cents, 'waive_surcharge', case when coalesce(p_waive_surcharge, false) then true end,
      'surcharge_waiver_reason', nullif(btrim(p_surcharge_waiver_reason), '')))
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
  v_surcharge := private.apply_payment_surcharge(v_sale.id, v_attempt.id,
    private.payment_surcharge_method_for(p_integration_channel, p_card_method), p_surcharge_cents,
    p_waive_surcharge, p_surcharge_waiver_reason, v_actor_id, p_correlation_id);

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
    v_sale.id, v_attempt.id, 'RECEIVABLE_PICPAY', v_attempt.amount_cents,
    v_actor_id, p_correlation_id,
    jsonb_build_object(
      'integration_channel', p_integration_channel,
      'confirmation_source', 'MANUAL'
    ) || jsonb_strip_nulls(jsonb_build_object('card_method', p_card_method, 'terminal_id', p_terminal_id))
      || case when v_surcharge is null then '{}'::jsonb else jsonb_build_object('product_cents', v_sale.total_cents,
        'surcharge_cents', (v_surcharge ->> 'applied_cents')::bigint) end
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
      'financial_ledger_entry_id', v_ledger_id,
      'surcharge_cents', coalesce((v_surcharge ->> 'applied_cents')::bigint, 0)
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
    'surcharge', v_surcharge,
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
