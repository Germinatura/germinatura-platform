-- C: the PDV's registered-buyer lookup for a raffle sale respects the concrete cohort of the operation.
-- Before, a seller of cohort A could type the exact e-mail or username of someone of cohort B and get their display name
-- (and learn that the global identity exists). Now the lookup and the reservation only know people of the operation's
-- cohort: active, onboarded and with an ACTIVE membership there. Someone of another cohort, an unknown identifier, a
-- sign-up attempt (no domain user) and a legacy profile that never confirmed (never onboarded) are indistinguishable:
-- nobody is found. The walk-in path (name and one contact, no profile) is unchanged. "Todas as turmas" is not a sale
-- context: the lookup is refused there, and nothing falls back to the default cohort.

create function private.raffle_buyer_eligible(p_profile_id uuid, p_cohort_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_profile_id is not null and p_cohort_id is not null and exists (
    select 1 from public.profiles profile
    join public.user_cohorts membership on membership.user_id = profile.id
      and membership.cohort_id = p_cohort_id and membership.status = 'ACTIVE'
    where profile.id = p_profile_id and profile.active and profile.onboarding_completed_at is not null)
$$;
revoke all on function private.raffle_buyer_eligible(uuid, uuid) from public, anon, authenticated, service_role;

-- Finds a registered buyer only by an exact email or username, only inside the operation's cohort, so the PDV cannot
-- browse customers nor reach another cohort. The answer carries user_id; nothing downstream depends on the username.
create or replace function public.find_raffle_buyer(p_identifier text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_identifier text := lower(btrim(coalesce(p_identifier, '')));
  v_cohort uuid := private.cohort_permission_id();
  v_profile public.profiles%rowtype;
begin
  if auth.uid() is null or not public.has_permission('raffles.sell') then
    raise exception using errcode = '42501', message = 'RAFFLE_SELL_FORBIDDEN';
  end if;
  if private.cohort_mode() <> 'COHORT' or v_cohort is null then
    raise exception using errcode = '22023', message = 'COHORT_REQUIRED';
  end if;
  if char_length(v_identifier) not between 3 and 254 then
    raise exception using errcode = '22023', message = 'INVALID_BUYER_IDENTIFIER';
  end if;
  select profile.* into v_profile from public.profiles profile
  where (lower(profile.email) = v_identifier or profile.username = v_identifier)
    and private.raffle_buyer_eligible(profile.id, v_cohort)
  limit 1;
  if not found then return null; end if;
  return jsonb_build_object('profile_id', v_profile.id,
    'display_name', coalesce(nullif(btrim(v_profile.display_name), ''), split_part(v_profile.email, '@', 1)));
end;
$$;

-- The reservation enforces the same rule on the profile id it receives, whatever the client sent.
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
  -- A registered buyer must be a person of the campaign's cohort. Someone of another cohort, an attempt that never
  -- confirmed and an unknown id are refused the same way: an unidentified buyer (the walk-in path stays available).
  -- (An unknown campaign keeps failing on the campaign check below, as before.)
  if p_buyer_profile_id is not null and exists (select 1 from cohort_data.raffle_campaigns campaign where campaign.id = p_campaign_id)
    and not private.raffle_buyer_eligible(p_buyer_profile_id,
      (select campaign.cohort_id from cohort_data.raffle_campaigns campaign where campaign.id = p_campaign_id)) then
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
