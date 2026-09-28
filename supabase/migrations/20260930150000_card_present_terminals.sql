-- Spec 6.7 / PAY-005: card-present payments record the card method and, when the establishment has
-- registered internal terminals, which Maquininha was used. Nothing sensitive about the card is stored;
-- the server total is never changed by the manual confirmation.

create type public.card_payment_method as enum ('CREDITO', 'DEBITO', 'VOUCHER_ALIMENTACAO', 'VOUCHER_REFEICAO');

-- Internal registry of the establishment's PicPay Maquininhas (the seller id stays the internal identity).
create table public.payment_terminals (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$' and char_length(code) between 2 and 32),
  label text not null check (char_length(label) between 2 and 80 and label = btrim(label)),
  active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger payment_terminals_no_delete before delete on public.payment_terminals
for each row execute function private.prevent_immutable_record_change();
alter table public.payment_terminals enable row level security;
revoke all on public.payment_terminals from public, anon, authenticated, service_role;

alter table public.payment_attempts
  add column card_method public.card_payment_method,
  add column terminal_id uuid references public.payment_terminals(id) on delete restrict;
alter table public.payment_attempts add constraint payment_attempts_card_details_valid check (
  (card_method is null or integration_channel in ('MAQUININHA', 'TAP'))
  and (terminal_id is null or integration_channel = 'MAQUININHA')
);
create index payment_attempts_terminal_idx on public.payment_attempts (terminal_id) where terminal_id is not null;

-- Sellers see active terminals; finance also sees inactive ones.
create function public.list_payment_terminals(p_include_inactive boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not (public.has_permission('sales.create') or public.has_permission('finance.manage')) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if coalesce(p_include_inactive, false) and not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', terminal.id, 'code', terminal.code, 'label', terminal.label,
        'active', terminal.active, 'updated_at', terminal.updated_at) order by terminal.active desc, terminal.code)
    from public.payment_terminals terminal
    where terminal.active or coalesce(p_include_inactive, false)
  ), '[]'::jsonb);
end;
$$;

-- Finance registers, renames, deactivates or reactivates a terminal. Terminals are never deleted.
create function public.save_payment_terminal(
  p_terminal_id uuid, p_code text, p_label text, p_active boolean, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_claim record; v_terminal public.payment_terminals%rowtype;
  v_code text := upper(btrim(p_code)); v_label text := btrim(p_label); v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_active is null or v_code is null or v_label is null
    or v_code !~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$' or char_length(v_code) not between 2 and 32
    or char_length(v_label) not between 2 and 80 then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_TERMINAL';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'save_terminal', v_actor_id), p_idempotency_key,
    jsonb_build_object('terminal_id', p_terminal_id, 'code', v_code, 'label', v_label, 'active', p_active));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if exists (select 1 from public.payment_terminals where code = v_code and id is distinct from p_terminal_id) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_CODE_TAKEN';
  end if;
  if p_terminal_id is null then
    insert into public.payment_terminals (code, label, active, created_by, updated_by)
    values (v_code, v_label, p_active, v_actor_id, v_actor_id) returning * into v_terminal;
  else
    update public.payment_terminals
    set code = v_code, label = v_label, active = p_active, updated_by = v_actor_id, updated_at = clock_timestamp()
    where id = p_terminal_id returning * into v_terminal;
    if not found then
      raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_NOT_FOUND';
    end if;
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.terminal.saved', v_actor_id, 'payment_terminal', v_terminal.id::text, p_correlation_id,
    jsonb_build_object('code', v_terminal.code, 'label', v_terminal.label, 'active', v_terminal.active,
      'created', p_terminal_id is null));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('payments.terminal.saved', 'payment_terminal', v_terminal.id::text,
    jsonb_build_object('terminal_id', v_terminal.id, 'active', v_terminal.active, 'correlation_id', p_correlation_id));
  v_result := jsonb_build_object('id', v_terminal.id, 'code', v_terminal.code, 'label', v_terminal.label,
    'active', v_terminal.active, 'updated_at', v_terminal.updated_at, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_terminal', v_terminal.id::text);
  return v_result;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_CODE_TAKEN';
end;
$$;

create function public.confirm_manual_payment(
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

-- The original signature stays for Área Pix callers; Maquininha now needs the card method.
create or replace function public.confirm_manual_payment(
  p_sale_id uuid,
  p_integration_channel public.payment_integration_channel,
  p_proof_reference text,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.confirm_manual_payment(
    p_sale_id, p_integration_channel, p_proof_reference, null::public.card_payment_method, null::uuid,
    p_idempotency_key, p_correlation_id
  );
$$;


-- "Minhas vendas" also shows the card method and the Maquininha used.
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
    where sale.created_by = v_actor_id and sale.channel = 'PDV' and sale.status <> 'DRAFT'
      and (p_cursor is null or (sale.created_at, sale.id) < (v_cursor.created_at, v_cursor.id))
      and (p_filter is null
        or (p_filter = 'PENDING' and (sale.status = 'AWAITING_PAYMENT' or attempt.status = 'RECONCILIATION_PENDING'))
        or (p_filter = 'CONFIRMED' and sale.status = 'CONFIRMED')
        or (p_filter = 'CANCELLED' and sale.status = 'CANCELLED'))
    order by sale.created_at desc, sale.id desc
    limit p_limit + 1
  )
  select jsonb_agg(jsonb_build_object(
      'sale_id', page.id, 'status', page.status, 'created_at', page.created_at, 'location_id', page.location_id,
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
      where sale.created_by = v_actor_id and sale.channel = 'PDV'
        and (sale.status = 'AWAITING_PAYMENT' or exists (
          select 1 from public.payment_attempts attempt
          where attempt.sale_id = sale.id and attempt.status = 'RECONCILIATION_PENDING'))));
end;
$$;

revoke all on function public.list_payment_terminals(boolean) from public, anon, authenticated, service_role;
revoke all on function public.save_payment_terminal(uuid, text, text, boolean, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.confirm_manual_payment(uuid, public.payment_integration_channel, text, public.card_payment_method, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_payment_terminals(boolean) to authenticated;
grant execute on function public.save_payment_terminal(uuid, text, text, boolean, text, uuid) to authenticated;
grant execute on function public.confirm_manual_payment(uuid, public.payment_integration_channel, text, public.card_payment_method, uuid, text, uuid)
  to authenticated;

comment on table public.payment_terminals is 'Spec 6.7: internal registry of the establishment PicPay Maquininhas; never deleted, only deactivated.';
comment on column public.payment_attempts.card_method is 'Card method of a card-present payment (credit, debit or meal voucher); never card data.';
comment on function public.confirm_manual_payment(uuid, public.payment_integration_channel, text, public.card_payment_method, uuid, text, uuid) is
  'Seller confirms a Maquininha or Área Pix payment with a non-sensitive proof, card method and internal terminal.';
