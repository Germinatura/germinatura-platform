-- PDV "Minhas vendas" (spec 6.10): the seller's own PDV sales with status and payment method, pending
-- sales (awaiting payment or awaiting reconciliation) highlighted. Only the caller's own sales are visible.

create function public.list_my_sales(p_filter text default null, p_cursor uuid default null, p_limit integer default 20)
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
        'confirmation_source', page.confirmation_source, 'confirmed_at', page.confirmed_at) end,
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

revoke all on function public.list_my_sales(text, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_my_sales(text, uuid, integer) to authenticated;
comment on function public.list_my_sales(text, uuid, integer) is
  'PDV "Minhas vendas": caller-owned PDV sales with status, payment method and pending highlight, keyset paginated.';
