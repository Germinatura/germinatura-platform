-- Multi-turma, PR 5 (ADR 0011): no record falls into a cohort by absence of context. Functions only: no table, column
-- or row changes (the cohort_id columns lost their constant default in PR 2; the remaining implicit cohort lived in the
-- write guard, the rollout fallback and the sign-up trigger). Expand → validate → enforce:
--   validate: every scoped row already has its cohort, no cohort_id column has a default, exactly one ACTIVE default;
--   enforce:  scoped writes without a determinable cohort fail (COHORT_REQUIRED); the rollout fallback is off;
--             the default cohort is an explicit, ADMIN_MASTER-managed choice for public entry, never a write fallback.

set local lock_timeout = '5s';

-- Pre-checks (fail-closed) -----------------------------------------------------------------------------------------
do $$
declare
  v_table record;
  v_missing bigint;
begin
  if (select count(*) from public.cohorts where is_default) <> 1 then
    raise exception 'COHORT_EXPLICIT_PRECHECK: exactly one default cohort is required';
  end if;
  if exists (select 1 from public.cohorts where is_default and status <> 'ACTIVE') then
    raise exception 'COHORT_EXPLICIT_PRECHECK: the default cohort must be ACTIVE';
  end if;
  for v_table in select table_name from private.cohort_scoped_tables where mode = 'REQUIRED' order by table_name loop
    execute format('select count(*) from cohort_data.%I where cohort_id is null', v_table.table_name) into v_missing;
    if v_missing > 0 then
      raise exception 'COHORT_EXPLICIT_PRECHECK: % rows of % have no cohort', v_missing, v_table.table_name;
    end if;
  end loop;
  if exists (select 1 from pg_attribute attribute join pg_attrdef def on def.adrelid = attribute.attrelid and def.adnum = attribute.attnum
      join pg_class class on class.oid = attribute.attrelid
      where attribute.attname = 'cohort_id' and class.relnamespace in ('cohort_data'::regnamespace, 'public'::regnamespace)) then
    raise exception 'COHORT_EXPLICIT_PRECHECK: a cohort_id column still has a default';
  end if;
  if exists (select 1 from private.cohort_integrity_report() where violations <> 0) then
    raise exception 'COHORT_EXPLICIT_PRECHECK: the integrity report is not clean';
  end if;
end;
$$;

-- 1. Rollout fallback off -------------------------------------------------------------------------------------------
-- Kept for compatibility of callers; always false from now on.
create or replace function private.cohort_fallback_enabled() returns boolean
language sql immutable set search_path = '' as $$ select false $$;

-- 2. Request scope: no implicit cohort for signed-in callers; visitors read the public default cohort, or the ACTIVE
-- cohort named explicitly by the request (resolved server-side from a public slug or a share link).
create or replace function private.cohort_scope() returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_caller text := private.cohort_caller();
  v_header text := private.cohort_header();
  v_system uuid := private.cohort_system_context();
  v_key text := v_caller || '|' || coalesce(auth.uid()::text, '') || '|' || coalesce(v_header, '') || '|' || coalesce(v_system::text, '');
  v_cached text := nullif(current_setting('germinatura.cohort_scope', true), '');
  v_scope uuid[];
  v_uuid boolean := coalesce(v_header ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false);
begin
  if v_cached is not null and split_part(v_cached, '#', 1) = v_key then
    return split_part(v_cached, '#', 2)::uuid[];
  end if;
  if v_caller in ('system', 'service') then
    if v_system is not null then
      v_scope := array[v_system];
    else
      select coalesce(array_agg(id order by id), '{}') into v_scope from public.cohorts;
    end if;
  elsif v_caller = 'anon' then
    if v_header is null then
      select coalesce(array_agg(id), '{}') into v_scope from public.cohorts where is_default and status = 'ACTIVE';
    elsif v_uuid then
      select coalesce(array_agg(id), '{}') into v_scope from public.cohorts where id = v_header::uuid and status = 'ACTIVE';
    else
      v_scope := '{}';
    end if;
  elsif v_header = 'all' then
    if private.is_admin_master() then
      select coalesce(array_agg(id order by id), '{}') into v_scope from public.cohorts;
    else
      v_scope := '{}';
    end if;
  elsif v_header is not null then
    if v_uuid and exists (select 1 from public.cohorts where id = v_header::uuid) and private.cohort_readable(v_header::uuid) then
      v_scope := array[v_header::uuid];
    else
      v_scope := '{}';
    end if;
  elsif private.is_admin_master() then
    -- ADMIN_MASTER always names the cohort (or "all").
    v_scope := '{}';
  else
    -- Resolved, not defaulted: the caller's only active cohort; with none or several, nothing.
    select coalesce(array_agg(cohort_id), '{}') into v_scope from public.user_cohorts
    where user_id = auth.uid() and status = 'ACTIVE' having count(*) = 1;
  end if;
  v_scope := coalesce(v_scope, '{}');
  perform set_config('germinatura.cohort_scope', v_key || '#' || v_scope::text, true);
  return v_scope;
end;
$$;

-- Visitors may read the public data of ACTIVE cohorts only (never PREPARING or ARCHIVED).
create or replace function private.cohort_readable(p_cohort_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.cohort_caller()
    when 'system' then true
    when 'service' then true
    when 'anon' then exists (select 1 from public.cohorts where id = p_cohort_id and status = 'ACTIVE')
    else private.is_admin_master() or exists (
      select 1 from public.user_cohorts membership
      where membership.user_id = auth.uid() and membership.cohort_id = p_cohort_id and membership.status = 'ACTIVE')
  end
$$;

-- 3. Write guard: a scoped row takes its cohort from its parent, the request or the explicit system context; with
-- none of them the write fails. No default cohort, no hidden fallback.
create or replace function private.guard_cohort_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mode text := tg_argv[0];
  v_caller text := private.cohort_caller();
  v_user boolean := v_caller in ('user', 'anon');
  v_override uuid := nullif(current_setting('germinatura.cohort_override', true), '')::uuid;
  v_write uuid;
  v_row jsonb;
  v_parent uuid;
  v_value text;
  v_index integer := 1;
begin
  if v_override is not null then
    v_write := v_override;
  elsif v_user then
    -- People write only inside the request cohort, which must be determinable (raises COHORT_REQUIRED otherwise).
    v_write := private.cohort_write_id();
  else
    -- System and service writes name their cohort explicitly (enter_cohort_context) or inherit it from the parent.
    v_write := private.cohort_system_context();
  end if;
  if tg_op = 'DELETE' then
    if v_user and old.cohort_id is distinct from v_write and not (v_mode = 'SHARED_NULLABLE' and old.cohort_id is null) then
      raise exception using errcode = '42501', message = 'COHORT_MISMATCH';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and new.cohort_id is distinct from old.cohort_id
    and not (v_mode = 'SHARED_NULLABLE' and old.cohort_id is null) then
    raise exception using errcode = '42501', message = 'COHORT_IMMUTABLE';
  end if;
  v_row := to_jsonb(new);
  while v_index < tg_nargs loop
    v_value := v_row ->> tg_argv[v_index];
    if v_value is not null then
      execute format('select cohort_id from cohort_data.%I where %I = $1::%s', tg_argv[v_index + 1], tg_argv[v_index + 2], tg_argv[v_index + 3])
        into v_parent using v_value;
      if v_parent is not null then
        if new.cohort_id is null then
          new.cohort_id := v_parent;
        elsif v_parent <> new.cohort_id then
          raise exception using errcode = '42501', message = 'COHORT_MISMATCH';
        end if;
      end if;
    end if;
    v_index := v_index + 4;
  end loop;
  if new.cohort_id is null and v_mode = 'REQUIRED' then
    if v_write is null then
      raise exception using errcode = '22023', message = 'COHORT_REQUIRED', detail = 'cohort_data.' || tg_table_name;
    end if;
    new.cohort_id := v_write;
  end if;
  if (v_user or v_override is not null) and new.cohort_id is not null then
    if new.cohort_id is distinct from v_write then
      raise exception using errcode = '42501', message = 'COHORT_MISMATCH';
    end if;
    if v_override is null and exists (select 1 from public.cohorts where id = new.cohort_id and status = 'ARCHIVED') then
      raise exception using errcode = '42501', message = 'COHORT_ARCHIVED';
    end if;
  end if;
  return new;
end;
$$;

-- 4. Audit and outbox: NULL means a truly global operation, never "cohort not found". A record whose entity type is
-- not classified as global and whose cohort cannot be determined fails.
create or replace function private.assign_log_cohort() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_type text;
  v_id text;
  v_data jsonb;
  v_table text;
  v_known boolean := false;
begin
  if new.cohort_id is not null then
    return new;
  end if;
  if tg_table_name = 'audit_logs' then
    v_type := to_jsonb(new) ->> 'entity_type';
    v_id := to_jsonb(new) ->> 'entity_id';
    v_data := to_jsonb(new) -> 'metadata';
  else
    v_type := to_jsonb(new) ->> 'aggregate_type';
    v_id := to_jsonb(new) ->> 'aggregate_id';
    v_data := to_jsonb(new) -> 'payload';
  end if;
  if coalesce(v_data ->> 'cohort_scope', '') = 'GLOBAL' then
    return new;
  end if;
  select true, entity.table_name into v_known, v_table from private.cohort_entity_types entity where entity.entity_type = v_type;
  if coalesce(v_known, false) and v_table is null then
    return new;
  end if;
  if v_table is not null and v_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    execute format('select cohort_id from cohort_data.%I where id = $1::uuid', v_table) into new.cohort_id using v_id;
  end if;
  if new.cohort_id is null then
    if private.cohort_caller() in ('user', 'anon') then
      new.cohort_id := case when private.cohort_mode() = 'COHORT' then (private.cohort_scope())[1] end;
    else
      new.cohort_id := private.cohort_system_context();
    end if;
  end if;
  if new.cohort_id is null then
    raise exception using errcode = '22023', message = 'COHORT_REQUIRED', detail = tg_table_name || ':' || coalesce(v_type, '?');
  end if;
  return new;
end;
$$;

-- 5. Sign-up: a new public account joins the ACTIVE default cohort, persisted explicitly (membership and base role);
-- no column default and no write fallback are involved. Without an ACTIVE default the sign-up fails.
create or replace function private.join_default_cohort() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cohort uuid := (select id from public.cohorts where is_default and status = 'ACTIVE');
begin
  if v_cohort is null then
    raise exception using errcode = 'P0001', message = 'DEFAULT_COHORT_REQUIRED';
  end if;
  insert into public.user_cohorts (user_id, cohort_id) values (new.id, v_cohort)
  on conflict (user_id, cohort_id) do nothing;
  return new;
end;
$$;

create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := nullif(btrim(new.raw_user_meta_data ->> 'name'), '');
  v_username text := lower(nullif(btrim(new.raw_user_meta_data ->> 'username'), ''));
  v_completed_at timestamptz;
  v_cohort uuid := (select id from public.cohorts where is_default and status = 'ACTIVE');
begin
  if not private.is_institutional_email(new.email) then
    raise exception using errcode = 'P0001', message = 'INSTITUTIONAL_EMAIL_REQUIRED';
  end if;
  if v_name is not null and char_length(v_name) not between 2 and 120 then
    raise exception using errcode = '22023', message = 'INVALID_PROFILE_NAME';
  end if;
  if v_username is not null and v_username !~ '^[a-z][a-z0-9._]{2,31}$' then
    raise exception using errcode = '22023', message = 'INVALID_USERNAME';
  end if;
  if v_cohort is null then
    raise exception using errcode = 'P0001', message = 'DEFAULT_COHORT_REQUIRED';
  end if;
  if new.email_confirmed_at is not null
    and nullif(new.encrypted_password, '') is not null
    and v_name is not null
    and v_username is not null then
    v_completed_at := statement_timestamp();
  end if;

  insert into public.profiles (
    id, email, display_name, username, onboarding_completed_at
  ) values (
    new.id,
    lower(btrim(new.email)),
    coalesce(v_name, split_part(lower(btrim(new.email)), '@', 1)),
    v_username,
    v_completed_at
  );

  -- ADR 0011 (PR 5): the base role belongs to the cohort the account joins, named explicitly.
  insert into public.user_roles (user_id, role_id, cohort_id)
  select new.id, id, v_cohort from public.roles where key = 'CONSUMIDOR';
  return new;
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'USERNAME_ALREADY_USED';
end;
$$;

-- 6. Default cohort: chosen by ADMIN_MASTER, for public entry only. Exactly one, always ACTIVE.
create function public.set_default_cohort(p_cohort_id uuid, p_reason text, p_correlation_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_previous public.cohorts%rowtype;
  v_target public.cohorts%rowtype;
begin
  if v_actor_id is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  if p_cohort_id is null or p_correlation_id is null or p_reason is null or char_length(btrim(p_reason)) not between 4 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_COHORT';
  end if;
  -- Serializes concurrent changes: the second waits, then sees the first one's result.
  perform 1 from public.cohorts order by id for update;
  select * into v_target from public.cohorts where id = p_cohort_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'COHORT_NOT_FOUND';
  end if;
  if v_target.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = 'DEFAULT_COHORT_MUST_BE_ACTIVE';
  end if;
  select * into v_previous from public.cohorts where is_default;
  if v_previous.id = p_cohort_id then
    return jsonb_build_object('default_cohort_id', p_cohort_id, 'changed', false, 'correlation_id', p_correlation_id);
  end if;
  update public.cohorts set is_default = false where id = v_previous.id;
  update public.cohorts set is_default = true where id = p_cohort_id;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values ('cohorts.default.changed', v_actor_id, 'cohort', p_cohort_id::text, p_correlation_id,
    jsonb_build_object('reason', btrim(p_reason), 'previous_cohort_id', v_previous.id, 'cohort_scope', 'GLOBAL'), null);
  return jsonb_build_object('default_cohort_id', p_cohort_id, 'previous_cohort_id', v_previous.id, 'changed', true, 'correlation_id', p_correlation_id);
end;
$$;
revoke all on function public.set_default_cohort(uuid, text, uuid) from public, anon;
grant execute on function public.set_default_cohort(uuid, text, uuid) to authenticated;

-- The default cohort stays ACTIVE: never archived, never back to PREPARING (choose another default first).
create or replace function private.guard_default_cohort() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.is_default and new.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = 'DEFAULT_COHORT_MUST_BE_ACTIVE';
  end if;
  return new;
end;
$$;
create trigger cohorts_default_active before insert or update on public.cohorts
for each row execute function private.guard_default_cohort();

-- 7. Public resolution: a visitor names a cohort by its public slug; the server resolves it to an ACTIVE cohort.
create function public.resolve_public_cohort(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', cohort.id, 'name', cohort.name, 'year', cohort.year, 'slug', cohort.slug, 'is_default', cohort.is_default)
  from public.cohorts cohort
  where p_slug is not null and p_slug ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$' and cohort.slug = p_slug and cohort.status = 'ACTIVE'
$$;
revoke all on function public.resolve_public_cohort(text) from public;
grant execute on function public.resolve_public_cohort(text) to anon, authenticated;

-- 8. Share links: the code itself resolves the campaign and its cohort on the server; the visit is recorded in that
-- cohort. Links of a cohort that is not ACTIVE record nothing.
create or replace function public.record_share_visit(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_campaign record;
begin
  if p_code is null or p_code !~ '^[a-z0-9]{8}$' then
    return null;
  end if;
  select campaign.id, campaign.code, campaign.product_ids, campaign.cohort_id, cohort.slug, cohort.is_default
  into v_campaign
  from cohort_data.share_campaigns campaign
  join public.cohorts cohort on cohort.id = campaign.cohort_id and cohort.status = 'ACTIVE'
  where campaign.code = p_code;
  if not found then
    return null;
  end if;
  -- The visitor's request scope is the default cohort; the visit belongs to the link's cohort, written explicitly.
  perform private.cohort_write_override(v_campaign.cohort_id);
  insert into cohort_data.share_visits (campaign_id, cohort_id) values (v_campaign.id, v_campaign.cohort_id);
  perform private.cohort_write_override(null);
  return jsonb_build_object('campaign_id', v_campaign.id, 'code', v_campaign.code, 'product_ids', to_jsonb(v_campaign.product_ids),
    'cohort_slug', v_campaign.slug, 'cohort_is_default', v_campaign.is_default);
end;
$$;

-- 9. Revoking access at once (security first) never waits for open work, but says what remains for another ADMIN or
-- ADMIN_MASTER to take over; nothing of it is changed or deleted.
create or replace function public.set_user_access(p_user_id uuid, p_roles text[], p_active boolean, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_cohort uuid;
begin
  if auth.uid() is not null and p_user_id is not null and not private.cohort_member_visible(p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  v_result := private.set_user_access_in_cohort(p_user_id, p_roles, p_active, p_correlation_id);
  if p_active is false then
    v_cohort := (v_result ->> 'cohort_id')::uuid;
    v_result := v_result || jsonb_build_object('pending_operations',
      coalesce(to_jsonb(array_remove(private.membership_blockers(p_user_id, v_cohort), 'LAST_COHORT_ADMIN')), '[]'::jsonb));
  end if;
  return v_result;
end;
$$;

-- 10. Another ADMIN or FINANCEIRO of the cohort takes over the open shift of a person whose access was revoked: the
-- same expected-cash computation, a mandatory justification, and an audit naming both the seller and who closed it.
-- (Stock, pending sales and stock requests already have administrative paths: transfer_stock, cancel_sale,
-- resolve_seller_stock_transfer, resolve_stock_return.)
create function public.close_seller_shift_on_behalf(p_shift_id uuid, p_counted_cash_cents bigint, p_justification text,
  p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_shift public.seller_shifts%rowtype;
  v_claim record;
  v_expected bigint;
  v_justification text := nullif(btrim(p_justification), '');
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_REQUIRED';
  end if;
  if p_correlation_id is null or p_counted_cash_cents is null or p_counted_cash_cents not between 0 and 9007199254740991
    or v_justification is null or char_length(v_justification) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_SELLER_SHIFT_CLOSE';
  end if;
  select * into v_shift from public.seller_shifts where id = p_shift_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('shifts', 'close-on-behalf', v_actor_id), p_idempotency_key,
    jsonb_build_object('shift_id', p_shift_id, 'counted_cash_cents', p_counted_cash_cents, 'justification', v_justification));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if v_shift.status <> 'OPEN' then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_NOT_OPEN';
  end if;
  select coalesce(sum(amount_cents), 0) into v_expected from public.cash_movements where shift_id = v_shift.id;
  update public.seller_shifts
  set status = 'CLOSED', closed_at = clock_timestamp(), expected_cash_cents = v_expected,
    counted_cash_cents = p_counted_cash_cents, justification = v_justification, closed_correlation_id = p_correlation_id
  where id = v_shift.id;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('shifts.closed_on_behalf', v_actor_id, 'seller_shift', v_shift.id::text, p_correlation_id,
    jsonb_build_object('seller_id', v_shift.seller_id, 'expected_cash_cents', v_expected, 'counted_cash_cents', p_counted_cash_cents,
      'difference_cents', p_counted_cash_cents - v_expected, 'justification', v_justification));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('shifts.closed', 'seller_shift', v_shift.id::text,
    jsonb_build_object('shift_id', v_shift.id, 'seller_id', v_shift.seller_id, 'closed_by', v_actor_id,
      'difference_cents', p_counted_cash_cents - v_expected));
  v_result := private.seller_shift_summary(v_shift.id) || jsonb_build_object('correlation_id', p_correlation_id, 'closed_on_behalf', true);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'seller_shift', v_shift.id::text);
  return v_result;
end;
$$;
revoke all on function public.close_seller_shift_on_behalf(uuid, bigint, text, text, uuid) from public, anon;
grant execute on function public.close_seller_shift_on_behalf(uuid, bigint, text, text, uuid) to authenticated;

-- 11. Storage: object paths name the entity (product, event) or the uploader, not the cohort. The policies required the
-- permission of the request cohort but not that the entity belongs to it; now the entity must be in the request scope,
-- so an ADMIN of one cohort cannot write, delete or read files of another. One definer check (policies are evaluated
-- together, and the roles have no direct grant on every view).
create function public.storage_entity_in_scope(p_kind text, p_key text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_kind in ('product', 'event') and (p_key is null or p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return false;
  end if;
  return case p_kind
    when 'product' then exists (select 1 from cohort_data.products where id = p_key::uuid and cohort_id = any ((select private.cohort_scope())::uuid[]))
    when 'event' then exists (select 1 from cohort_data.portal_events where id = p_key::uuid and cohort_id = any ((select private.cohort_scope())::uuid[]))
    when 'loss_photo' then exists (select 1 from cohort_data.stock_loss_reports where photo_path = p_key and cohort_id = any ((select private.cohort_scope())::uuid[]))
    else false
  end;
end;
$$;
revoke all on function public.storage_entity_in_scope(text, text) from public, anon;
grant execute on function public.storage_entity_in_scope(text, text) to authenticated;

alter policy catalog_images_admin_insert on storage.objects with check (
  bucket_id = 'product-images' and (select public.has_permission('catalog.manage'))
  and name ~ '^products/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$' and lower(storage.extension(name)) = any (array['jpg', 'png', 'webp'])
  and public.storage_entity_in_scope('product', (storage.foldername(name))[2]));
alter policy catalog_images_admin_delete on storage.objects using (
  bucket_id = 'product-images' and (select public.has_permission('catalog.manage'))
  and name ~ '^products/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
  and public.storage_entity_in_scope('product', (storage.foldername(name))[2]));
alter policy event_covers_communications_insert on storage.objects with check (
  bucket_id = 'event-covers' and (select public.has_permission('communications.manage'))
  and name ~ '^events/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
  and public.storage_entity_in_scope('event', (storage.foldername(name))[2]));
alter policy stock_loss_photos_read on storage.objects using (
  bucket_id = 'stock-loss-photos' and (owner_id = (select auth.uid())::text
    or ((select public.has_permission('inventory.manage')) and public.storage_entity_in_scope('loss_photo', name))));

-- Post-checks ------------------------------------------------------------------------------------------------------
do $$
begin
  if private.cohort_fallback_enabled() then
    raise exception 'COHORT_EXPLICIT_POSTCHECK: the rollout fallback is still on';
  end if;
  if (select count(*) from public.cohorts where is_default and status = 'ACTIVE') <> 1 then
    raise exception 'COHORT_EXPLICIT_POSTCHECK: exactly one ACTIVE default cohort is required';
  end if;
  if position('is_default' in pg_get_functiondef('private.guard_cohort_write'::regproc)) > 0 then
    raise exception 'COHORT_EXPLICIT_POSTCHECK: the write guard still refers to the default cohort';
  end if;
end;
$$;
