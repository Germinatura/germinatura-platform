-- Spec 4.4, 5.11 and 15.5 (RAF-001, RAF-002): raffle administration lifecycle and buyer privacy.
-- * Lifecycle: a campaign starts as DRAFT (editable: name, description, product, location, quantity and period),
--   is published (numbers are generated then and the structure becomes immutable), can be paused and resumed while
--   sales are open, closed (the eligible universe freezes), drawn once, or cancelled before the draw.
-- * Cancelling releases pending reservations idempotently; paid numbers stay paid until finance refunds each sale.
--   After close only a whole-campaign cancellation reopens refunds; after the draw nothing can be cancelled.
-- * Privacy: buyers no longer read raffle_numbers (which names who reserved each number). They get a number board
--   (available / taken / mine) and their own tickets through RPCs; managers get occupancy through an admin RPC.

alter table public.raffle_campaigns drop constraint raffle_campaign_state_valid;
alter table public.raffle_campaigns
  add column description text,
  add column published_at timestamptz,
  add column paused_at timestamptz,
  add column cancelled_at timestamptz,
  add column cancel_reason text,
  add constraint raffle_campaign_description_valid check (description is null or (char_length(description) between 1 and 1000 and description = btrim(description))),
  add constraint raffle_campaign_cancel_reason_valid check (cancel_reason is null or (char_length(cancel_reason) between 3 and 300 and cancel_reason = btrim(cancel_reason))),
  add constraint raffle_campaign_state_valid check (
    (status = 'DRAFT' and published_at is null and closed_at is null and drawn_at is null and cancelled_at is null)
    or (status in ('ACTIVE', 'PAUSED') and closed_at is null and drawn_at is null and cancelled_at is null)
    or (status = 'CLOSED' and closed_at is not null and drawn_at is null and cancelled_at is null)
    or (status = 'DRAWN' and closed_at is not null and drawn_at is not null and cancelled_at is null)
    or (status = 'CANCELLED' and drawn_at is null)
  );
alter table public.raffle_campaigns alter column status set default 'DRAFT';
-- Campaigns created before the draft step were already on sale.
update public.raffle_campaigns set published_at = created_at where published_at is null and status <> 'DRAFT';

-- Structure is editable only while drafting; status moves only along the lifecycle.
create or replace function private.guard_raffle_campaign()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'DRAFT' and (new.number_count <> old.number_count or new.product_id <> old.product_id
    or new.location_id <> old.location_id or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at
    or new.name <> old.name or new.description is distinct from old.description) then
    raise exception using errcode = 'P0001', message = 'RAFFLE_STRUCTURE_LOCKED';
  end if;
  if new.status <> old.status and not (
    (old.status = 'DRAFT' and new.status in ('ACTIVE', 'CANCELLED'))
    or (old.status = 'ACTIVE' and new.status in ('PAUSED', 'CLOSED', 'CANCELLED'))
    or (old.status = 'PAUSED' and new.status in ('ACTIVE', 'CLOSED', 'CANCELLED'))
    or (old.status = 'CLOSED' and new.status in ('DRAWN', 'CANCELLED'))
  ) then
    raise exception using errcode = 'P0001', message = 'RAFFLE_TRANSITION_INVALID';
  end if;
  return new;
end;
$$;
create trigger raffle_campaigns_guard before update on public.raffle_campaigns
for each row execute function private.guard_raffle_campaign();

-- The "new raffle" notice now goes out when a campaign is published, not when it is drafted.
create or replace function private.emit_raffle_opened()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'ACTIVE' and (tg_op = 'INSERT' or old.status = 'DRAFT') then
    perform private.queue_broadcast_once('RAFFLE', new.id, 'raffles.campaign.opened', 'raffle_campaign');
  end if;
  return new;
end;
$$;
create trigger raffle_campaigns_broadcast_published after update of status on public.raffle_campaigns
for each row execute function private.emit_raffle_opened();

create or replace function private.require_raffle_manager()
returns uuid language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('raffles.manage') then
    raise exception using errcode = '42501', message = 'RAFFLE_MANAGE_FORBIDDEN';
  end if;
  return auth.uid();
end;
$$;

create or replace function private.raffle_campaign_json(p_campaign public.raffle_campaigns)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('campaign_id', p_campaign.id, 'status', p_campaign.status, 'name', p_campaign.name,
    'number_count', p_campaign.number_count, 'starts_at', p_campaign.starts_at, 'ends_at', p_campaign.ends_at,
    'correlation_id', p_campaign.correlation_id);
$$;

create or replace function private.validate_raffle_structure(
  p_name text, p_description text, p_product_id uuid, p_location_id uuid, p_number_count integer,
  p_starts_at timestamptz, p_ends_at timestamptz
)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_name is null or char_length(p_name) not between 1 and 160 or p_name <> btrim(p_name)
    or (p_description is not null and (char_length(p_description) not between 1 and 1000 or p_description <> btrim(p_description)))
    or p_number_count is null or p_number_count not between 1 and 10000
    or p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_CAMPAIGN';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and active and published)
    or not exists (select 1 from public.stock_locations where id = p_location_id and active and location_type = 'CENTRAL') then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_CAMPAIGN_CONTEXT';
  end if;
end;
$$;

-- Same signature as before; a new campaign is a draft without numbers.
create or replace function public.create_raffle_campaign(
  p_name text, p_product_id uuid, p_location_id uuid, p_number_count integer,
  p_starts_at timestamptz, p_ends_at timestamptz, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := private.require_raffle_manager();
  v_claim record;
  v_campaign public.raffle_campaigns%rowtype;
  v_result jsonb;
begin
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_CAMPAIGN';
  end if;
  perform private.validate_raffle_structure(p_name, null, p_product_id, p_location_id, p_number_count, p_starts_at, p_ends_at);
  select * into v_claim from private.claim_idempotency(private.build_idempotency_scope('raffles', 'campaign_create', v_actor_id),
    p_idempotency_key, jsonb_build_object('name', p_name, 'product_id', p_product_id, 'location_id', p_location_id,
      'number_count', p_number_count, 'starts_at', p_starts_at, 'ends_at', p_ends_at));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  insert into public.raffle_campaigns (name, product_id, location_id, number_count, status, starts_at, ends_at, created_by, correlation_id)
  values (p_name, p_product_id, p_location_id, p_number_count, 'DRAFT', p_starts_at, p_ends_at, v_actor_id, p_correlation_id)
  returning * into v_campaign;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('raffles.campaign.created', v_actor_id, 'raffle_campaign', v_campaign.id::text, p_correlation_id,
    jsonb_build_object('number_count', p_number_count, 'status', 'DRAFT'));
  v_result := private.raffle_campaign_json(v_campaign);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'raffle_campaign', v_campaign.id::text);
  return v_result;
end;
$$;

create or replace function public.update_raffle_campaign(
  p_campaign_id uuid, p_name text, p_description text, p_product_id uuid, p_location_id uuid, p_number_count integer,
  p_starts_at timestamptz, p_ends_at timestamptz, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := private.require_raffle_manager();
  v_claim record;
  v_campaign public.raffle_campaigns%rowtype;
  v_result jsonb;
begin
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_CAMPAIGN';
  end if;
  perform private.validate_raffle_structure(p_name, nullif(btrim(coalesce(p_description, '')), ''), p_product_id,
    p_location_id, p_number_count, p_starts_at, p_ends_at);
  select * into v_claim from private.claim_idempotency(private.build_idempotency_scope('raffles', 'campaign_update', v_actor_id),
    p_idempotency_key, jsonb_build_object('campaign_id', p_campaign_id, 'name', p_name, 'description', p_description,
      'product_id', p_product_id, 'location_id', p_location_id, 'number_count', p_number_count,
      'starts_at', p_starts_at, 'ends_at', p_ends_at));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_campaign from public.raffle_campaigns where id = p_campaign_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'RAFFLE_CAMPAIGN_NOT_FOUND'; end if;
  if v_campaign.status <> 'DRAFT' then raise exception using errcode = 'P0001', message = 'RAFFLE_STRUCTURE_LOCKED'; end if;
  update public.raffle_campaigns
  set name = p_name, description = nullif(btrim(coalesce(p_description, '')), ''), product_id = p_product_id,
      location_id = p_location_id, number_count = p_number_count, starts_at = p_starts_at, ends_at = p_ends_at
  where id = v_campaign.id returning * into v_campaign;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('raffles.campaign.updated', v_actor_id, 'raffle_campaign', v_campaign.id::text, p_correlation_id,
    jsonb_build_object('number_count', p_number_count));
  v_result := private.raffle_campaign_json(v_campaign);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'raffle_campaign', v_campaign.id::text);
  return v_result;
end;
$$;

-- Moves a campaign along the lifecycle: PUBLISH, PAUSE, RESUME or CLOSE.
create or replace function public.transition_raffle_campaign(
  p_campaign_id uuid, p_action text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := private.require_raffle_manager();
  v_claim record;
  v_campaign public.raffle_campaigns%rowtype;
  v_result jsonb;
begin
  if p_action not in ('PUBLISH', 'PAUSE', 'RESUME', 'CLOSE') or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_ACTION';
  end if;
  select * into v_claim from private.claim_idempotency(private.build_idempotency_scope('raffles', 'campaign_transition', v_actor_id),
    p_idempotency_key, jsonb_build_object('campaign_id', p_campaign_id, 'action', p_action));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_campaign from public.raffle_campaigns where id = p_campaign_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'RAFFLE_CAMPAIGN_NOT_FOUND'; end if;

  if p_action = 'PUBLISH' then
    if v_campaign.status <> 'DRAFT' then raise exception using errcode = 'P0001', message = 'RAFFLE_TRANSITION_INVALID'; end if;
    perform private.validate_raffle_structure(v_campaign.name, v_campaign.description, v_campaign.product_id,
      v_campaign.location_id, v_campaign.number_count, v_campaign.starts_at, v_campaign.ends_at);
    if v_campaign.ends_at <= clock_timestamp() then
      raise exception using errcode = 'P0001', message = 'RAFFLE_PERIOD_OVER';
    end if;
    insert into public.raffle_numbers (campaign_id, number)
    select v_campaign.id, value from generate_series(1, v_campaign.number_count) value
    on conflict do nothing;
    update public.raffle_campaigns set status = 'ACTIVE', published_at = clock_timestamp()
    where id = v_campaign.id returning * into v_campaign;
  elsif p_action = 'PAUSE' then
    if v_campaign.status <> 'ACTIVE' then raise exception using errcode = 'P0001', message = 'RAFFLE_TRANSITION_INVALID'; end if;
    update public.raffle_campaigns set status = 'PAUSED', paused_at = clock_timestamp()
    where id = v_campaign.id returning * into v_campaign;
  elsif p_action = 'RESUME' then
    if v_campaign.status <> 'PAUSED' then raise exception using errcode = 'P0001', message = 'RAFFLE_TRANSITION_INVALID'; end if;
    if v_campaign.ends_at <= clock_timestamp() then
      raise exception using errcode = 'P0001', message = 'RAFFLE_PERIOD_OVER';
    end if;
    update public.raffle_campaigns set status = 'ACTIVE', paused_at = null
    where id = v_campaign.id returning * into v_campaign;
  else
    if v_campaign.status not in ('ACTIVE', 'PAUSED') then raise exception using errcode = 'P0001', message = 'RAFFLE_TRANSITION_INVALID'; end if;
    if exists (select 1 from public.raffle_numbers where campaign_id = v_campaign.id and status = 'RESERVED') then
      raise exception using errcode = 'P0001', message = 'RAFFLE_PENDING_RESERVATIONS';
    end if;
    update public.raffle_campaigns set status = 'CLOSED', closed_at = clock_timestamp()
    where id = v_campaign.id returning * into v_campaign;
  end if;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('raffles.campaign.' || lower(p_action), v_actor_id, 'raffle_campaign', v_campaign.id::text, p_correlation_id,
    jsonb_build_object('status', v_campaign.status));
  v_result := private.raffle_campaign_json(v_campaign);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'raffle_campaign', v_campaign.id::text);
  return v_result;
end;
$$;

-- Kept for existing callers: closing is the CLOSE transition.
create or replace function public.close_raffle_campaign(p_campaign_id uuid, p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return public.transition_raffle_campaign(p_campaign_id, 'CLOSE', p_idempotency_key, p_correlation_id);
end;
$$;

-- Cancels a campaign before its draw. Pending reservations are released (their sales cancelled); paid numbers stay
-- paid so finance can refund each sale, and the cancellation is announced through the outbox.
create or replace function public.cancel_raffle_campaign(
  p_campaign_id uuid, p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := private.require_raffle_manager();
  v_claim record;
  v_campaign public.raffle_campaigns%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_sale_id uuid;
  v_attempt public.payment_attempts%rowtype;
  v_released integer := 0;
  v_paid integer;
  v_result jsonb;
begin
  if char_length(v_reason) not between 3 and 300 or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_CANCELLATION';
  end if;
  select * into v_claim from private.claim_idempotency(private.build_idempotency_scope('raffles', 'campaign_cancel', v_actor_id),
    p_idempotency_key, jsonb_build_object('campaign_id', p_campaign_id, 'reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_campaign from public.raffle_campaigns where id = p_campaign_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'RAFFLE_CAMPAIGN_NOT_FOUND'; end if;
  if v_campaign.status = 'DRAWN' then raise exception using errcode = 'P0001', message = 'RAFFLE_ALREADY_DRAWN'; end if;
  if v_campaign.status = 'CANCELLED' then raise exception using errcode = 'P0001', message = 'RAFFLE_TRANSITION_INVALID'; end if;

  for v_sale_id in
    select distinct sale_id from public.raffle_numbers
    where campaign_id = v_campaign.id and status = 'RESERVED' order by sale_id
  loop
    perform 1 from public.sales where id = v_sale_id for update;
    select * into v_attempt from public.payment_attempts where sale_id = v_sale_id order by created_at desc, id desc limit 1 for update;
    if found and v_attempt.status not in ('CANCELLED', 'APPROVED') then
      perform private.transition_payment_attempt(v_attempt.id, 'CANCELLED', v_actor_id, p_correlation_id, 'Rifa cancelada');
    end if;
    if (select status from public.sales where id = v_sale_id) = 'AWAITING_PAYMENT' then
      perform private.transition_sale_state(v_sale_id, 'CANCELLED', v_actor_id, p_correlation_id, 'Rifa cancelada');
    end if;
    update public.raffle_numbers set status = 'AVAILABLE', reserved_by = null, sale_id = null, payment_attempt_id = null,
      reserved_at = null, expires_at = null, paid_at = null
    where campaign_id = v_campaign.id and sale_id = v_sale_id and status = 'RESERVED';
    v_released := v_released + 1;
  end loop;
  select count(distinct sale_id)::integer into v_paid from public.raffle_numbers where campaign_id = v_campaign.id and status = 'PAID';

  update public.raffle_campaigns set status = 'CANCELLED', cancelled_at = clock_timestamp(), cancel_reason = v_reason
  where id = v_campaign.id returning * into v_campaign;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('raffles.campaign.cancelled', v_actor_id, 'raffle_campaign', v_campaign.id::text, p_correlation_id,
    jsonb_build_object('reason', v_reason, 'released_reservations', v_released, 'paid_sales_to_refund', v_paid));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('raffles.campaign.cancelled', 'raffle_campaign', v_campaign.id::text,
    jsonb_build_object('campaign_id', v_campaign.id, 'paid_sales_to_refund', v_paid, 'correlation_id', p_correlation_id));
  v_result := private.raffle_campaign_json(v_campaign)
    || jsonb_build_object('released_reservations', v_released, 'paid_sales_to_refund', v_paid);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'raffle_campaign', v_campaign.id::text);
  return v_result;
end;
$$;

-- Buyers see raffles and their own tickets, never who holds the other numbers.
create or replace function public.list_raffles_for_buyer()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null or not (public.has_permission('raffles.buy') or public.has_permission('raffles.manage')) then
    raise exception using errcode = '42501', message = 'RAFFLE_BUY_FORBIDDEN';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'campaign_id', campaign.id, 'name', campaign.name, 'description', campaign.description,
      'product_name', product.name, 'status', campaign.status, 'number_count', campaign.number_count,
      'starts_at', campaign.starts_at, 'ends_at', campaign.ends_at,
      'unit_price_cents', (select price.amount_cents from public.product_prices price
        where price.product_id = campaign.product_id and price.valid_from <= clock_timestamp()
          and (price.valid_to is null or price.valid_to > clock_timestamp()) order by price.valid_from desc limit 1),
      'available_count', (select count(*) from public.raffle_numbers item where item.campaign_id = campaign.id and item.status = 'AVAILABLE'),
      'my_numbers', coalesce((select jsonb_agg(jsonb_build_object('number', item.number, 'status', item.status,
          'sale_id', item.sale_id, 'expires_at', item.expires_at) order by item.number)
        from public.raffle_numbers item where item.campaign_id = campaign.id and item.reserved_by = v_actor_id
          and item.status in ('RESERVED', 'PAID')), '[]'::jsonb),
      'draw', (select jsonb_build_object('winner_number', draw.winner_number, 'audit_hash', draw.audit_hash,
          'drawn_at', draw.created_at) from public.raffle_draws draw where draw.campaign_id = campaign.id)
    ) order by campaign.ends_at desc, campaign.id)
    from public.raffle_campaigns campaign
    join public.products product on product.id = campaign.product_id
    where campaign.status in ('ACTIVE', 'PAUSED', 'CLOSED')
      or (campaign.status = 'DRAWN' and campaign.drawn_at > clock_timestamp() - interval '30 days')
      or (campaign.status = 'CANCELLED' and campaign.published_at is not null and campaign.cancelled_at > clock_timestamp() - interval '30 days')
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_raffle_number_board(p_campaign_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null or not (public.has_permission('raffles.buy') or public.has_permission('raffles.sell') or public.has_permission('raffles.manage')) then
    raise exception using errcode = '42501', message = 'RAFFLE_BUY_FORBIDDEN';
  end if;
  if not exists (select 1 from public.raffle_campaigns where id = p_campaign_id and status <> 'DRAFT') then
    raise exception using errcode = 'P0001', message = 'RAFFLE_CAMPAIGN_NOT_FOUND';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_array(item.number,
      case when item.reserved_by = v_actor_id then 'MINE' when item.status = 'AVAILABLE' then 'AVAILABLE' else 'TAKEN' end)
      order by item.number)
    from public.raffle_numbers item where item.campaign_id = p_campaign_id
  ), '[]'::jsonb);
end;
$$;

-- Managers see occupancy, the value paid and the draw evidence of every campaign.
create or replace function public.list_raffles_admin(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_raffle_manager();
  if p_limit not between 1 and 200 then raise exception using errcode = '22023', message = 'INVALID_FILTER'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'campaign_id', campaign.id, 'name', campaign.name, 'description', campaign.description,
      'product_id', campaign.product_id, 'product_name', product.name, 'location_id', campaign.location_id,
      'status', campaign.status, 'number_count', campaign.number_count,
      'starts_at', campaign.starts_at, 'ends_at', campaign.ends_at, 'published_at', campaign.published_at,
      'closed_at', campaign.closed_at, 'cancelled_at', campaign.cancelled_at, 'cancel_reason', campaign.cancel_reason,
      'available_count', coalesce(counts.available, 0), 'reserved_count', coalesce(counts.reserved, 0),
      'paid_count', coalesce(counts.paid, 0), 'paid_total_cents', coalesce(paid.total_cents, 0),
      'paid_sales', coalesce(paid.sales, 0),
      'draw', (select jsonb_build_object('winner_number', draw.winner_number, 'winner_index', draw.winner_index,
          'eligible_numbers', draw.eligible_numbers, 'random_material', draw.random_material,
          'audit_hash', draw.audit_hash, 'drawn_at', draw.created_at)
        from public.raffle_draws draw where draw.campaign_id = campaign.id)
    ) order by campaign.created_at desc, campaign.id)
    from (select * from public.raffle_campaigns order by created_at desc, id limit p_limit) campaign
    join public.products product on product.id = campaign.product_id
    left join lateral (
      select count(*) filter (where status = 'AVAILABLE') available, count(*) filter (where status = 'RESERVED') reserved,
        count(*) filter (where status = 'PAID') paid
      from public.raffle_numbers where campaign_id = campaign.id
    ) counts on true
    left join lateral (
      select sum(sale.total_cents) total_cents, count(*) sales from public.sales sale
      where sale.id in (select distinct sale_id from public.raffle_numbers where campaign_id = campaign.id and status = 'PAID')
    ) paid on true
  ), '[]'::jsonb);
end;
$$;

drop policy raffle_numbers_authenticated_read on public.raffle_numbers;
revoke select on table public.raffle_numbers from authenticated;
drop policy raffle_campaigns_authenticated_read on public.raffle_campaigns;
create policy raffle_campaigns_authenticated_read on public.raffle_campaigns for select to authenticated
  using (public.has_permission('raffles.manage') or (status <> 'DRAFT' and public.has_permission('raffles.buy')));

revoke all on function private.guard_raffle_campaign() from public, anon, authenticated, service_role;
revoke all on function private.require_raffle_manager() from public, anon, authenticated, service_role;
revoke all on function private.raffle_campaign_json(public.raffle_campaigns) from public, anon, authenticated, service_role;
revoke all on function private.validate_raffle_structure(text, text, uuid, uuid, integer, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.update_raffle_campaign(uuid, text, text, uuid, uuid, integer, timestamptz, timestamptz, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.transition_raffle_campaign(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.cancel_raffle_campaign(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_raffles_for_buyer() from public, anon, authenticated, service_role;
revoke all on function public.get_raffle_number_board(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_raffles_admin(integer) from public, anon, authenticated, service_role;
grant execute on function public.update_raffle_campaign(uuid, text, text, uuid, uuid, integer, timestamptz, timestamptz, text, uuid) to authenticated;
grant execute on function public.transition_raffle_campaign(uuid, text, text, uuid) to authenticated;
grant execute on function public.cancel_raffle_campaign(uuid, text, text, uuid) to authenticated;
grant execute on function public.list_raffles_for_buyer() to authenticated;
grant execute on function public.get_raffle_number_board(uuid) to authenticated;
grant execute on function public.list_raffles_admin(integer) to authenticated;
