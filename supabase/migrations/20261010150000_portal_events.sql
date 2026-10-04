-- Spec 4.5 (EVT-001): public area of events and campaigns. The communications team writes a draft with title,
-- description, cover, date, time, place, optional external link and call to action, and may link published
-- products, public promotions (combos included) and participating sellers. Publishing tells people who keep the
-- Eventos category on; cancelling a published event tells them too. Events are never deleted: once they are
-- over they move to the archive, and a cancelled event stays visible as cancelled.

create type public.portal_event_kind as enum ('EVENTO', 'CAMPANHA');
create type public.portal_event_status as enum ('RASCUNHO', 'PUBLICADO', 'CANCELADO');

create table public.portal_events (
  id uuid primary key default gen_random_uuid(),
  kind public.portal_event_kind not null,
  title text not null check (char_length(title) between 3 and 120 and title = btrim(title)),
  description text not null check (char_length(description) between 3 and 4000),
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text check (location is null or (char_length(location) between 2 and 160 and location = btrim(location))),
  external_url text check (external_url is null or (external_url ~ '^https://[^\s]{3,}$' and char_length(external_url) <= 500)),
  cta_label text check (cta_label is null or (char_length(cta_label) between 2 and 40 and cta_label = btrim(cta_label))),
  cta_url text check (cta_url is null or ((cta_url ~ '^https://[^\s]{3,}$' or cta_url ~ '^/[A-Za-z0-9/_?=&.-]*$') and char_length(cta_url) <= 500)),
  cover_path text unique check (cover_path is null or cover_path ~ '^events/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  cover_alt text check (cover_alt is null or (char_length(cover_alt) between 1 and 180 and cover_alt = btrim(cover_alt))),
  product_ids uuid[] not null default '{}' check (cardinality(product_ids) <= 20),
  promotion_ids uuid[] not null default '{}' check (cardinality(promotion_ids) <= 10),
  seller_ids uuid[] not null default '{}' check (cardinality(seller_ids) <= 50),
  status public.portal_event_status not null default 'RASCUNHO',
  revision integer not null default 1 check (revision >= 1),
  published_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or (char_length(cancel_reason) between 8 and 300 and cancel_reason = btrim(cancel_reason))),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portal_events_period_valid check (ends_at is null or ends_at >= starts_at),
  constraint portal_events_cta_valid check ((cta_label is null) = (cta_url is null)),
  constraint portal_events_cover_valid check ((cover_path is null) = (cover_alt is null)),
  constraint portal_events_status_valid check (
    (status = 'RASCUNHO' and published_at is null and cancelled_at is null and cancel_reason is null)
    or (status = 'PUBLICADO' and published_at is not null and cancelled_at is null and cancel_reason is null)
    or (status = 'CANCELADO' and cancelled_at is not null and cancel_reason is not null)
  )
);
create index portal_events_public_idx on public.portal_events (status, starts_at);
create trigger portal_events_no_delete before delete on public.portal_events
for each row execute function private.prevent_immutable_record_change();
alter table public.portal_events enable row level security;
revoke all on public.portal_events from public, anon, authenticated, service_role;

-- Covers live in their own public bucket; uploads only through the communications permission and fresh paths.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-covers', 'event-covers', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy "event_covers_communications_insert" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'event-covers' and (select public.has_permission('communications.manage'))
    and name ~ '^events/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
  );

-- Announcements of events go through the same once-per-source register as the other broadcasts.
alter table public.broadcast_notices drop constraint broadcast_notices_source_type_check;
alter table public.broadcast_notices add constraint broadcast_notices_source_type_check
  check (source_type in ('PRODUCT', 'PROMOTION', 'RAFFLE', 'EVENT', 'EVENT_CANCELLED'));

-- An event is over when its end (or start, without an end) has passed.
create function private.portal_event_over(p_event public.portal_events)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(p_event.ends_at, p_event.starts_at) < now();
$$;

create function private.portal_event_json(p_event_id uuid, p_manager boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', event.id, 'kind', event.kind, 'title', event.title, 'description', event.description,
    'starts_at', event.starts_at, 'ends_at', event.ends_at, 'location', event.location,
    'external_url', event.external_url, 'cta_label', event.cta_label, 'cta_url', event.cta_url,
    'cover_path', event.cover_path, 'cover_alt', event.cover_alt,
    'status', event.status, 'over', private.portal_event_over(event),
    'published_at', event.published_at, 'cancelled_at', event.cancelled_at, 'cancel_reason', event.cancel_reason,
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', product.id, 'name', product.name) order by product.name)
      from public.products product where product.id = any(event.product_ids)
        and (p_manager or (product.active and product.published))), '[]'::jsonb),
    'promotions', coalesce((select jsonb_agg(jsonb_build_object('id', promotion.id, 'name', promotion.name,
        'valid_from', promotion.valid_from, 'valid_to', promotion.valid_to) order by promotion.name)
      from public.promotions promotion where promotion.id = any(event.promotion_ids)
        and (p_manager or (promotion.active and promotion.publicable))), '[]'::jsonb),
    -- Participating sellers are shown by name to signed-in people only.
    'sellers', coalesce((select jsonb_agg(jsonb_build_object('id', profile.id,
        'name', coalesce(nullif(btrim(profile.display_name), ''), split_part(profile.email, '@', 1))) order by profile.display_name)
      from public.profiles profile where profile.id = any(event.seller_ids)), '[]'::jsonb),
    'revision', case when p_manager then event.revision end,
    'updated_at', case when p_manager then event.updated_at end
  )
  from public.portal_events event where event.id = p_event_id;
$$;

create function public.save_portal_event(
  p_event_id uuid, p_expected_revision integer, p_kind public.portal_event_kind, p_title text, p_description text,
  p_starts_at timestamptz, p_ends_at timestamptz, p_location text, p_external_url text, p_cta_label text, p_cta_url text,
  p_product_ids uuid[], p_promotion_ids uuid[], p_seller_ids uuid[], p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_before public.portal_events%rowtype;
  v_id uuid := coalesce(p_event_id, gen_random_uuid());
  v_title text := btrim(p_title);
  v_description text := btrim(p_description);
  v_products uuid[] := coalesce((select array_agg(distinct linked.value order by linked.value) from unnest(coalesce(p_product_ids, '{}')) linked(value)), '{}');
  v_promotions uuid[] := coalesce((select array_agg(distinct linked.value order by linked.value) from unnest(coalesce(p_promotion_ids, '{}')) linked(value)), '{}');
  v_sellers uuid[] := coalesce((select array_agg(distinct linked.value order by linked.value) from unnest(coalesce(p_seller_ids, '{}')) linked(value)), '{}');
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_kind is null or p_starts_at is null
    or v_title is null or char_length(v_title) not between 3 and 120
    or v_description is null or char_length(v_description) not between 3 and 4000
    or (p_ends_at is not null and p_ends_at < p_starts_at)
    or (nullif(btrim(p_cta_label), '') is null) <> (nullif(btrim(p_cta_url), '') is null)
    or cardinality(v_products) > 20 or cardinality(v_promotions) > 10 or cardinality(v_sellers) > 50
    or (p_event_id is not null and p_expected_revision is null) then
    raise exception using errcode = '22023', message = 'INVALID_PORTAL_EVENT';
  end if;
  if exists (select 1 from unnest(v_products) linked(value) where not exists (
      select 1 from public.products product where product.id = linked.value and product.active and product.published))
    or exists (select 1 from unnest(v_promotions) linked(value) where not exists (
      select 1 from public.promotions promotion where promotion.id = linked.value and promotion.active and promotion.publicable))
    or exists (select 1 from unnest(v_sellers) linked(value) where not exists (
      select 1 from private.staff_with_permission('sales.create') seller where seller.recipient_id = linked.value)) then
    raise exception using errcode = '22023', message = 'INVALID_PORTAL_EVENT_LINKS';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('communications', 'save_event', v_actor_id), p_idempotency_key,
    jsonb_build_object('event_id', p_event_id, 'revision', p_expected_revision, 'kind', p_kind, 'title', v_title,
      'description', v_description, 'starts_at', p_starts_at, 'ends_at', p_ends_at, 'location', p_location,
      'external_url', p_external_url, 'cta_label', p_cta_label, 'cta_url', p_cta_url, 'products', v_products,
      'promotions', v_promotions, 'sellers', v_sellers));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  if p_event_id is null then
    insert into public.portal_events (
      id, kind, title, description, starts_at, ends_at, location, external_url, cta_label, cta_url,
      product_ids, promotion_ids, seller_ids, created_by, updated_by
    ) values (
      v_id, p_kind, v_title, v_description, p_starts_at, p_ends_at, nullif(btrim(p_location), ''), nullif(btrim(p_external_url), ''),
      nullif(btrim(p_cta_label), ''), nullif(btrim(p_cta_url), ''), v_products, v_promotions, v_sellers, v_actor_id, v_actor_id
    );
  else
    select * into v_before from public.portal_events where id = p_event_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_NOT_FOUND';
    end if;
    if v_before.status = 'CANCELADO' then
      raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_CANCELLED';
    end if;
    if v_before.revision <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_REVISION_CONFLICT';
    end if;
    update public.portal_events set
      kind = p_kind, title = v_title, description = v_description, starts_at = p_starts_at, ends_at = p_ends_at,
      location = nullif(btrim(p_location), ''), external_url = nullif(btrim(p_external_url), ''),
      cta_label = nullif(btrim(p_cta_label), ''), cta_url = nullif(btrim(p_cta_url), ''),
      product_ids = v_products, promotion_ids = v_promotions, seller_ids = v_sellers,
      revision = revision + 1, updated_by = v_actor_id, updated_at = now()
    where id = p_event_id;
  end if;

  v_result := private.portal_event_json(v_id, true) || jsonb_build_object('correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (case when p_event_id is null then 'communications.event.created' else 'communications.event.updated' end,
    v_actor_id, 'portal_event', v_id::text, p_correlation_id,
    jsonb_build_object('before', case when p_event_id is null then null else to_jsonb(v_before) end,
      'after', (select to_jsonb(event) from public.portal_events event where event.id = v_id)));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('communications.event.saved', 'portal_event', v_id::text, jsonb_build_object('event_id', v_id, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'portal_event', v_id::text);
  return v_result;
end;
$$;

-- Publishes a draft or cancels an event. Publishing an event that is already over is refused.
create function public.transition_portal_event(
  p_event_id uuid, p_action text, p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_event public.portal_events%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_event_id is null or p_action not in ('PUBLICAR', 'CANCELAR')
    or (p_action = 'CANCELAR' and (v_reason is null or char_length(v_reason) not between 8 and 300)) then
    raise exception using errcode = '22023', message = 'INVALID_PORTAL_EVENT_TRANSITION';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('communications', 'transition_event', v_actor_id), p_idempotency_key,
    jsonb_build_object('event_id', p_event_id, 'action', p_action, 'reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select * into v_event from public.portal_events where id = p_event_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_NOT_FOUND';
  end if;

  if p_action = 'PUBLICAR' then
    if v_event.status <> 'RASCUNHO' then
      raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_NOT_DRAFT';
    end if;
    if private.portal_event_over(v_event) then
      raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_ALREADY_OVER';
    end if;
    update public.portal_events set status = 'PUBLICADO', published_at = now(), revision = revision + 1,
      updated_by = v_actor_id, updated_at = now() where id = v_event.id;
    perform private.queue_broadcast_once('EVENT', v_event.id, 'communications.event.published', 'portal_event');
  else
    if v_event.status = 'CANCELADO' then
      raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_CANCELLED';
    end if;
    update public.portal_events set status = 'CANCELADO', cancelled_at = now(), cancel_reason = v_reason,
      revision = revision + 1, updated_by = v_actor_id, updated_at = now() where id = v_event.id;
    -- Only people who were told about it are told it is off.
    if v_event.status = 'PUBLICADO' and not private.portal_event_over(v_event) then
      perform private.queue_broadcast_once('EVENT_CANCELLED', v_event.id, 'communications.event.cancelled', 'portal_event');
    end if;
  end if;

  v_result := private.portal_event_json(v_event.id, true) || jsonb_build_object('correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (case p_action when 'PUBLICAR' then 'communications.event.published' else 'communications.event.cancelled' end,
    v_actor_id, 'portal_event', v_event.id::text, p_correlation_id,
    jsonb_build_object('previous_status', v_event.status, 'reason', v_reason));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'portal_event', v_event.id::text);
  return v_result;
end;
$$;

-- Records the cover uploaded by the Portal to the event-covers bucket under the event's folder.
create function public.set_portal_event_cover(
  p_event_id uuid, p_cover_path text, p_cover_alt text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_event public.portal_events%rowtype;
  v_alt text := btrim(p_cover_alt);
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_event_id is null or v_alt is null or char_length(v_alt) not between 1 and 180
    or p_cover_path is null or p_cover_path !~ ('^events/' || p_event_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    raise exception using errcode = '22023', message = 'INVALID_PORTAL_EVENT_COVER';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('communications', 'event_cover', v_actor_id), p_idempotency_key,
    jsonb_build_object('event_id', p_event_id, 'cover_path', p_cover_path, 'cover_alt', v_alt));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select * into v_event from public.portal_events where id = p_event_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_NOT_FOUND';
  end if;
  if v_event.status = 'CANCELADO' then
    raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_CANCELLED';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'event-covers' and name = p_cover_path) then
    raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_COVER_MISSING';
  end if;
  update public.portal_events set cover_path = p_cover_path, cover_alt = v_alt, revision = revision + 1,
    updated_by = v_actor_id, updated_at = now() where id = p_event_id;
  v_result := private.portal_event_json(p_event_id, true) || jsonb_build_object('correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('communications.event.cover_set', v_actor_id, 'portal_event', p_event_id::text, p_correlation_id,
    jsonb_build_object('previous_cover_path', v_event.cover_path, 'cover_path', p_cover_path));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'portal_event', p_event_id::text);
  return v_result;
end;
$$;

-- Events shown to signed-in people: upcoming ones in date order, or the archive of past ones. Drafts never appear.
create function public.list_portal_events(p_archive boolean default false, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('portal.access') then
    raise exception using errcode = '42501', message = 'PORTAL_ACCESS_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_PORTAL_EVENT_FILTER';
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(private.portal_event_json(page.id, false) order by page.position)
    from (
      select event.id, row_number() over (order by
          case when coalesce(p_archive, false) then null else event.starts_at end asc,
          case when coalesce(p_archive, false) then coalesce(event.ends_at, event.starts_at) end desc, event.id) as position
      from public.portal_events event
      where event.status in ('PUBLICADO', 'CANCELADO') and event.published_at is not null
        and private.portal_event_over(event) = coalesce(p_archive, false)
      order by position limit p_limit
    ) page), '[]'::jsonb));
end;
$$;

create function public.get_portal_event(p_event_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_manager boolean := public.has_permission('communications.manage');
  v_result jsonb;
begin
  if auth.uid() is null or not public.has_permission('portal.access') then
    raise exception using errcode = '42501', message = 'PORTAL_ACCESS_REQUIRED';
  end if;
  select private.portal_event_json(event.id, v_manager) into v_result from public.portal_events event
  where event.id = p_event_id and (v_manager or event.published_at is not null);
  if v_result is null then
    raise exception using errcode = 'P0001', message = 'PORTAL_EVENT_NOT_FOUND';
  end if;
  return v_result;
end;
$$;

create function public.list_portal_events_admin(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_PORTAL_EVENT_FILTER';
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(private.portal_event_json(page.id, true) order by page.over, page.starts_at desc, page.id)
    from (select event.id, event.starts_at, private.portal_event_over(event) as over from public.portal_events event
      order by private.portal_event_over(event), event.starts_at desc, event.id limit p_limit) page), '[]'::jsonb),
    'sellers', coalesce((select jsonb_agg(jsonb_build_object('id', profile.id,
        'name', coalesce(nullif(btrim(profile.display_name), ''), profile.email)) order by profile.display_name)
      from private.staff_with_permission('sales.create') seller join public.profiles profile on profile.id = seller.recipient_id), '[]'::jsonb),
    'promotions', coalesce((select jsonb_agg(jsonb_build_object('id', promotion.id, 'name', promotion.name) order by promotion.name)
      from public.promotions promotion where promotion.active and promotion.publicable
        and (promotion.valid_to is null or promotion.valid_to > now())), '[]'::jsonb));
end;
$$;

-- Event notices are handled here; every other topic keeps the existing processor.
alter function public.worker_process_outbox_event(uuid, text) set schema private;
alter function private.worker_process_outbox_event(uuid, text) rename to process_outbox_event_before_events;
revoke all on function private.process_outbox_event_before_events(uuid, text) from public, anon, authenticated, service_role;

create function public.worker_process_outbox_event(p_event_id uuid, p_worker_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.outbox_events%rowtype;
  v_portal_event public.portal_events%rowtype;
  v_row record;
  v_count integer := 0;
begin
  perform private.assert_worker_role();
  select * into v_event from public.outbox_events
  where id = p_event_id and status = 'PROCESSING' and locked_by = p_worker_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'OUTBOX_CLAIM_MISMATCH';
  end if;
  if v_event.topic not in ('communications.event.published', 'communications.event.cancelled') then
    return private.process_outbox_event_before_events(p_event_id, p_worker_id);
  end if;
  select * into v_event from public.outbox_events where id = p_event_id for update;
  select * into v_portal_event from public.portal_events where id = v_event.aggregate_id::uuid;

  -- A notice that is no longer true when the worker runs is not sent: an event cancelled before its
  -- announcement went out, or one that is already over.
  if public.is_feature_enabled('notifications') and not private.portal_event_over(v_portal_event)
    and ((v_event.topic = 'communications.event.published' and v_portal_event.status = 'PUBLICADO')
      or v_event.topic = 'communications.event.cancelled') then
    for v_row in
      select recipient.recipient_id from private.staff_with_permission('portal.access') recipient
      where v_event.topic = 'communications.event.published' and private.wants_notification(recipient.recipient_id, 'EVENTOS')
      union
      -- A cancellation reaches exactly the people who received the announcement.
      select notice.recipient_id from public.notifications notice
      where v_event.topic = 'communications.event.cancelled' and notice.kind = 'EVENT_PUBLISHED'
        and notice.data ->> 'event_id' = v_portal_event.id::text
    loop
      v_count := v_count + private.add_notification(v_event.id, v_row.recipient_id,
        case when v_event.topic = 'communications.event.published' then 'EVENT_PUBLISHED' else 'EVENT_CANCELLED' end,
        case when v_event.topic = 'communications.event.published'
          then case v_portal_event.kind when 'CAMPANHA' then 'Nova campanha' else 'Novo evento' end
          else case v_portal_event.kind when 'CAMPANHA' then 'Campanha cancelada' else 'Evento cancelado' end end,
        case when v_event.topic = 'communications.event.published'
          then v_portal_event.title || ' — ' || to_char(v_portal_event.starts_at at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI') || '.'
          else v_portal_event.title || ' foi cancelado.' end,
        jsonb_build_object('event_id', v_portal_event.id));
    end loop;
  end if;

  perform private.ack_outbox_event(v_event.id, p_worker_id);
  return jsonb_build_object('event_id', v_event.id, 'topic', v_event.topic,
    'notifications_created', v_count, 'status', 'PUBLISHED');
end;
$$;

revoke all on function private.portal_event_over(public.portal_events) from public, anon, authenticated, service_role;
revoke all on function private.portal_event_json(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.save_portal_event(uuid, integer, public.portal_event_kind, text, text, timestamptz, timestamptz, text, text, text, text, uuid[], uuid[], uuid[], text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.transition_portal_event(uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_portal_event_cover(uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_portal_events(boolean, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_portal_event(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_portal_events_admin(integer) from public, anon, authenticated, service_role;
revoke all on function public.worker_process_outbox_event(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.save_portal_event(uuid, integer, public.portal_event_kind, text, text, timestamptz, timestamptz, text, text, text, text, uuid[], uuid[], uuid[], text, uuid)
  to authenticated;
grant execute on function public.transition_portal_event(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.set_portal_event_cover(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.list_portal_events(boolean, integer) to authenticated;
grant execute on function public.get_portal_event(uuid) to authenticated;
grant execute on function public.list_portal_events_admin(integer) to authenticated;
grant execute on function public.worker_process_outbox_event(uuid, text) to service_role;
