-- ROLLBACK ARTIFACT — NOT A MIGRATION. Never place this file in supabase/migrations; `supabase db push` must never
-- apply it. Use only with explicit authorization, as described in docs/operations/cohort-cutover-runbook.md
-- ("Fase 5 — reversão").
--
-- Reverts the behavior of 20261023090000_cohort_explicit_context (multi-turma, PR 5) to the state right after
-- 20261022090000_cohort_consolidated (PR 4), the state under which the application without cohort context (the
-- version before the multi-cohort Portal/PDV) operates: a person or system without a cohort falls back to the default
-- cohort again.
--
-- What it does (functions, one trigger and storage policy expressions only):
--   * restores the PR 4 bodies of private.cohort_fallback_enabled, private.cohort_scope, private.cohort_readable,
--     private.guard_cohort_write, private.assign_log_cohort, private.join_default_cohort, public.handle_new_auth_user,
--     public.record_share_visit and public.set_user_access (bodies taken verbatim from pg_get_functiondef of a database
--     at 20261022090000; same signatures, same grants);
--   * restores the PR 4 expressions of the storage policies catalog_images_admin_insert, catalog_images_admin_delete,
--     event_covers_communications_insert and stock_loss_photos_read;
--   * drops what Phase 5 added: trigger cohorts_default_active, private.guard_default_cohort, public.set_default_cohort,
--     public.resolve_public_cohort, public.close_seller_shift_on_behalf, public.storage_entity_in_scope.
-- What it never does: no table, column, constraint, index, row, id, audit record or migration history is changed or
-- deleted. The multi-cohort structure (cohorts, memberships, cohort_data tables, views, RLS, PR 2–4 functions) stays.
-- public.list_my_share_links keeps its Phase 5 fix (mine is always a boolean); it is cohort-neutral.
--
-- Idempotent: every statement is create-or-replace, alter policy or drop-if-exists; running it twice leaves the same
-- state. Pre-checks (fail-closed): the latest applied migration is exactly 20261023090000, the PR 2–4 structure exists,
-- exactly one default cohort, ACTIVE. Post-checks below. Apply in one transaction:
--   psql ... -v ON_ERROR_STOP=1 -1 -f supabase/rollback/20261023090000_cohort_explicit_context.rollback.sql
-- (or paste it whole in the Supabase SQL editor, which runs it as one transaction).
--
-- Reapplying Phase 5 later: run supabase/migrations/20261023090000_cohort_explicit_context.sql the same way (its
-- pre-checks and post-checks run again). schema_migrations still lists 20261023090000 throughout, so `db push`
-- neither re-applies nor complains.
--
-- Tested by tools/upgrade-check/cohort-rollback-check.mjs (pnpm test:rollback).

set local lock_timeout = '5s';

-- Pre-checks (fail-closed) -----------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261022090000') then
    raise exception 'COHORT_ROLLBACK_PRECHECK: PR 4 (20261022090000) is not applied; this rollback only targets the PR 4 state';
  end if;
  -- This artifact restores the PR 4 bodies: on a database with later migrations it would silently undo them.
  if (select max(version) from supabase_migrations.schema_migrations) <> '20261023090000' then
    raise exception 'COHORT_ROLLBACK_PRECHECK: the latest applied migration is %, not 20261023090000; prepare a rollback for that state',
      (select max(version) from supabase_migrations.schema_migrations);
  end if;
  if to_regclass('private.cohort_scoped_tables') is null or to_regclass('public.cohorts') is null
    or to_regprocedure('public.user_cohort_memberships(uuid)') is null or to_regprocedure('public.cohort_overview()') is null then
    raise exception 'COHORT_ROLLBACK_PRECHECK: the PR 2–4 multi-cohort structure is incomplete';
  end if;
  if (select count(*) from public.cohorts where is_default) <> 1 then
    raise exception 'COHORT_ROLLBACK_PRECHECK: exactly one default cohort is required (the restored fallback uses it)';
  end if;
  if exists (select 1 from public.cohorts where is_default and status <> 'ACTIVE') then
    raise exception 'COHORT_ROLLBACK_PRECHECK: the default cohort must be ACTIVE (the restored fallback uses it)';
  end if;
end;
$$;

-- 1. Storage policies: PR 4 expressions (before storage_entity_in_scope is dropped) --------------------------------
alter policy catalog_images_admin_insert on storage.objects with check (((bucket_id = 'product-images'::text) AND ( SELECT has_permission('catalog.manage'::text) AS has_permission) AND (name ~ '^products/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'::text) AND (lower(storage.extension(name)) = ANY (ARRAY['jpg'::text, 'png'::text, 'webp'::text]))));
alter policy catalog_images_admin_delete on storage.objects using (((bucket_id = 'product-images'::text) AND ( SELECT has_permission('catalog.manage'::text) AS has_permission) AND (name ~ '^products/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'::text)));
alter policy event_covers_communications_insert on storage.objects with check (((bucket_id = 'event-covers'::text) AND ( SELECT has_permission('communications.manage'::text) AS has_permission) AND (name ~ '^events/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'::text)));
alter policy stock_loss_photos_read on storage.objects using (((bucket_id = 'stock-loss-photos'::text) AND ((owner_id = (( SELECT auth.uid() AS uid))::text) OR ( SELECT has_permission('inventory.manage'::text) AS has_permission))));

-- 2. What Phase 5 added ---------------------------------------------------------------------------------------------
drop trigger if exists cohorts_default_active on public.cohorts;
drop function if exists private.guard_default_cohort();
drop function if exists public.set_default_cohort(uuid, text, uuid);
drop function if exists public.resolve_public_cohort(text);
drop function if exists public.close_seller_shift_on_behalf(uuid, bigint, text, text, uuid);
drop function if exists public.storage_entity_in_scope(text, text);

-- 3. PR 4 bodies of the functions Phase 5 replaced (verbatim pg_get_functiondef at 20261022090000) -----------------

-- private.cohort_fallback_enabled
CREATE OR REPLACE FUNCTION private.cohort_fallback_enabled()
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$ select true $function$;

-- private.cohort_scope
CREATE OR REPLACE FUNCTION private.cohort_scope()
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller text := private.cohort_caller();
  v_header text := private.cohort_header();
  v_system uuid := private.cohort_system_context();
  v_key text := v_caller || '|' || coalesce(auth.uid()::text, '') || '|' || coalesce(v_header, '') || '|' || coalesce(v_system::text, '');
  v_cached text := nullif(current_setting('germinatura.cohort_scope', true), '');
  v_scope uuid[];
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
    select coalesce(array_agg(id), '{}') into v_scope from public.cohorts where is_default;
  elsif v_header = 'all' then
    if private.is_admin_master() then
      select coalesce(array_agg(id order by id), '{}') into v_scope from public.cohorts;
    else
      v_scope := '{}';
    end if;
  elsif v_header is not null then
    if v_header ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and exists (select 1 from public.cohorts where id = v_header::uuid) and private.cohort_readable(v_header::uuid) then
      v_scope := array[v_header::uuid];
    else
      v_scope := '{}';
    end if;
  elsif private.cohort_fallback_enabled() then
    select coalesce(array_agg(id), '{}') into v_scope from public.cohorts where is_default and private.cohort_readable(id);
    if v_scope = '{}' then
      select coalesce(array_agg(cohort_id), '{}') into v_scope from public.user_cohorts
      where user_id = auth.uid() and status = 'ACTIVE' having count(*) = 1;
    end if;
  else
    -- Final state: only a caller with exactly one accessible cohort has it inferred; ADMIN_MASTER never does.
    if private.is_admin_master() then
      v_scope := '{}';
    else
      select coalesce(array_agg(cohort_id), '{}') into v_scope from public.user_cohorts
      where user_id = auth.uid() and status = 'ACTIVE' having count(*) = 1;
    end if;
  end if;
  v_scope := coalesce(v_scope, '{}');
  perform set_config('germinatura.cohort_scope', v_key || '#' || v_scope::text, true);
  return v_scope;
end;
$function$;

-- private.cohort_readable
CREATE OR REPLACE FUNCTION private.cohort_readable(p_cohort_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case private.cohort_caller()
    when 'system' then true
    when 'service' then true
    when 'anon' then exists (select 1 from public.cohorts where id = p_cohort_id and is_default)
    else private.is_admin_master() or exists (
      select 1 from public.user_cohorts membership
      where membership.user_id = auth.uid() and membership.cohort_id = p_cohort_id and membership.status = 'ACTIVE')
  end
$function$;

-- private.guard_cohort_write
CREATE OR REPLACE FUNCTION private.guard_cohort_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if v_user and v_override is null then
    v_write := private.cohort_write_id();
  elsif v_override is not null then
    v_write := v_override;
  else
    v_write := private.cohort_write_id();
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
    new.cohort_id := coalesce(v_write, (select id from public.cohorts where is_default));
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
$function$;

-- private.assign_log_cohort
CREATE OR REPLACE FUNCTION private.assign_log_cohort()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_type text;
  v_id text;
  v_data jsonb;
  v_table text;
  v_known boolean;
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
  if v_known and v_table is null then
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
  return new;
end;
$function$;

-- private.join_default_cohort
CREATE OR REPLACE FUNCTION private.join_default_cohort()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.user_cohorts (user_id, cohort_id)
  select new.id, cohort.id from public.cohorts cohort where cohort.is_default
  on conflict (user_id, cohort_id) do nothing;
  return new;
end;
$function$;

-- public.handle_new_auth_user
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_name text := nullif(btrim(new.raw_user_meta_data ->> 'name'), '');
  v_username text := lower(nullif(btrim(new.raw_user_meta_data ->> 'username'), ''));
  v_completed_at timestamptz;
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

  insert into public.user_roles (user_id, role_id)
  select new.id, id from public.roles where key = 'CONSUMIDOR';
  return new;
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'USERNAME_ALREADY_USED';
end;
$function$;

-- public.record_share_visit
CREATE OR REPLACE FUNCTION public.record_share_visit(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

-- public.set_user_access
CREATE OR REPLACE FUNCTION public.set_user_access(p_user_id uuid, p_roles text[], p_active boolean, p_correlation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is not null and p_user_id is not null and not private.cohort_member_visible(p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  return private.set_user_access_in_cohort(p_user_id, p_roles, p_active, p_correlation_id);
end;
$function$;

-- Post-checks ------------------------------------------------------------------------------------------------------
do $$
begin
  if not private.cohort_fallback_enabled() then
    raise exception 'COHORT_ROLLBACK_POSTCHECK: the rollout fallback is still off';
  end if;
  if to_regprocedure('public.set_default_cohort(uuid, text, uuid)') is not null or to_regprocedure('public.resolve_public_cohort(text)') is not null
    or to_regprocedure('public.close_seller_shift_on_behalf(uuid, bigint, text, text, uuid)') is not null
    or to_regprocedure('public.storage_entity_in_scope(text, text)') is not null or to_regprocedure('private.guard_default_cohort()') is not null
    or exists (select 1 from pg_trigger where tgname = 'cohorts_default_active') then
    raise exception 'COHORT_ROLLBACK_POSTCHECK: a Phase 5 object is still present';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and (coalesce(qual, '') || coalesce(with_check, '')) like '%storage_entity_in_scope%') then
    raise exception 'COHORT_ROLLBACK_POSTCHECK: a storage policy still uses storage_entity_in_scope';
  end if;
  if (select count(*) from public.cohorts where is_default and status = 'ACTIVE') <> 1 then
    raise exception 'COHORT_ROLLBACK_POSTCHECK: exactly one ACTIVE default cohort is required';
  end if;
end;
$$;
