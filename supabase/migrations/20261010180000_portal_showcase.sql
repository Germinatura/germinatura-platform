-- Spec 4.1 (VIT-001): the Início page is the showcase of the class. It shows a highlight configured by the
-- communications team, the newest products, public promotions in force with their validity, upcoming events
-- and raffles on sale, besides the public goal that already exists. Only what helps people act.

-- The highlight is versioned: every change is a new immutable row and the latest one is in force.
create table public.portal_highlights (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  title text not null check (char_length(title) between 3 and 80 and title = btrim(title)),
  message text check (message is null or (char_length(message) between 3 and 280 and message = btrim(message))),
  cta_label text check (cta_label is null or (char_length(cta_label) between 2 and 40 and cta_label = btrim(cta_label))),
  cta_url text check (cta_url is null or ((cta_url ~ '^https://[^\s]{3,}$' or cta_url ~ '^/[A-Za-z0-9/_?=&.-]*$') and char_length(cta_url) <= 500)),
  active boolean not null,
  visible_until timestamptz,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint portal_highlights_cta_valid check ((cta_label is null) = (cta_url is null))
);
create trigger portal_highlights_immutable before update or delete on public.portal_highlights
for each row execute function private.prevent_immutable_record_change();
alter table public.portal_highlights enable row level security;
revoke all on public.portal_highlights from public, anon, authenticated, service_role;

create function private.portal_highlight_json(p_highlight public.portal_highlights)
returns jsonb language sql stable set search_path = '' as $$
  select case when p_highlight.id is null then null else jsonb_build_object(
    'title', p_highlight.title, 'message', p_highlight.message, 'cta_label', p_highlight.cta_label, 'cta_url', p_highlight.cta_url,
    'active', p_highlight.active, 'visible_until', p_highlight.visible_until, 'updated_at', p_highlight.created_at) end;
$$;

create function public.save_portal_highlight(
  p_title text, p_message text, p_cta_label text, p_cta_url text, p_active boolean, p_visible_until timestamptz,
  p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_previous public.portal_highlights%rowtype;
  v_saved public.portal_highlights%rowtype;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_active is null or btrim(coalesce(p_title, '')) = ''
    or (nullif(btrim(p_cta_label), '') is null) <> (nullif(btrim(p_cta_url), '') is null)
    or (p_active and p_visible_until is not null and p_visible_until <= now()) then
    raise exception using errcode = '22023', message = 'INVALID_PORTAL_HIGHLIGHT';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('communications', 'highlight', v_actor_id), p_idempotency_key,
    jsonb_build_object('title', btrim(p_title), 'message', p_message, 'cta_label', p_cta_label, 'cta_url', p_cta_url,
      'active', p_active, 'visible_until', p_visible_until));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select * into v_previous from public.portal_highlights order by sequence desc limit 1;
  insert into public.portal_highlights (title, message, cta_label, cta_url, active, visible_until, actor_id, correlation_id)
  values (btrim(p_title), nullif(btrim(p_message), ''), nullif(btrim(p_cta_label), ''), nullif(btrim(p_cta_url), ''), p_active,
    p_visible_until, v_actor_id, p_correlation_id)
  returning * into v_saved;
  v_result := private.portal_highlight_json(v_saved) || jsonb_build_object('correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('communications.highlight.saved', v_actor_id, 'portal_highlight', v_saved.id::text, p_correlation_id,
    jsonb_build_object('before', private.portal_highlight_json(v_previous), 'after', private.portal_highlight_json(v_saved)));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'portal_highlight', v_saved.id::text);
  return v_result;
end;
$$;

create function public.get_portal_highlight_admin()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_current public.portal_highlights%rowtype;
begin
  if auth.uid() is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  select * into v_current from public.portal_highlights order by sequence desc limit 1;
  return jsonb_build_object('highlight', private.portal_highlight_json(v_current));
end;
$$;

-- Everything the Início page shows, for anyone with access to the Portal.
create function public.get_portal_showcase()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_current public.portal_highlights%rowtype;
begin
  if auth.uid() is null or not public.has_permission('portal.access') then
    raise exception using errcode = '42501', message = 'PORTAL_ACCESS_REQUIRED';
  end if;
  select * into v_current from public.portal_highlights order by sequence desc limit 1;
  return jsonb_build_object(
    'highlight', case when v_current.active and (v_current.visible_until is null or v_current.visible_until > now())
      then private.portal_highlight_json(v_current) end,
    -- Newest products by the moment they were first published (the broadcast register keeps that date).
    'new_products', coalesce((select jsonb_agg(item order by published desc) from (
      select jsonb_build_object('id', product.id, 'name', product.name, 'category', category.name,
        'image_path', (select image.object_path from public.product_images image
          where image.product_id = product.id and image.status = 'ACTIVE' order by image.sort_order, image.id limit 1),
        'image_alt', (select image.alt_text from public.product_images image
          where image.product_id = product.id and image.status = 'ACTIVE' order by image.sort_order, image.id limit 1)) as item,
        notice.created_at as published
      from public.broadcast_notices notice
      join public.products product on product.id = notice.source_id
      join public.categories category on category.id = product.category_id
      where notice.source_type = 'PRODUCT' and product.active and product.published and category.active
      order by notice.created_at desc limit 4) newest), '[]'::jsonb),
    'promotions', coalesce((select jsonb_agg(jsonb_build_object('id', promotion.id, 'name', promotion.name,
        'description', promotion.description, 'valid_to', promotion.valid_to) order by promotion.valid_to nulls last, promotion.name)
      from (select * from public.promotions promotion
        where promotion.active and promotion.publicable and promotion.valid_from <= now()
          and (promotion.valid_to is null or promotion.valid_to > now())
        order by promotion.valid_to nulls last, promotion.name limit 4) promotion), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(private.portal_event_json(event.id, false) order by event.starts_at, event.id)
      from (select event.id, event.starts_at from public.portal_events event
        where event.status = 'PUBLICADO' and not private.portal_event_over(event)
        order by event.starts_at, event.id limit 3) event), '[]'::jsonb),
    'raffles', case when public.is_feature_enabled('raffles') then coalesce((select jsonb_agg(jsonb_build_object(
        'id', campaign.id, 'name', campaign.name, 'ends_at', campaign.ends_at, 'number_count', campaign.number_count,
        'available_count', (select count(*) from public.raffle_numbers number
          where number.campaign_id = campaign.id and number.status = 'AVAILABLE')) order by campaign.ends_at, campaign.id)
      from (select * from public.raffle_campaigns campaign
        where campaign.status = 'ACTIVE' and campaign.starts_at <= now() and campaign.ends_at > now()
        order by campaign.ends_at, campaign.id limit 3) campaign), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

revoke all on function private.portal_highlight_json(public.portal_highlights) from public, anon, authenticated, service_role;
revoke all on function public.save_portal_highlight(text, text, text, text, boolean, timestamptz, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_portal_highlight_admin() from public, anon, authenticated, service_role;
revoke all on function public.get_portal_showcase() from public, anon, authenticated, service_role;
grant execute on function public.save_portal_highlight(text, text, text, text, boolean, timestamptz, text, uuid) to authenticated;
grant execute on function public.get_portal_highlight_admin() to authenticated;
grant execute on function public.get_portal_showcase() to authenticated;
