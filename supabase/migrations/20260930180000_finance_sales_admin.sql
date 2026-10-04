-- Etapa 6: finance reviews every sale (filters by status, channel, pending and São Paulo period) and opens
-- its detail with payment, ledger, drawer movements and history to decide a reversal.

create function private.sale_admin_summary(p_sale_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sale_id', sale.id, 'status', sale.status, 'channel', sale.channel, 'created_at', sale.created_at,
    'location_id', sale.location_id, 'location_name', location.name,
    'seller_id', sale.created_by, 'seller_name', coalesce(nullif(btrim(seller.display_name), ''), seller.email),
    'original_total_cents', sale.original_total_cents, 'discount_total_cents', sale.discount_total_cents,
    'total_cents', sale.total_cents,
    'pending_reason', case
      when sale.status = 'AWAITING_PAYMENT' then 'AWAITING_PAYMENT'
      when attempt.status = 'RECONCILIATION_PENDING' then 'RECONCILIATION_PENDING' end,
    'payment', case when attempt.id is null then null else jsonb_build_object(
      'attempt_id', attempt.id, 'status', attempt.status, 'integration_channel', attempt.integration_channel,
      'confirmation_source', attempt.confirmation_source, 'confirmed_at', attempt.confirmed_at,
      'proof_reference', attempt.proof_reference, 'card_method', attempt.card_method, 'terminal_code', terminal.code) end
  )
  from public.sales sale
  join public.stock_locations location on location.id = sale.location_id
  join public.profiles seller on seller.id = sale.created_by
  left join lateral (
    select * from public.payment_attempts candidate where candidate.sale_id = sale.id
    order by candidate.created_at desc, candidate.id desc limit 1
  ) attempt on true
  left join public.payment_terminals terminal on terminal.id = attempt.terminal_id
  where sale.id = p_sale_id;
$$;

-- Keyset-paginated sale list; p_from/p_to are São Paulo calendar days, both inclusive ([from, to + 1)).
create function public.list_sales_admin(
  p_status text default null, p_channel text default null, p_pending boolean default false,
  p_from date default null, p_to date default null, p_cursor uuid default null, p_limit integer default 25
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_cursor public.sales%rowtype;
  v_ids uuid[];
begin
  if auth.uid() is null or not public.has_permission('sales.read.all') then
    raise exception using errcode = '42501', message = 'SALES_READ_ALL_REQUIRED';
  end if;
  if (p_status is not null and p_status not in ('AWAITING_PAYMENT', 'CONFIRMED', 'CANCELLED'))
    or (p_channel is not null and p_channel not in ('PDV', 'PORTAL', 'RESERVA'))
    or p_limit is null or p_limit not between 1 and 100
    or (p_from is not null and p_to is not null and p_to < p_from) then
    raise exception using errcode = '22023', message = 'INVALID_SALES_FILTER';
  end if;
  if p_cursor is not null then
    select * into v_cursor from public.sales where id = p_cursor;
    if not found then
      raise exception using errcode = '22023', message = 'INVALID_SALES_CURSOR';
    end if;
  end if;

  select array_agg(page.id order by page.created_at desc, page.id desc) into v_ids
  from (
    select sale.id, sale.created_at
    from public.sales sale
    left join lateral (
      select candidate.status from public.payment_attempts candidate where candidate.sale_id = sale.id
      order by candidate.created_at desc, candidate.id desc limit 1
    ) attempt on true
    where sale.status <> 'DRAFT'
      and (p_status is null or sale.status::text = p_status)
      and (p_channel is null or sale.channel::text = p_channel)
      and (not coalesce(p_pending, false) or sale.status = 'AWAITING_PAYMENT' or attempt.status = 'RECONCILIATION_PENDING')
      and (p_from is null or sale.created_at >= (p_from::timestamp at time zone 'America/Sao_Paulo'))
      and (p_to is null or sale.created_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo'))
      and (p_cursor is null or (sale.created_at, sale.id) < (v_cursor.created_at, v_cursor.id))
    order by sale.created_at desc, sale.id desc
    limit p_limit + 1
  ) page;

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.sale_admin_summary(id) order by ordinality)
      from unnest(v_ids) with ordinality id where ordinality <= p_limit), '[]'::jsonb),
    'next_cursor', case when coalesce(array_length(v_ids, 1), 0) > p_limit then v_ids[p_limit] end);
end;
$$;

-- Full detail of one sale for finance, including whether and how it can be reversed.
create function public.get_sale_admin(p_sale_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_summary jsonb;
  v_sale public.sales%rowtype;
  v_attempt public.payment_attempts%rowtype;
begin
  if auth.uid() is null or not public.has_permission('sales.read.all') then
    raise exception using errcode = '42501', message = 'SALES_READ_ALL_REQUIRED';
  end if;
  select * into v_sale from public.sales where id = p_sale_id and status <> 'DRAFT';
  if not found then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;
  select * into v_attempt from public.payment_attempts where sale_id = p_sale_id
  order by created_at desc, id desc limit 1;
  v_summary := private.sale_admin_summary(p_sale_id);

  return v_summary || jsonb_build_object(
    'items', (select jsonb_agg(jsonb_build_object('product_name', item.product_name, 'product_sku', item.product_sku,
        'quantity', item.quantity, 'unit_price_cents', item.unit_price_cents, 'discount_cents', item.discount_cents,
        'total_cents', item.total_cents) order by item.product_name, item.id)
      from public.sale_items item where item.sale_id = p_sale_id),
    'ledger', coalesce((select jsonb_agg(jsonb_build_object('id', entry.id, 'entry_type', entry.entry_type,
        'amount_cents', entry.amount_cents, 'created_at', entry.created_at,
        'refund_method', entry.metadata ->> 'refund_method', 'reference', coalesce(entry.metadata ->> 'refund_reference', entry.metadata ->> 'external_reference'))
        order by entry.created_at, entry.id)
      from public.financial_ledger_entries entry where entry.sale_id = p_sale_id), '[]'::jsonb),
    'cash_movements', coalesce((select jsonb_agg(jsonb_build_object('id', movement.id, 'movement_type', movement.movement_type,
        'amount_cents', movement.amount_cents, 'shift_id', movement.shift_id, 'created_at', movement.created_at)
        order by movement.created_at, movement.id)
      from public.cash_movements movement where movement.sale_id = p_sale_id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('from_status', history.from_status, 'to_status', history.to_status,
        'reason', history.reason, 'created_at', history.created_at) order by history.created_at, history.id)
      from public.sale_status_history history where history.sale_id = p_sale_id), '[]'::jsonb),
    -- Mirrors the guards of reverse_confirmed_sale so the screen only offers what the command accepts.
    'reversal', jsonb_build_object(
      'allowed', v_sale.status = 'CONFIRMED'
        and v_attempt.status in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED')
        and not exists (select 1 from public.raffle_numbers number where number.sale_id = p_sale_id and number.status = 'PAID'),
      'blocked_reason', case
        when v_sale.status <> 'CONFIRMED' then 'SALE_NOT_CONFIRMED'
        when exists (select 1 from public.raffle_numbers number where number.sale_id = p_sale_id and number.status = 'PAID') then 'PAID_RAFFLE_REVERSAL_REQUIRED'
        when v_attempt.status is null or v_attempt.status not in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED') then 'PAYMENT_ATTEMPT_NOT_REFUNDABLE' end,
      'cash_payout_allowed', v_attempt.integration_channel is not distinct from 'DINHEIRO')
  );
end;
$$;

revoke all on function private.sale_admin_summary(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_sales_admin(text, text, boolean, date, date, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_sale_admin(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_sales_admin(text, text, boolean, date, date, uuid, integer) to authenticated;
grant execute on function public.get_sale_admin(uuid) to authenticated;

comment on function public.list_sales_admin(text, text, boolean, date, date, uuid, integer) is
  'Finance sale list: status, channel, pending and São Paulo period filters, keyset paginated.';
comment on function public.get_sale_admin(uuid) is
  'Finance sale detail with payment, ledger, drawer movements, history and reversal eligibility.';
