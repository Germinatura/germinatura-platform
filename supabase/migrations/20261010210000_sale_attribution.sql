-- Spec 5.13 (GROW-002): attribution of paid sales and links per seller.
--
-- * A seller creates their own tracked link (and QR code) from the PDV; visits and reservations through it count
--   for the seller as for any campaign.
-- * A sale is attributed to a campaign once: an online sale from the tracked-link cookie, a PDV sale by the seller
--   who made it, choosing the campaign that brought the customer. Reservations keep their own attribution and
--   reach the paid figures through the sale they become.
-- * Paid figures come from the sale ledger (receipts minus refunds), never from the cart or the quote.

alter table public.share_campaigns add column seller_id uuid references public.profiles(id) on delete restrict;
create index share_campaigns_seller_idx on public.share_campaigns (seller_id) where seller_id is not null;

create table public.sale_attributions (
  sale_id uuid primary key references public.sales(id) on delete restrict,
  campaign_id uuid not null references public.share_campaigns(id) on delete restrict,
  source text not null check (source in ('LINK', 'PDV')),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index sale_attributions_campaign_idx on public.sale_attributions (campaign_id);
create trigger sale_attributions_immutable before update or delete on public.sale_attributions
for each row execute function private.prevent_immutable_record_change();
alter table public.sale_attributions enable row level security;
revoke all on public.sale_attributions from public, anon, authenticated, service_role;

-- Sales a campaign brought: attributed sales and the sales its attributed reservations turned into.
create function private.share_campaign_sales(p_campaign_id uuid)
returns table (sale_id uuid) language sql stable set search_path = '' as $$
  select attribution.sale_id from public.sale_attributions attribution where attribution.campaign_id = p_campaign_id
  union
  select reservation.converted_sale_id from public.reservation_attributions attribution
  join public.commercial_reservations reservation on reservation.id = attribution.reservation_id
  where attribution.campaign_id = p_campaign_id and reservation.converted_sale_id is not null;
$$;

-- Paid sales and net paid amount from the ledger: receipts minus refunds.
create function private.share_campaign_paid(p_campaign_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  with ledger as (
    select entry.sale_id, sum(entry.amount_cents) as net_cents
    from public.financial_ledger_entries entry
    where entry.sale_id in (select sale_id from private.share_campaign_sales(p_campaign_id))
      and entry.entry_type in ('RECEIVABLE_PICPAY', 'CASH_RECEIPT', 'REFUND')
    group by entry.sale_id
  )
  select jsonb_build_object('paid_sales', count(*) filter (where net_cents > 0), 'paid_total_cents', coalesce(sum(net_cents), 0))
  from ledger;
$$;

create function private.share_campaign_json(p_campaign public.share_campaigns)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p_campaign.id, 'code', p_campaign.code, 'title', p_campaign.title, 'channel', p_campaign.channel,
    'product_ids', to_jsonb(p_campaign.product_ids), 'created_at', p_campaign.created_at,
    'created_by_name', (select coalesce(nullif(btrim(author.display_name), ''), author.email) from public.profiles author where author.id = p_campaign.created_by),
    'seller_id', p_campaign.seller_id,
    'seller_name', (select coalesce(nullif(btrim(seller.display_name), ''), seller.email) from public.profiles seller where seller.id = p_campaign.seller_id),
    'visits', (select count(*) from public.share_visits visit where visit.campaign_id = p_campaign.id),
    'reservations', (select count(*) from public.reservation_attributions attribution where attribution.campaign_id = p_campaign.id),
    'reserved_total_cents', (select coalesce(sum(reservation.total_cents), 0) from public.reservation_attributions attribution
      join public.commercial_reservations reservation on reservation.id = attribution.reservation_id
      where attribution.campaign_id = p_campaign.id and reservation.status not in ('CANCELLED', 'EXPIRED'))
  ) || private.share_campaign_paid(p_campaign.id);
$$;

create or replace function public.list_share_campaigns(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_SHARE_FILTER';
  end if;
  return coalesce((select jsonb_agg(private.share_campaign_json(campaign) order by campaign.created_at desc, campaign.id desc)
    from (select * from public.share_campaigns order by created_at desc, id desc limit p_limit) campaign), '[]'::jsonb);
end;
$$;

-- A seller's own tracked link, made from the PDV.
create function public.create_seller_share_link(
  p_title text, p_channel public.share_channel, p_product_ids uuid[], p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_id uuid := gen_random_uuid();
  v_code text;
  v_title text := btrim(p_title);
  v_products uuid[] := coalesce((select array_agg(distinct linked.value order by linked.value)
    from unnest(coalesce(p_product_ids, '{}')) linked(value)), '{}');
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SALES_CREATE_REQUIRED';
  end if;
  if p_correlation_id is null or p_channel is null or v_title is null or char_length(v_title) not between 3 and 120
    or cardinality(v_products) > 20
    or exists (select 1 from unnest(v_products) linked(value)
      where not exists (select 1 from public.products product where product.id = linked.value and product.active and product.published)) then
    raise exception using errcode = '22023', message = 'INVALID_SHARE_CAMPAIGN';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('sales', 'seller_share_link', v_actor_id), p_idempotency_key,
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
  insert into public.share_campaigns (id, code, title, channel, product_ids, seller_id, created_by, correlation_id)
  values (v_id, v_code, v_title, p_channel, v_products, v_actor_id, v_actor_id, p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('sales.share_link.created', v_actor_id, 'share_campaign', v_id::text, p_correlation_id,
    jsonb_build_object('code', v_code, 'channel', p_channel, 'product_ids', v_products, 'seller_id', v_actor_id));
  v_result := (select private.share_campaign_json(campaign) from public.share_campaigns campaign where campaign.id = v_id)
    || jsonb_build_object('correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'share_campaign', v_id::text);
  return v_result;
end;
$$;

-- The seller's own links with their results, and the campaigns a PDV sale can be attributed to.
create function public.list_my_share_links()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SALES_CREATE_REQUIRED';
  end if;
  return jsonb_build_object(
    'links', coalesce((select jsonb_agg(private.share_campaign_json(campaign) order by campaign.created_at desc, campaign.id desc)
      from (select * from public.share_campaigns where seller_id = auth.uid() order by created_at desc, id desc limit 20) campaign), '[]'::jsonb),
    'campaigns', coalesce((select jsonb_agg(jsonb_build_object('code', campaign.code, 'title', campaign.title, 'channel', campaign.channel,
        'mine', campaign.seller_id = auth.uid()) order by campaign.created_at desc)
      from (select * from public.share_campaigns
        where (seller_id is null or seller_id = auth.uid()) and created_at > now() - interval '180 days'
        order by created_at desc limit 50) campaign), '[]'::jsonb));
end;
$$;

-- The seller who made a PDV sale records which campaign brought the customer. Once per sale.
create function public.attribute_pdv_sale(p_sale_id uuid, p_code text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_campaign public.share_campaigns%rowtype;
  v_existing public.sale_attributions%rowtype;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SALES_CREATE_REQUIRED';
  end if;
  if p_sale_id is null or p_correlation_id is null or p_code is null or p_code !~ '^[a-z0-9]{8}$' then
    raise exception using errcode = '22023', message = 'INVALID_SALE_ATTRIBUTION';
  end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.created_by <> v_actor_id or v_sale.channel <> 'PDV' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;
  if v_sale.status in ('DRAFT', 'CANCELLED') then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_ATTRIBUTABLE';
  end if;
  select * into v_campaign from public.share_campaigns where code = p_code and (seller_id is null or seller_id = v_actor_id);
  if not found then
    raise exception using errcode = 'P0001', message = 'SHARE_CAMPAIGN_NOT_FOUND';
  end if;
  select * into v_existing from public.sale_attributions where sale_id = v_sale.id;
  if found then
    -- Repeating the same choice is harmless; a different one is refused.
    if v_existing.campaign_id <> v_campaign.id then
      raise exception using errcode = 'P0001', message = 'SALE_ALREADY_ATTRIBUTED';
    end if;
    return jsonb_build_object('sale_id', v_sale.id, 'campaign_code', v_campaign.code, 'campaign_title', v_campaign.title);
  end if;
  insert into public.sale_attributions (sale_id, campaign_id, source, actor_id) values (v_sale.id, v_campaign.id, 'PDV', v_actor_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('sales.attributed', v_actor_id, 'sale', v_sale.id::text, p_correlation_id,
    jsonb_build_object('campaign_id', v_campaign.id, 'code', v_campaign.code, 'source', 'PDV'));
  return jsonb_build_object('sale_id', v_sale.id, 'campaign_code', v_campaign.code, 'campaign_title', v_campaign.title);
end;
$$;

-- The customer's own online sale is attributed once to the campaign whose link brought them.
create function public.attribute_online_sale(p_sale_id uuid, p_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_campaign_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select id into v_campaign_id from public.share_campaigns where code = p_code;
  if v_campaign_id is null or not exists (
    select 1 from public.sales where id = p_sale_id and customer_id = auth.uid() and channel = 'PORTAL') then
    return false;
  end if;
  insert into public.sale_attributions (sale_id, campaign_id, source, actor_id) values (p_sale_id, v_campaign_id, 'LINK', auth.uid())
  on conflict (sale_id) do nothing;
  return found;
end;
$$;

revoke all on function private.share_campaign_sales(uuid) from public, anon, authenticated, service_role;
revoke all on function private.share_campaign_paid(uuid) from public, anon, authenticated, service_role;
revoke all on function private.share_campaign_json(public.share_campaigns) from public, anon, authenticated, service_role;
revoke all on function public.create_seller_share_link(text, public.share_channel, uuid[], text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_my_share_links() from public, anon, authenticated, service_role;
revoke all on function public.attribute_pdv_sale(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.attribute_online_sale(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.create_seller_share_link(text, public.share_channel, uuid[], text, uuid) to authenticated;
grant execute on function public.list_my_share_links() to authenticated;
grant execute on function public.attribute_pdv_sale(uuid, text, uuid) to authenticated;
grant execute on function public.attribute_online_sale(uuid, text) to authenticated;
