-- Spec 4.4 (RAF-003): the consumer buys raffle numbers online. Numbers are reserved with row locks (existing
-- reserve_raffle_numbers, 10-minute hold), then paid with a PicPay Payment Link. Asking for the link extends the hold
-- to 30 minutes so the payment can finish; the sale is confirmed only by the webhook or the official status query,
-- and an expired hold cancels the sale, which inactivates the link. "Meus bilhetes" groups tickets by raffle and order.

create or replace function public.request_customer_payment_link(
  p_sale_id uuid, p_return_base_url text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_charge public.payment_link_charges%rowtype;
  v_claim record;
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
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.channel <> 'PORTAL' or v_sale.customer_id is distinct from v_actor_id or v_sale.created_by <> v_actor_id then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'customer_payment_link', v_actor_id), p_idempotency_key,
    jsonb_build_object('sale_id', p_sale_id, 'return_base_url', p_return_base_url));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  if v_sale.status <> 'AWAITING_PAYMENT' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_AWAITING_PAYMENT';
  end if;
  select * into v_attempt from public.payment_attempts where sale_id = v_sale.id order by created_at desc, id desc limit 1 for update;
  if not found or v_attempt.operator_id <> v_actor_id or v_attempt.status <> 'CREATED' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_CONFIRMABLE';
  end if;
  if v_attempt.amount_cents <> v_sale.total_cents or v_sale.total_cents not between 1 and 999999999 then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AMOUNT_MISMATCH';
  end if;
  -- An online payment needs longer than the 10-minute selection hold.
  update public.raffle_numbers set expires_at = greatest(expires_at, clock_timestamp() + interval '30 minutes')
  where sale_id = v_sale.id and status = 'RESERVED';

  select * into v_charge from public.payment_link_charges
  where attempt_id = v_attempt.id and status in ('REQUESTED', 'ACTIVE', 'UNCERTAIN');
  if not found then
    insert into public.payment_link_charges
      (id, sale_id, attempt_id, amount_cents, order_number, requested_by, correlation_id, redirect_url)
    values (v_id, v_sale.id, v_attempt.id, v_sale.total_cents, 'G' || upper(substr(replace(v_id::text, '-', ''), 1, 14)),
      v_actor_id, p_correlation_id, p_return_base_url || '/pedidos/pagamento/' || v_id::text)
    returning * into v_charge;
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('payments.payment_link.requested', v_actor_id, 'payment_link_charge', v_charge.id::text, p_correlation_id,
      jsonb_build_object('sale_id', v_sale.id, 'attempt_id', v_attempt.id, 'amount_cents', v_charge.amount_cents, 'channel', 'PORTAL'));
  end if;
  v_result := private.payment_link_charge_json(v_charge);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_link_charge', v_charge.id::text);
  return v_result;
end;
$$;

-- Payment confirmations consume the sale's stock hold; a raffle sale has none and consumes nothing.
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
  v_numbers integer[];
  v_items jsonb;
  v_movement_id uuid := gen_random_uuid();
begin
  select * into v_reservation
  from public.stock_reservations
  where origin_type = 'sale' and origin_id = p_sale_id::text
  for update;
  if not found then
    -- Raffle tickets hold numbers, not stock: the sale is payable while its numbers are still held.
    select array_agg(number order by number) into v_numbers from public.raffle_numbers
    where sale_id = p_sale_id and status = 'RESERVED';
    if v_numbers is null then
      raise exception using errcode = 'P0001', message = 'SALE_RESERVATION_NOT_FOUND';
    end if;
    if exists (select 1 from public.raffle_numbers where sale_id = p_sale_id and status = 'RESERVED' and expires_at <= clock_timestamp()) then
      raise exception using errcode = 'P0001', message = 'SALE_RESERVATION_EXPIRED';
    end if;
    return jsonb_build_object('status', 'RAFFLE_TICKETS', 'raffle_numbers', to_jsonb(v_numbers));
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

-- "Meus bilhetes": the buyer's raffle orders with their numbers, payment state and the draw outcome.
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
      'won', draw.winner_number is not null and draw.winner_number = any(tickets.numbers)
    ) order by sale.created_at desc, sale.id)
    from (
      select item.sale_id, item.campaign_id, array_agg(item.number order by item.number) numbers,
        min(item.expires_at) expires_at, max(item.paid_at) paid_at
      from public.raffle_numbers item
      where item.reserved_by = v_actor_id and item.sale_id is not null
      group by item.sale_id, item.campaign_id
    ) tickets
    join public.sales sale on sale.id = tickets.sale_id and sale.customer_id = v_actor_id
    join public.raffle_campaigns campaign on campaign.id = tickets.campaign_id
    left join public.raffle_draws draw on draw.campaign_id = campaign.id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.request_customer_payment_link(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_my_raffle_tickets() from public, anon, authenticated, service_role;
grant execute on function public.request_customer_payment_link(uuid, text, text, uuid) to authenticated;
grant execute on function public.list_my_raffle_tickets() to authenticated;
