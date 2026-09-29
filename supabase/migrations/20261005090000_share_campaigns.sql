-- Spec 4.2 / 5.13 (GROW-001): shareable campaigns with tracked links. The communications team picks products
-- and a channel; the Portal builds the text with current prices, the tracked link and its QR code. Visits to the
-- link and reservations made afterwards (origin kept in a first-party cookie) are counted per campaign.

create type public.share_channel as enum ('WHATSAPP', 'INSTAGRAM', 'MURAL', 'PRESENCIAL', 'OUTRO');

create table public.share_campaigns (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9]{8}$'),
  title text not null check (char_length(title) between 3 and 120 and title = btrim(title)),
  channel public.share_channel not null,
  product_ids uuid[] not null default '{}' check (cardinality(product_ids) <= 20),
  created_by uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);
create table public.share_visits (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.share_campaigns(id) on delete restrict,
  visited_at timestamptz not null default now()
);
create index share_visits_campaign_idx on public.share_visits (campaign_id);
create table public.reservation_attributions (
  reservation_id uuid primary key references public.commercial_reservations(id) on delete restrict,
  campaign_id uuid not null references public.share_campaigns(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index reservation_attributions_campaign_idx on public.reservation_attributions (campaign_id);
create trigger share_campaigns_immutable before update or delete on public.share_campaigns
for each row execute function private.prevent_immutable_record_change();
create trigger share_visits_immutable before update or delete on public.share_visits
for each row execute function private.prevent_immutable_record_change();
create trigger reservation_attributions_immutable before update or delete on public.reservation_attributions
for each row execute function private.prevent_immutable_record_change();
alter table public.share_campaigns enable row level security;
alter table public.share_visits enable row level security;
alter table public.reservation_attributions enable row level security;
revoke all on public.share_campaigns, public.share_visits, public.reservation_attributions from public, anon, authenticated, service_role;

create function public.create_share_campaign(
  p_title text, p_channel public.share_channel, p_product_ids uuid[], p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_claim record; v_id uuid := gen_random_uuid(); v_code text; v_result jsonb;
  v_title text := btrim(p_title);
  v_products uuid[] := coalesce((select array_agg(distinct product_id order by product_id) from unnest(coalesce(p_product_ids, '{}')) product_id), '{}');
begin
  if v_actor_id is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_channel is null or v_title is null or char_length(v_title) not between 3 and 120
    or cardinality(v_products) > 20
    or exists (select 1 from unnest(v_products) product_id
      where not exists (select 1 from public.products product where product.id = product_id and product.active and product.published)) then
    raise exception using errcode = '22023', message = 'INVALID_SHARE_CAMPAIGN';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('communications', 'share_campaign', v_actor_id), p_idempotency_key,
    jsonb_build_object('title', v_title, 'channel', p_channel, 'product_ids', v_products));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  loop
    v_code := encode(extensions.gen_random_bytes(4), 'hex');
    exit when not exists (select 1 from public.share_campaigns where code = v_code);
  end loop;
  insert into public.share_campaigns (id, code, title, channel, product_ids, created_by, correlation_id)
  values (v_id, v_code, v_title, p_channel, v_products, v_actor_id, p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('communications.share_campaign.created', v_actor_id, 'share_campaign', v_id::text, p_correlation_id,
    jsonb_build_object('code', v_code, 'channel', p_channel, 'product_ids', v_products));
  v_result := jsonb_build_object('id', v_id, 'code', v_code, 'title', v_title, 'channel', p_channel,
    'product_ids', to_jsonb(v_products), 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'share_campaign', v_id::text);
  return v_result;
end;
$$;

-- Public: a visit to a tracked link. Unknown codes are simply not counted.
create function public.record_share_visit(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_campaign public.share_campaigns%rowtype;
begin
  if p_code is null or p_code !~ '^[a-z0-9]{8}$' then
    return null;
  end if;
  select * into v_campaign from public.share_campaigns where code = p_code;
  if not found then
    return null;
  end if;
  insert into public.share_visits (campaign_id) values (v_campaign.id);
  return jsonb_build_object('campaign_id', v_campaign.id, 'code', v_campaign.code, 'product_ids', to_jsonb(v_campaign.product_ids));
end;
$$;

-- The customer's own new reservation is attributed once to the campaign that brought them.
create function public.attribute_reservation(p_reservation_id uuid, p_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_campaign_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select id into v_campaign_id from public.share_campaigns where code = p_code;
  if v_campaign_id is null or not exists (
    select 1 from public.commercial_reservations where id = p_reservation_id and customer_id = auth.uid()) then
    return false;
  end if;
  insert into public.reservation_attributions (reservation_id, campaign_id) values (p_reservation_id, v_campaign_id)
  on conflict (reservation_id) do nothing;
  return found;
end;
$$;

create function public.list_share_campaigns(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_SHARE_FILTER';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', campaign.id, 'code', campaign.code, 'title', campaign.title, 'channel', campaign.channel,
      'product_ids', to_jsonb(campaign.product_ids), 'created_at', campaign.created_at,
      'created_by_name', coalesce(nullif(btrim(author.display_name), ''), author.email),
      'visits', (select count(*) from public.share_visits visit where visit.campaign_id = campaign.id),
      'reservations', (select count(*) from public.reservation_attributions attribution where attribution.campaign_id = campaign.id),
      'reserved_total_cents', (select coalesce(sum(reservation.total_cents), 0) from public.reservation_attributions attribution
        join public.commercial_reservations reservation on reservation.id = attribution.reservation_id
        where attribution.campaign_id = campaign.id and reservation.status not in ('CANCELLED', 'EXPIRED')))
      order by campaign.created_at desc, campaign.id desc)
    from (select * from public.share_campaigns order by created_at desc, id desc limit p_limit) campaign
    join public.profiles author on author.id = campaign.created_by), '[]'::jsonb);
end;
$$;

revoke all on function public.create_share_campaign(text, public.share_channel, uuid[], text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_share_visit(text) from public, anon, authenticated, service_role;
revoke all on function public.attribute_reservation(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.list_share_campaigns(integer) from public, anon, authenticated, service_role;
grant execute on function public.create_share_campaign(text, public.share_channel, uuid[], text, uuid) to authenticated;
grant execute on function public.record_share_visit(text) to anon, authenticated;
grant execute on function public.attribute_reservation(uuid, text) to authenticated;
grant execute on function public.list_share_campaigns(integer) to authenticated;
