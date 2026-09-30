-- Spec 6.15 and 15.5 (RAF-004): raffle numbers sold at the PDV through the same sale and payment infrastructure as
-- any other sale. The seller picks numbers (row locks: a number is never held twice) and identifies the buyer either
-- as a registered account (exact email or username) or by name and one contact, collected only for the prize. The
-- sale belongs to the seller's location so cash lands in their shift; tickets move no stock.

create table public.raffle_sale_buyers (
  sale_id uuid primary key references public.sales(id) on delete restrict,
  profile_id uuid references public.profiles(id) on delete restrict,
  buyer_name text,
  buyer_contact text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint raffle_sale_buyers_identified check (profile_id is not null or (buyer_name is not null and buyer_contact is not null)),
  constraint raffle_sale_buyers_name_valid check (buyer_name is null or (char_length(buyer_name) between 2 and 120 and buyer_name = btrim(buyer_name))),
  constraint raffle_sale_buyers_contact_valid check (buyer_contact is null or (
    char_length(buyer_contact) <= 120 and (buyer_contact ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or buyer_contact ~ '^\+?[0-9]{10,13}$')))
);
create trigger raffle_sale_buyers_immutable before update or delete on public.raffle_sale_buyers
for each row execute function private.prevent_immutable_record_change();

-- Finds a registered buyer only by an exact email or username, so the PDV cannot browse customers.
create or replace function public.find_raffle_buyer(p_identifier text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_identifier text := lower(btrim(coalesce(p_identifier, '')));
  v_profile public.profiles%rowtype;
begin
  if auth.uid() is null or not public.has_permission('raffles.sell') then
    raise exception using errcode = '42501', message = 'RAFFLE_SELL_FORBIDDEN';
  end if;
  if char_length(v_identifier) not between 3 and 254 then
    raise exception using errcode = '22023', message = 'INVALID_BUYER_IDENTIFIER';
  end if;
  select * into v_profile from public.profiles
  where lower(email) = v_identifier or username = v_identifier limit 1;
  if not found then return null; end if;
  return jsonb_build_object('profile_id', v_profile.id,
    'display_name', coalesce(nullif(btrim(v_profile.display_name), ''), split_part(v_profile.email, '@', 1)));
end;
$$;

create or replace function public.reserve_raffle_numbers_pdv(
  p_campaign_id uuid, p_location_id uuid, p_numbers integer[], p_buyer_profile_id uuid, p_buyer_name text, p_buyer_contact text,
  p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_campaign public.raffle_campaigns%rowtype;
  v_numbers integer[];
  v_name text := nullif(btrim(coalesce(p_buyer_name, '')), '');
  v_contact text := nullif(regexp_replace(btrim(coalesce(p_buyer_contact, '')), '[\s().-]', '', 'g'), '');
  v_claim record;
  v_quote jsonb;
  v_sale_id uuid := gen_random_uuid();
  v_attempt_id uuid := gen_random_uuid();
  v_expires_at timestamptz := clock_timestamp() + interval '10 minutes';
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('raffles.sell') or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'RAFFLE_SELL_FORBIDDEN';
  end if;
  if p_correlation_id is null or not private.can_operate_location(v_actor_id, p_location_id) then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_SALE';
  end if;
  if v_contact is not null and position('@' in v_contact) > 0 then v_contact := lower(btrim(p_buyer_contact)); end if;
  if p_buyer_profile_id is null and (v_name is null or v_contact is null) then
    raise exception using errcode = '22023', message = 'RAFFLE_BUYER_REQUIRED';
  end if;
  if p_buyer_profile_id is null and (char_length(v_name) not between 2 and 120
    or not (v_contact ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or v_contact ~ '^\+?[0-9]{10,13}$')) then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_BUYER';
  end if;
  if p_buyer_profile_id is not null and not exists (select 1 from public.profiles where id = p_buyer_profile_id) then
    raise exception using errcode = '22023', message = 'RAFFLE_BUYER_REQUIRED';
  end if;
  select array_agg(distinct value order by value) into v_numbers from unnest(p_numbers) value;
  if v_numbers is null or cardinality(v_numbers) not between 1 and 100 or cardinality(v_numbers) <> cardinality(p_numbers) then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_NUMBERS';
  end if;
  select * into v_campaign from public.raffle_campaigns where id = p_campaign_id for update;
  if not found or v_campaign.status <> 'ACTIVE' or clock_timestamp() < v_campaign.starts_at or clock_timestamp() >= v_campaign.ends_at then
    raise exception using errcode = 'P0001', message = 'RAFFLE_CAMPAIGN_NOT_AVAILABLE';
  end if;
  if v_numbers[1] < 1 or v_numbers[cardinality(v_numbers)] > v_campaign.number_count then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_NUMBERS';
  end if;
  select * into v_claim from private.claim_idempotency(private.build_idempotency_scope('raffles', 'pdv_reserve_numbers', v_actor_id),
    p_idempotency_key, jsonb_build_object('campaign_id', p_campaign_id, 'location_id', p_location_id, 'numbers', to_jsonb(v_numbers),
      'buyer_profile_id', p_buyer_profile_id, 'buyer_name', v_name, 'buyer_contact', v_contact));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  perform number from public.raffle_numbers where campaign_id = p_campaign_id and number = any(v_numbers) order by number for update;
  if (select count(*) from public.raffle_numbers
      where campaign_id = p_campaign_id and number = any(v_numbers) and status = 'AVAILABLE') <> cardinality(v_numbers) then
    raise exception using errcode = 'P0001', message = 'RAFFLE_NUMBER_CONFLICT';
  end if;
  v_quote := private.price_sale_items('PDV', jsonb_build_array(jsonb_build_object('product_id', v_campaign.product_id, 'quantity', cardinality(v_numbers))));
  insert into public.sales (id, channel, location_id, created_by, customer_id, original_total_cents, discount_total_cents,
    total_cents, quoted_at, correlation_id)
  values (v_sale_id, 'PDV', p_location_id, v_actor_id, p_buyer_profile_id, (v_quote ->> 'original_total_cents')::bigint,
    (v_quote ->> 'discount_total_cents')::bigint, (v_quote ->> 'total_cents')::bigint, (v_quote ->> 'quoted_at')::timestamptz, p_correlation_id);
  insert into public.sale_items (sale_id, product_id, product_sku, product_name, quantity, unit_price_cents,
    original_subtotal_cents, discount_cents, total_cents, promotion_id, promotion_snapshot)
  select v_sale_id, line.product_id, line.product_sku, line.product_name, line.quantity, line.unit_price_cents,
    line.original_subtotal_cents, line.discount_cents, line.total_cents, line.promotion_id, line.promotion_snapshot
  from jsonb_to_recordset(v_quote -> 'lines') as line(product_id uuid, product_sku text, product_name text, quantity bigint,
    unit_price_cents bigint, original_subtotal_cents bigint, discount_cents bigint, total_cents bigint, promotion_id uuid, promotion_snapshot jsonb);
  perform private.assert_sale_totals(v_sale_id);
  insert into public.payment_attempts (id, sale_id, amount_cents, operator_id, idempotency_key, correlation_id)
  values (v_attempt_id, v_sale_id, (v_quote ->> 'total_cents')::bigint, v_actor_id, p_idempotency_key, p_correlation_id);
  perform private.transition_sale_state(v_sale_id, 'AWAITING_PAYMENT', v_actor_id, p_correlation_id, 'Venda de rifa no PDV');
  update public.raffle_numbers set status = 'RESERVED', reserved_by = coalesce(p_buyer_profile_id, v_actor_id),
    sale_id = v_sale_id, payment_attempt_id = v_attempt_id, reserved_at = clock_timestamp(), expires_at = v_expires_at
  where campaign_id = p_campaign_id and number = any(v_numbers);
  insert into public.raffle_sale_buyers (sale_id, profile_id, buyer_name, buyer_contact, created_by)
  values (v_sale_id, p_buyer_profile_id, case when p_buyer_profile_id is null then v_name end,
    case when p_buyer_profile_id is null then v_contact end, v_actor_id);
  -- The audit trail records that a buyer was identified, never the contact itself.
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('raffles.numbers.reserved', v_actor_id, 'raffle_campaign', p_campaign_id::text, p_correlation_id,
    jsonb_build_object('numbers', v_numbers, 'sale_id', v_sale_id, 'channel', 'PDV', 'registered_buyer', p_buyer_profile_id is not null));
  v_result := jsonb_build_object('campaign_id', p_campaign_id, 'numbers', v_numbers, 'status', 'RESERVED', 'sale_id', v_sale_id,
    'sale_status', 'AWAITING_PAYMENT', 'payment_attempt_id', v_attempt_id, 'total_cents', (v_quote ->> 'total_cents')::bigint,
    'expires_at', v_expires_at, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale_id::text);
  return v_result;
end;
$$;

-- The buyer or the seller who created the sale may release unpaid numbers. The previous check let anyone cancel a
-- sale without a customer, since a NULL comparison never raised.
create or replace function public.cancel_raffle_reservation(p_sale_id uuid, p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_campaign_id uuid;
  v_numbers integer[];
  v_claim record;
  v_result jsonb;
begin
  if v_actor_id is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or not (v_sale.customer_id is not distinct from v_actor_id or v_sale.created_by = v_actor_id) then
    raise exception using errcode = 'P0001', message = 'RAFFLE_RESERVATION_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(private.build_idempotency_scope('raffles', 'cancel_reservation', v_actor_id),
    p_idempotency_key, jsonb_build_object('sale_id', p_sale_id));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select campaign_id, array_agg(number order by number) into v_campaign_id, v_numbers
  from public.raffle_numbers where sale_id = p_sale_id group by campaign_id;
  if v_campaign_id is null then raise exception using errcode = 'P0001', message = 'RAFFLE_RESERVATION_NOT_FOUND'; end if;
  if exists (select 1 from public.raffle_numbers where sale_id = p_sale_id and status = 'PAID') then
    raise exception using errcode = 'P0001', message = 'PAID_RAFFLE_REVERSAL_REQUIRED';
  end if;
  select * into v_attempt from public.payment_attempts where sale_id = p_sale_id order by created_at desc, id desc limit 1 for update;
  if found and v_attempt.status not in ('CANCELLED', 'APPROVED') then
    perform private.transition_payment_attempt(v_attempt.id, 'CANCELLED', v_actor_id, p_correlation_id, 'Reserva de rifa cancelada');
  end if;
  if v_sale.status = 'AWAITING_PAYMENT' then
    perform private.transition_sale_state(v_sale.id, 'CANCELLED', v_actor_id, p_correlation_id, 'Reserva de rifa cancelada');
  end if;
  update public.raffle_numbers set status = 'AVAILABLE', reserved_by = null, sale_id = null,
    payment_attempt_id = null, reserved_at = null, expires_at = null, paid_at = null
  where campaign_id = v_campaign_id and number = any(v_numbers) and status = 'RESERVED';
  v_result := jsonb_build_object('campaign_id', v_campaign_id, 'numbers', v_numbers,
    'status', 'CANCELLED', 'sale_id', p_sale_id, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', p_sale_id::text);
  return v_result;
end;
$$;

-- Sellers list open raffles to sell them.
create or replace function public.list_raffles_for_seller()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('raffles.sell') then
    raise exception using errcode = '42501', message = 'RAFFLE_SELL_FORBIDDEN';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('campaign_id', campaign.id, 'name', campaign.name, 'product_name', product.name,
      'number_count', campaign.number_count, 'ends_at', campaign.ends_at,
      'unit_price_cents', (select price.amount_cents from public.product_prices price where price.product_id = campaign.product_id
        and price.valid_from <= clock_timestamp() and (price.valid_to is null or price.valid_to > clock_timestamp()) order by price.valid_from desc limit 1),
      'available_count', (select count(*) from public.raffle_numbers item where item.campaign_id = campaign.id and item.status = 'AVAILABLE')
    ) order by campaign.ends_at, campaign.id)
    from public.raffle_campaigns campaign join public.products product on product.id = campaign.product_id
    where campaign.status = 'ACTIVE' and campaign.starts_at <= clock_timestamp() and campaign.ends_at > clock_timestamp()
  ), '[]'::jsonb);
end;
$$;

alter table public.raffle_sale_buyers enable row level security;
revoke all on table public.raffle_sale_buyers from public, anon, authenticated, service_role;
revoke all on function public.find_raffle_buyer(text) from public, anon, authenticated, service_role;
revoke all on function public.reserve_raffle_numbers_pdv(uuid, uuid, integer[], uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.cancel_raffle_reservation(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_raffles_for_seller() from public, anon, authenticated, service_role;
grant execute on function public.find_raffle_buyer(text) to authenticated;
grant execute on function public.reserve_raffle_numbers_pdv(uuid, uuid, integer[], uuid, text, text, text, uuid) to authenticated;
grant execute on function public.cancel_raffle_reservation(uuid, text, uuid) to authenticated;
grant execute on function public.list_raffles_for_seller() to authenticated;
