create type public.raffle_campaign_status as enum ('ACTIVE', 'CLOSED', 'DRAWN', 'CANCELLED');
create type public.raffle_number_status as enum ('AVAILABLE', 'RESERVED', 'PAID');

create table public.raffle_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  product_id uuid not null references public.products(id) on delete restrict,
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  number_count integer not null,
  status public.raffle_campaign_status not null default 'ACTIVE',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  closed_at timestamptz,
  drawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint raffle_campaign_name_valid check (char_length(name) between 1 and 160 and name = btrim(name)),
  constraint raffle_campaign_number_count_valid check (number_count between 1 and 10000),
  constraint raffle_campaign_period_valid check (ends_at > starts_at),
  constraint raffle_campaign_state_valid check (
    (status = 'ACTIVE' and closed_at is null and drawn_at is null)
    or (status = 'CLOSED' and closed_at is not null and drawn_at is null)
    or (status = 'DRAWN' and closed_at is not null and drawn_at is not null)
    or (status = 'CANCELLED' and drawn_at is null)
  )
);

create table public.raffle_numbers (
  campaign_id uuid not null references public.raffle_campaigns(id) on delete restrict,
  number integer not null,
  status public.raffle_number_status not null default 'AVAILABLE',
  reserved_by uuid references public.profiles(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  payment_attempt_id uuid references public.payment_attempts(id) on delete restrict,
  reserved_at timestamptz,
  expires_at timestamptz,
  paid_at timestamptz,
  primary key (campaign_id, number),
  constraint raffle_number_state_valid check (
    (status = 'AVAILABLE' and reserved_by is null and sale_id is null and payment_attempt_id is null
      and reserved_at is null and expires_at is null and paid_at is null)
    or (status = 'RESERVED' and reserved_by is not null and sale_id is not null and payment_attempt_id is not null
      and reserved_at is not null and expires_at is not null and paid_at is null)
    or (status = 'PAID' and reserved_by is not null and sale_id is not null and payment_attempt_id is not null
      and reserved_at is not null and expires_at is not null and paid_at is not null)
  )
);
create unique index raffle_numbers_campaign_sale_number_unique
  on public.raffle_numbers (campaign_id, sale_id, number) where sale_id is not null;
create index raffle_numbers_expiry_idx on public.raffle_numbers (expires_at, campaign_id, number)
  where status = 'RESERVED';

create table public.raffle_draws (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null unique references public.raffle_campaigns(id) on delete restrict,
  eligible_numbers integer[] not null,
  random_material text not null,
  audit_hash text not null,
  winner_index integer not null,
  winner_number integer not null,
  drawn_by uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint raffle_draw_eligible_valid check (cardinality(eligible_numbers) > 0),
  constraint raffle_draw_material_valid check (random_material ~ '^[0-9a-f]{64}$'),
  constraint raffle_draw_hash_valid check (audit_hash ~ '^[0-9a-f]{64}$'),
  constraint raffle_draw_index_valid check (winner_index between 1 and cardinality(eligible_numbers)),
  constraint raffle_draw_winner_valid check (winner_number = eligible_numbers[winner_index])
);

create trigger raffle_campaigns_set_updated_at before update on public.raffle_campaigns
for each row execute function private.set_updated_at();
create trigger raffle_campaigns_prevent_delete before delete on public.raffle_campaigns
for each row execute function private.prevent_inventory_hard_delete();
create trigger raffle_numbers_prevent_delete before delete on public.raffle_numbers
for each row execute function private.prevent_inventory_hard_delete();
create trigger raffle_draws_immutable before update or delete on public.raffle_draws
for each row execute function private.prevent_immutable_record_change();

create or replace function public.create_raffle_campaign(
  p_name text,
  p_product_id uuid,
  p_location_id uuid,
  p_number_count integer,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
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
  v_scope text;
  v_claim record;
  v_campaign_id uuid := gen_random_uuid();
  v_result jsonb;
begin
  if v_actor_id is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('raffles.manage') then
    raise exception using errcode = '42501', message = 'RAFFLE_MANAGE_FORBIDDEN';
  end if;
  if p_name is null or char_length(p_name) not between 1 and 160 or p_name <> btrim(p_name)
    or p_number_count not between 1 and 10000 or p_starts_at is null or p_ends_at is null
    or p_ends_at <= p_starts_at or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_CAMPAIGN';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and active and published)
    or not exists (select 1 from public.stock_locations where id = p_location_id and active and location_type = 'CENTRAL') then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_CAMPAIGN_CONTEXT';
  end if;
  v_scope := private.build_idempotency_scope('raffles', 'campaign_create', v_actor_id);
  select * into v_claim from private.claim_idempotency(v_scope, p_idempotency_key, jsonb_build_object(
    'name', p_name, 'product_id', p_product_id, 'location_id', p_location_id,
    'number_count', p_number_count, 'starts_at', p_starts_at, 'ends_at', p_ends_at
  ));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  insert into public.raffle_campaigns (
    id, name, product_id, location_id, number_count, starts_at, ends_at, created_by, correlation_id
  ) values (
    v_campaign_id, p_name, p_product_id, p_location_id, p_number_count,
    p_starts_at, p_ends_at, v_actor_id, p_correlation_id
  );
  insert into public.raffle_numbers (campaign_id, number)
  select v_campaign_id, value from generate_series(1, p_number_count) value;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('raffles.campaign.created', v_actor_id, 'raffle_campaign', v_campaign_id::text,
    p_correlation_id, jsonb_build_object('number_count', p_number_count));
  v_result := jsonb_build_object('campaign_id', v_campaign_id, 'status', 'ACTIVE',
    'number_count', p_number_count, 'starts_at', p_starts_at, 'ends_at', p_ends_at,
    'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'raffle_campaign', v_campaign_id::text);
  return v_result;
end;
$$;

create or replace function public.reserve_raffle_numbers(
  p_campaign_id uuid,
  p_numbers integer[],
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
  v_campaign public.raffle_campaigns%rowtype;
  v_numbers integer[];
  v_scope text;
  v_claim record;
  v_quote jsonb;
  v_sale_id uuid := gen_random_uuid();
  v_attempt_id uuid := gen_random_uuid();
  v_expires_at timestamptz := clock_timestamp() + interval '10 minutes';
  v_result jsonb;
begin
  if v_actor_id is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('raffles.buy') or p_correlation_id is null then
    raise exception using errcode = '42501', message = 'RAFFLE_BUY_FORBIDDEN';
  end if;
  select array_agg(distinct value order by value) into v_numbers from unnest(p_numbers) value;
  if v_numbers is null or cardinality(v_numbers) not between 1 and 100
    or cardinality(v_numbers) <> cardinality(p_numbers) then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_NUMBERS';
  end if;
  select * into v_campaign from public.raffle_campaigns where id = p_campaign_id for update;
  if not found or v_campaign.status <> 'ACTIVE'
    or clock_timestamp() < v_campaign.starts_at or clock_timestamp() >= v_campaign.ends_at then
    raise exception using errcode = 'P0001', message = 'RAFFLE_CAMPAIGN_NOT_AVAILABLE';
  end if;
  if v_numbers[1] < 1 or v_numbers[cardinality(v_numbers)] > v_campaign.number_count then
    raise exception using errcode = '22023', message = 'INVALID_RAFFLE_NUMBERS';
  end if;
  v_scope := private.build_idempotency_scope('raffles', 'reserve_numbers', v_actor_id);
  select * into v_claim from private.claim_idempotency(v_scope, p_idempotency_key,
    jsonb_build_object('campaign_id', p_campaign_id, 'numbers', to_jsonb(v_numbers)));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  perform number from public.raffle_numbers
  where campaign_id = p_campaign_id and number = any(v_numbers)
  order by number for update;
  if (select count(*) from public.raffle_numbers
      where campaign_id = p_campaign_id and number = any(v_numbers) and status = 'AVAILABLE') <> cardinality(v_numbers) then
    raise exception using errcode = 'P0001', message = 'RAFFLE_NUMBER_CONFLICT';
  end if;
  v_quote := private.price_sale_items('PORTAL', jsonb_build_array(jsonb_build_object(
    'product_id', v_campaign.product_id, 'quantity', cardinality(v_numbers)
  )));
  insert into public.sales (
    id, channel, location_id, created_by, customer_id,
    original_total_cents, discount_total_cents, total_cents, quoted_at, correlation_id
  ) values (
    v_sale_id, 'PORTAL', v_campaign.location_id, v_actor_id, v_actor_id,
    (v_quote ->> 'original_total_cents')::bigint, (v_quote ->> 'discount_total_cents')::bigint,
    (v_quote ->> 'total_cents')::bigint, (v_quote ->> 'quoted_at')::timestamptz, p_correlation_id
  );
  insert into public.sale_items (
    sale_id, product_id, product_sku, product_name, quantity, unit_price_cents,
    original_subtotal_cents, discount_cents, total_cents, promotion_id, promotion_snapshot
  )
  select v_sale_id, line.product_id, line.product_sku, line.product_name, line.quantity,
    line.unit_price_cents, line.original_subtotal_cents, line.discount_cents, line.total_cents,
    line.promotion_id, line.promotion_snapshot
  from jsonb_to_recordset(v_quote -> 'lines') as line(
    product_id uuid, product_sku text, product_name text, quantity bigint,
    unit_price_cents bigint, original_subtotal_cents bigint, discount_cents bigint,
    total_cents bigint, promotion_id uuid, promotion_snapshot jsonb
  );
  perform private.assert_sale_totals(v_sale_id);
  insert into public.payment_attempts (id, sale_id, amount_cents, operator_id, idempotency_key, correlation_id)
  values (v_attempt_id, v_sale_id, (v_quote ->> 'total_cents')::bigint, v_actor_id, p_idempotency_key, p_correlation_id);
  perform private.transition_sale_state(v_sale_id, 'AWAITING_PAYMENT', v_actor_id, p_correlation_id, null);
  update public.raffle_numbers set status = 'RESERVED', reserved_by = v_actor_id,
    sale_id = v_sale_id, payment_attempt_id = v_attempt_id,
    reserved_at = now(), expires_at = v_expires_at
  where campaign_id = p_campaign_id and number = any(v_numbers);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('raffles.numbers.reserved', v_actor_id, 'raffle_campaign', p_campaign_id::text,
    p_correlation_id, jsonb_build_object('numbers', v_numbers, 'sale_id', v_sale_id));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('raffles.numbers.reserved', 'raffle_campaign', p_campaign_id::text,
    jsonb_build_object('campaign_id', p_campaign_id, 'numbers', v_numbers, 'sale_id', v_sale_id, 'expires_at', v_expires_at));
  v_result := jsonb_build_object('campaign_id', p_campaign_id, 'numbers', v_numbers,
    'status', 'RESERVED', 'sale_id', v_sale_id, 'sale_status', 'AWAITING_PAYMENT',
    'payment_attempt_id', v_attempt_id, 'total_cents', v_quote -> 'total_cents',
    'expires_at', v_expires_at, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale_id::text);
  return v_result;
end;
$$;

create or replace function public.cancel_raffle_reservation(
  p_sale_id uuid,
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
  v_campaign_id uuid;
  v_numbers integer[];
  v_scope text;
  v_claim record;
  v_result jsonb;
begin
  if v_actor_id is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.customer_id <> v_actor_id then
    raise exception using errcode = 'P0001', message = 'RAFFLE_RESERVATION_NOT_FOUND';
  end if;
  v_scope := private.build_idempotency_scope('raffles', 'cancel_reservation', v_actor_id);
  select * into v_claim from private.claim_idempotency(v_scope, p_idempotency_key, jsonb_build_object('sale_id', p_sale_id));
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
  select * into v_attempt from public.payment_attempts where sale_id = p_sale_id for update;
  if v_attempt.status <> 'CANCELLED' then
    v_attempt := private.transition_payment_attempt(v_attempt.id, 'CANCELLED', v_actor_id, p_correlation_id, 'Reserva de rifa cancelada');
  end if;
  if v_sale.status <> 'CANCELLED' then
    v_sale := private.transition_sale_state(v_sale.id, 'CANCELLED', v_actor_id, p_correlation_id, 'Reserva de rifa cancelada');
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

create or replace function private.mark_raffle_numbers_paid()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'CONFIRMED' and new.status = 'CONFIRMED' then
    update public.raffle_numbers set status = 'PAID', paid_at = now()
    where sale_id = new.id and status = 'RESERVED';
  end if;
  return new;
end;
$$;
create trigger sales_mark_raffle_numbers_paid after update of status on public.sales
for each row execute function private.mark_raffle_numbers_paid();

create or replace function public.close_raffle_campaign(
  p_campaign_id uuid, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor_id uuid := auth.uid(); v_campaign public.raffle_campaigns%rowtype; v_scope text; v_claim record; v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('raffles.manage') then
    raise exception using errcode = '42501', message = 'RAFFLE_MANAGE_FORBIDDEN';
  end if;
  v_scope := private.build_idempotency_scope('raffles', 'campaign_close', v_actor_id);
  select * into v_claim from private.claim_idempotency(v_scope, p_idempotency_key, jsonb_build_object('campaign_id', p_campaign_id));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_campaign from public.raffle_campaigns where id = p_campaign_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'RAFFLE_CAMPAIGN_NOT_FOUND'; end if;
  if v_campaign.status = 'ACTIVE' then
    if exists (select 1 from public.raffle_numbers where campaign_id = p_campaign_id and status = 'RESERVED') then
      raise exception using errcode = 'P0001', message = 'RAFFLE_PENDING_RESERVATIONS';
    end if;
    update public.raffle_campaigns set status = 'CLOSED', closed_at = now() where id = p_campaign_id;
  elsif v_campaign.status <> 'CLOSED' then
    raise exception using errcode = 'P0001', message = 'RAFFLE_CAMPAIGN_NOT_CLOSABLE';
  end if;
  v_result := jsonb_build_object('campaign_id', p_campaign_id, 'status', 'CLOSED', 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'raffle_campaign', p_campaign_id::text);
  return v_result;
end; $$;

create or replace function public.draw_raffle_campaign(
  p_campaign_id uuid, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_campaign public.raffle_campaigns%rowtype;
  v_scope text; v_claim record; v_eligible integer[]; v_material text;
  v_hash text; v_index integer; v_winner integer; v_draw_id uuid := gen_random_uuid(); v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('raffles.manage') then
    raise exception using errcode = '42501', message = 'RAFFLE_MANAGE_FORBIDDEN';
  end if;
  v_scope := private.build_idempotency_scope('raffles', 'draw', v_actor_id);
  select * into v_claim from private.claim_idempotency(v_scope, p_idempotency_key, jsonb_build_object('campaign_id', p_campaign_id));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_campaign from public.raffle_campaigns where id = p_campaign_id for update;
  if not found or v_campaign.status <> 'CLOSED' then
    raise exception using errcode = 'P0001', message = 'RAFFLE_CAMPAIGN_NOT_DRAWABLE';
  end if;
  select array_agg(number order by number) into v_eligible
  from public.raffle_numbers where campaign_id = p_campaign_id and status = 'PAID';
  if v_eligible is null then raise exception using errcode = 'P0001', message = 'RAFFLE_NO_ELIGIBLE_NUMBERS'; end if;
  v_material := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(convert_to(p_campaign_id::text || ':' || array_to_string(v_eligible, ',') || ':' || v_material, 'UTF8'), 'sha256'), 'hex');
  v_index := ((('x' || substr(v_hash, 1, 15))::bit(60)::bigint % cardinality(v_eligible)) + 1)::integer;
  v_winner := v_eligible[v_index];
  insert into public.raffle_draws (
    id, campaign_id, eligible_numbers, random_material, audit_hash,
    winner_index, winner_number, drawn_by, correlation_id
  ) values (
    v_draw_id, p_campaign_id, v_eligible, v_material, v_hash,
    v_index, v_winner, v_actor_id, p_correlation_id
  );
  update public.raffle_campaigns set status = 'DRAWN', drawn_at = now() where id = p_campaign_id;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('raffles.drawn', v_actor_id, 'raffle_campaign', p_campaign_id::text, p_correlation_id,
    jsonb_build_object('draw_id', v_draw_id, 'audit_hash', v_hash, 'winner_number', v_winner));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('raffles.drawn', 'raffle_campaign', p_campaign_id::text,
    jsonb_build_object('campaign_id', p_campaign_id, 'draw_id', v_draw_id, 'audit_hash', v_hash));
  v_result := jsonb_build_object('draw_id', v_draw_id, 'campaign_id', p_campaign_id,
    'eligible_numbers', v_eligible, 'random_material', v_material, 'audit_hash', v_hash,
    'winner_index', v_index, 'winner_number', v_winner, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'raffle_draw', v_draw_id::text);
  return v_result;
end; $$;

alter table public.raffle_campaigns enable row level security;
alter table public.raffle_numbers enable row level security;
alter table public.raffle_draws enable row level security;
revoke all on table public.raffle_campaigns, public.raffle_numbers, public.raffle_draws from public, anon, authenticated, service_role;
grant select on table public.raffle_campaigns, public.raffle_numbers, public.raffle_draws to authenticated;
create policy raffle_campaigns_authenticated_read on public.raffle_campaigns for select to authenticated using (public.has_permission('raffles.buy') or public.has_permission('raffles.manage'));
create policy raffle_numbers_authenticated_read on public.raffle_numbers for select to authenticated using (public.has_permission('raffles.buy') or public.has_permission('raffles.manage'));
create policy raffle_draws_authenticated_read on public.raffle_draws for select to authenticated using (public.has_permission('raffles.buy') or public.has_permission('raffles.manage'));

revoke all on function private.mark_raffle_numbers_paid() from public, anon, authenticated, service_role;
revoke all on function public.create_raffle_campaign(text, uuid, uuid, integer, timestamptz, timestamptz, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reserve_raffle_numbers(uuid, integer[], text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.cancel_raffle_reservation(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.close_raffle_campaign(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.draw_raffle_campaign(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_raffle_campaign(text, uuid, uuid, integer, timestamptz, timestamptz, text, uuid) to authenticated;
grant execute on function public.reserve_raffle_numbers(uuid, integer[], text, uuid) to authenticated;
grant execute on function public.cancel_raffle_reservation(uuid, text, uuid) to authenticated;
grant execute on function public.close_raffle_campaign(uuid, text, uuid) to authenticated;
grant execute on function public.draw_raffle_campaign(uuid, text, uuid) to authenticated;

comment on table public.raffle_draws is 'Immutable draw proof: ordered paid set, random material, hash, winner index and number.';
