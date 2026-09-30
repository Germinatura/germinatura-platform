-- Etapa 8.5 (RES-005, spec 4.3 e 5.10): orders the customer already paid online (reservation CONVERTED into a Portal
-- sale CONFIRMED by PicPay) are handed over at the PDV without a second charge. Stock and finance were settled when
-- the payment was confirmed; delivery only completes the reservation, idempotently and under the row lock.

alter table public.commercial_reservations
  add column completed_by uuid references public.profiles(id) on delete restrict;

-- Pickups now list prepared reservations to charge and paid online orders to deliver.
create or replace function public.list_pickup_reservations(p_query text default null, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_query text := nullif(btrim(p_query), '');
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if (v_query is not null and char_length(v_query) > 80) or p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_FILTER';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'reservation_id', page.id, 'customer_name', page.customer_name, 'location_id', page.location_id,
        'location_name', page.location_name, 'total_cents', page.total_cents, 'discount_total_cents', page.discount_total_cents,
        'ready_at', page.ready_at, 'pickup_deadline', page.pickup_deadline, 'pickup_instructions', page.pickup_instructions,
        'paid_online', page.status = 'CONVERTED', 'paid_at', page.paid_at,
        'items', (select jsonb_agg(jsonb_build_object('product_name', line ->> 'product_name',
            'quantity', (line ->> 'quantity')::bigint, 'total_cents', (line ->> 'total_cents')::bigint))
          from jsonb_array_elements(page.quote_snapshot -> 'lines') line))
      order by page.paid_at nulls last, page.pickup_deadline, page.id)
    from (
      select reservation.*, coalesce(nullif(btrim(customer.display_name), ''), customer.email) as customer_name,
        location.name as location_name, sale.confirmed_at as paid_at
      from public.commercial_reservations reservation
      join public.profiles customer on customer.id = reservation.customer_id
      join public.stock_locations location on location.id = reservation.location_id
      left join lateral (
        select attempt.confirmed_at from public.sales sale
        join public.payment_attempts attempt on attempt.sale_id = sale.id and attempt.status in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED')
        where sale.id = reservation.converted_sale_id and sale.status = 'CONFIRMED' and sale.channel = 'PORTAL'
        order by attempt.created_at desc limit 1
      ) sale on true
      where ((reservation.status = 'READY' and reservation.pickup_deadline > clock_timestamp())
          or (reservation.status = 'CONVERTED' and sale.confirmed_at is not null))
        and private.can_operate_location(v_actor_id, reservation.location_id)
        and (v_query is null or customer.display_name ilike '%' || v_query || '%' or customer.email ilike '%' || v_query || '%')
      order by sale.confirmed_at nulls last, reservation.pickup_deadline, reservation.id
      limit p_limit
    ) page
  ), '[]'::jsonb);
end;
$$;

create function public.deliver_paid_reservation(p_reservation_id uuid, p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_reservation public.commercial_reservations%rowtype;
  v_sale public.sales%rowtype;
  v_claim record;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if p_correlation_id is null or p_idempotency_key is null or char_length(p_idempotency_key) > 100 then
    raise exception using errcode = '22023', message = 'INVALID_DELIVERY';
  end if;
  select * into v_reservation from public.commercial_reservations where id = p_reservation_id for update;
  if not found or not private.can_operate_location(v_actor_id, v_reservation.location_id) then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('reservations', 'deliver_paid', v_actor_id), p_idempotency_key,
    jsonb_build_object('reservation_id', p_reservation_id));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if v_reservation.status = 'COMPLETED' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_ALREADY_DELIVERED';
  end if;
  if v_reservation.status <> 'CONVERTED' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_PAID';
  end if;
  select * into v_sale from public.sales where id = v_reservation.converted_sale_id for update;
  if not found or v_sale.channel <> 'PORTAL' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_PAID';
  end if;
  if v_sale.status = 'AWAITING_PAYMENT' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_PAYMENT_PENDING';
  end if;
  if v_sale.status <> 'CONFIRMED' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_PAID';
  end if;

  -- Nothing is charged, moved or posted: payment, stock and finance were settled at the online confirmation.
  update public.commercial_reservations
  set status = 'COMPLETED', completed_at = clock_timestamp(), completed_by = v_actor_id
  where id = v_reservation.id returning * into v_reservation;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('reservations.completed', v_actor_id, 'commercial_reservation', v_reservation.id::text, p_correlation_id,
    jsonb_build_object('sale_id', v_sale.id, 'customer_id', v_reservation.customer_id,
      'total_cents', v_reservation.total_cents, 'paid_online', true));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('reservations.completed', 'commercial_reservation', v_reservation.id::text,
    jsonb_build_object('reservation_id', v_reservation.id, 'customer_id', v_reservation.customer_id,
      'sale_id', v_sale.id, 'paid_online', true, 'correlation_id', p_correlation_id));

  v_result := jsonb_build_object('reservation_id', v_reservation.id, 'status', 'COMPLETED', 'sale_id', v_sale.id,
    'total_cents', v_reservation.total_cents, 'paid_online', true, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation.id::text);
  return v_result;
end;
$$;
revoke all on function public.deliver_paid_reservation(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.deliver_paid_reservation(uuid, text, uuid) to authenticated;
comment on function public.deliver_paid_reservation(uuid, text, uuid) is
  'Hands over an order the customer already paid online: completes the reservation without charging, moving stock or posting finance (RES-005).';
comment on column public.commercial_reservations.completed_by is 'Operator who handed over a paid online order (RES-005).';
