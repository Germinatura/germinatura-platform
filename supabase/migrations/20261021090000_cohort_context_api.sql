-- Cohort context in the Portal and the PDV (ADR 0011, PR 3). Additive and backward compatible: one nullable column,
-- new functions, and wrappers around existing ones (the old signatures keep working during the promotion).
--
-- * PDV handoff: the code records the Portal's concrete cohort on the server, so the PDV opens in that cohort without
--   trusting anything in the URL; codes issued before this migration carry no cohort and the PDV asks for one.
-- * User administration: list_cohort_users replaces the service-role listing; people are listed, counted and found
--   only inside the request cohort (ADMIN_MASTER: any cohort, or all of them in "all").
-- * Operations on a person (access, membership, unlocks) require the person to belong to the request cohort; adding a
--   new person to a cohort belongs to ADMIN_MASTER. Provisioning an operational account places it in the request cohort
--   only (the sign-up trigger would also have placed it in the default cohort).

set local lock_timeout = '5s';

-- Is this person visible to the caller in the request cohort? ADMIN_MASTER sees everyone.
create function private.cohort_member_visible(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin_master() or exists (
    select 1 from public.user_cohorts membership
    where membership.user_id = p_user_id and membership.cohort_id = private.cohort_permission_id())
$$;
revoke all on function private.cohort_member_visible(uuid) from public, anon, authenticated;

-- PDV handoff ---------------------------------------------------------------------------------------------------------
alter table public.pdv_handoff_codes add column if not exists cohort_id uuid references public.cohorts (id);
comment on column public.pdv_handoff_codes.cohort_id is
  'Turma concreta do Portal no momento da emissão; o PDV abre nela (ADR 0011). NULL nos códigos anteriores.';

create or replace function public.create_pdv_handoff(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_expires timestamptz := clock_timestamp() + interval '60 seconds';
  v_cohort_id uuid := private.cohort_permission_id();
begin
  if v_actor_id is null or not public.has_permission('sales.create')
    or not exists (select 1 from public.profiles where id = v_actor_id and active and onboarding_completed_at is not null) then
    raise exception using errcode = '42501', message = 'PDV_ACCESS_REQUIRED';
  end if;
  -- The PDV always operates inside one concrete cohort, never in "all".
  if v_cohort_id is null then
    raise exception using errcode = '22023', message = 'COHORT_REQUIRED';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_PDV_HANDOFF';
  end if;
  if (select count(*) from public.pdv_handoff_codes where user_id = v_actor_id and created_at > clock_timestamp() - interval '10 minutes') >= 10 then
    raise exception using errcode = 'P0001', message = 'PDV_HANDOFF_RATE_LIMITED';
  end if;
  insert into public.pdv_handoff_codes (code_hash, user_id, expires_at, cohort_id) values (p_code_hash, v_actor_id, v_expires, v_cohort_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values ('auth.pdv_handoff.issued', v_actor_id, 'profile', v_actor_id::text, gen_random_uuid(),
    jsonb_build_object('expires_at', v_expires), v_cohort_id);
  return jsonb_build_object('expires_at', v_expires, 'cohort_id', v_cohort_id);
end;
$$;

create or replace function public.consume_pdv_handoff(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code public.pdv_handoff_codes%rowtype;
  v_profile public.profiles%rowtype;
begin
  perform private.assert_worker_role();
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'PDV_HANDOFF_INVALID';
  end if;
  select * into v_code from public.pdv_handoff_codes where code_hash = p_code_hash for update;
  if not found or v_code.used_at is not null or v_code.expires_at <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'PDV_HANDOFF_INVALID';
  end if;
  update public.pdv_handoff_codes set used_at = clock_timestamp() where code_hash = p_code_hash;
  select * into v_profile from public.profiles where id = v_code.user_id;
  if not v_profile.active or v_profile.onboarding_completed_at is null then
    raise exception using errcode = 'P0001', message = 'PDV_HANDOFF_INVALID';
  end if;
  return jsonb_build_object('user_id', v_profile.id, 'email', v_profile.email, 'cohort_id', v_code.cohort_id);
end;
$$;

-- User administration --------------------------------------------------------------------------------------------------

-- People of the request cohort (ADMIN_MASTER in "all": every cohort, optionally one), filtered and paginated on the
-- server. total = people in scope; matched = people that pass the filters. Nobody outside the scope is listed,
-- counted or found by the search.
create function public.list_cohort_users(
  p_query text default null,
  p_status text default 'ALL',
  p_onboarding text default 'ALL',
  p_roles text[] default null,
  p_role_match text default 'ANY',
  p_cohort_id uuid default null,
  p_offset integer default 0,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_master boolean := private.is_admin_master();
  v_mode text := private.cohort_mode();
  v_scope uuid[];
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
  v_roles text[] := coalesce((select array_agg(distinct role_key) from unnest(coalesce(p_roles, '{}')) role_key), '{}');
  v_total bigint;
  v_matched bigint;
  v_items jsonb;
begin
  if auth.uid() is null or not public.has_permission('users.manage') then
    raise exception using errcode = '42501', message = 'USERS_MANAGE_REQUIRED';
  end if;
  if p_status not in ('ALL', 'ACTIVE', 'INACTIVE') or p_onboarding not in ('ALL', 'COMPLETE', 'INCOMPLETE')
    or p_role_match not in ('ANY', 'ALL') or p_offset is null or p_offset < 0 or p_limit is null or p_limit not between 1 and 100
    or char_length(coalesce(v_query, '')) > 120
    or exists (select 1 from unnest(v_roles) role_key where not exists (select 1 from public.roles role where role.key = role_key)) then
    raise exception using errcode = '22023', message = 'INVALID_USER_FILTER';
  end if;
  if v_mode = 'ALL' and v_master then
    if p_cohort_id is not null and not exists (select 1 from public.cohorts where id = p_cohort_id) then
      raise exception using errcode = '22023', message = 'INVALID_USER_FILTER';
    end if;
    select coalesce(array_agg(id), '{}') into v_scope from public.cohorts where p_cohort_id is null or id = p_cohort_id;
  elsif v_mode = 'COHORT' then
    v_scope := array[private.cohort_permission_id()];
    if p_cohort_id is not null and p_cohort_id <> v_scope[1] then
      raise exception using errcode = '42501', message = 'COHORT_FORBIDDEN';
    end if;
  else
    raise exception using errcode = '22023', message = 'COHORT_REQUIRED';
  end if;
  v_pattern := case when v_query is null then null
    else '%' || replace(replace(replace(lower(v_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  with scoped as (
    select profile.id as user_id, profile.display_name, profile.email, profile.username, profile.active as profile_active,
      bool_or(membership.status = 'ACTIVE') as member_active,
      profile.onboarding_completed_at is not null as onboarding,
      coalesce((select array_agg(distinct role.key order by role.key) from cohort_data.user_roles user_role
        join public.roles role on role.id = user_role.role_id
        where user_role.user_id = profile.id and user_role.cohort_id = any (v_scope)), '{}') as roles
    from public.profiles profile
    join public.user_cohorts membership on membership.user_id = profile.id and membership.cohort_id = any (v_scope)
    group by profile.id
  ),
  filtered as (
    select scoped.*, row_number() over (order by lower(coalesce(scoped.display_name, scoped.email)), scoped.user_id) as position
    from scoped
    where (v_pattern is null or lower(coalesce(scoped.display_name, '')) like v_pattern escape '\'
        or lower(coalesce(scoped.username, '')) like v_pattern escape '\' or lower(scoped.email) like v_pattern escape '\')
      and (p_status = 'ALL' or (p_status = 'ACTIVE') = (scoped.profile_active and scoped.member_active))
      and (p_onboarding = 'ALL' or (p_onboarding = 'COMPLETE') = scoped.onboarding)
      and (cardinality(v_roles) = 0
        or (p_role_match = 'ANY' and scoped.roles && v_roles)
        or (p_role_match = 'ALL' and scoped.roles @> v_roles))
  )
  select (select count(*) from scoped), (select count(*) from filtered),
    coalesce((select jsonb_agg(jsonb_build_object(
        'id', page.user_id, 'email', page.email, 'display_name', page.display_name, 'username', page.username,
        'active', page.profile_active and page.member_active, 'onboarding_completed', page.onboarding,
        'roles', to_jsonb(page.roles),
        'locks', jsonb_build_object(
          'password_recovery', exists (select 1 from public.password_recovery_limits lim where lim.user_id = page.user_id and lim.blocked_at is not null),
          'signup_code', exists (select 1 from public.signup_code_limits lim where lim.user_id = page.user_id and lim.blocked_at is not null)),
        'cohorts', case when v_master then (
          select coalesce(jsonb_agg(jsonb_build_object('id', cohort.id, 'name', cohort.name, 'active', membership.status = 'ACTIVE',
              'roles', coalesce((select jsonb_agg(role.key order by role.key) from cohort_data.user_roles user_role
                join public.roles role on role.id = user_role.role_id
                where user_role.user_id = page.user_id and user_role.cohort_id = cohort.id), '[]'))
            order by cohort.year desc), '[]')
          from public.user_cohorts membership join public.cohorts cohort on cohort.id = membership.cohort_id
          where membership.user_id = page.user_id and membership.cohort_id = any (v_scope)) end,
        'admin_master', case when v_master then exists (select 1 from public.admin_masters master where master.user_id = page.user_id) end
      ) order by page.position)
      from filtered page where page.position > p_offset and page.position <= p_offset + p_limit), '[]')
  into v_total, v_matched, v_items;

  return jsonb_build_object('items', v_items, 'total', v_total, 'matched', v_matched, 'offset', p_offset, 'limit', p_limit,
    'cohort_mode', v_mode, 'cohort_id', case when v_mode = 'COHORT' then v_scope[1] else p_cohort_id end);
end;
$$;
revoke all on function public.list_cohort_users(text, text, text, text[], text, uuid, integer, integer) from public, anon;
grant execute on function public.list_cohort_users(text, text, text, text[], text, uuid, integer, integer) to authenticated;

-- Operations on a person require the person to belong to the request cohort (ADMIN_MASTER: anyone). The existing
-- functions move to private unchanged; the public names check first and delegate.
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array['set_user_access(uuid, text[], boolean, uuid)', 'unlock_password_recovery(uuid, text, uuid)',
    'unlock_signup_code_requests(uuid, text, uuid)', 'set_cohort_membership(uuid, boolean, text, uuid)'] loop
    execute format('alter function public.%s rename to %s', v_signature, split_part(v_signature, '(', 1) || '_in_cohort');
    execute format('alter function public.%s set schema private', split_part(v_signature, '(', 1) || '_in_cohort(' || split_part(v_signature, '(', 2));
    execute format('revoke all on function private.%s from public, anon, authenticated', split_part(v_signature, '(', 1) || '_in_cohort(' || split_part(v_signature, '(', 2));
  end loop;
end;
$$;

create function public.set_user_access(p_user_id uuid, p_roles text[], p_active boolean, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and p_user_id is not null and not private.cohort_member_visible(p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  return private.set_user_access_in_cohort(p_user_id, p_roles, p_active, p_correlation_id);
end;
$$;

create function public.unlock_password_recovery(p_user_id uuid, p_reason text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and p_user_id is not null and not private.cohort_member_visible(p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  return private.unlock_password_recovery_in_cohort(p_user_id, p_reason, p_correlation_id);
end;
$$;

create function public.unlock_signup_code_requests(p_user_id uuid, p_reason text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and p_user_id is not null and not private.cohort_member_visible(p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  return private.unlock_signup_code_requests_in_cohort(p_user_id, p_reason, p_correlation_id);
end;
$$;

-- A cohort admin (users.manage) activates or deactivates existing members; bringing a new person into a cohort
-- belongs to ADMIN_MASTER.
create function public.set_cohort_membership(p_user_id uuid, p_active boolean, p_reason text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and p_user_id is not null and not private.cohort_member_visible(p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  return private.set_cohort_membership_in_cohort(p_user_id, p_active, p_reason, p_correlation_id);
end;
$$;

revoke all on function public.set_user_access(uuid, text[], boolean, uuid), public.unlock_password_recovery(uuid, text, uuid),
  public.unlock_signup_code_requests(uuid, text, uuid), public.set_cohort_membership(uuid, boolean, text, uuid) from public, anon;
grant execute on function public.set_user_access(uuid, text[], boolean, uuid), public.unlock_password_recovery(uuid, text, uuid),
  public.unlock_signup_code_requests(uuid, text, uuid), public.set_cohort_membership(uuid, boolean, text, uuid) to authenticated;

-- Provisioning of an operational account by the Portal (service role, on behalf of a checked actor). The actor must be
-- ADMIN_MASTER or manage users in the target cohort; the new person belongs to the target cohort only. Same identity
-- checks as the original five-argument version, which stays for the promotion window.
create function public.complete_admin_provisioned_profile(p_actor_id uuid, p_user_id uuid, p_display_name text, p_username text, p_cohort_id uuid, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_display_name, ''));
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_default uuid := (select id from public.cohorts where is_default);
  v_profile public.profiles%rowtype;
begin
  perform private.assert_worker_role();
  if p_actor_id is null or p_user_id is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PROVISIONING_REQUEST';
  end if;
  if p_cohort_id is null or not exists (select 1 from public.cohorts where id = p_cohort_id and status <> 'ARCHIVED') then
    raise exception using errcode = '22023', message = 'COHORT_REQUIRED';
  end if;
  if char_length(v_name) not between 2 and 120 or v_username !~ '^[a-z][a-z0-9._]{2,31}$' then
    raise exception using errcode = '22023', message = 'INVALID_PROVISIONING_PROFILE';
  end if;
  if not private.is_admin_master(p_actor_id) and not exists (
    select 1 from public.profiles actor
    join cohort_data.user_roles user_role on user_role.user_id = actor.id and user_role.cohort_id = p_cohort_id
    join public.user_cohorts membership on membership.user_id = actor.id and membership.cohort_id = p_cohort_id and membership.status = 'ACTIVE'
    join public.role_permissions role_permission on role_permission.role_id = user_role.role_id
    join public.permissions permission on permission.id = role_permission.permission_id
    where actor.id = p_actor_id and actor.active and actor.onboarding_completed_at is not null and permission.key = 'users.manage'
  ) then
    raise exception using errcode = '42501', message = 'USERS_MANAGE_REQUIRED';
  end if;
  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = p_user_id and auth_user.email_confirmed_at is not null and nullif(auth_user.encrypted_password, '') is not null
      and lower(auth_user.email) ~ '^[^@[:space:]]+@institutojef[.]org[.]br$'
  ) then
    raise exception using errcode = '42501', message = 'PROVISIONED_IDENTITY_INCOMPLETE';
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PROFILE_NOT_FOUND';
  end if;
  if v_profile.onboarding_completed_at is not null and (v_profile.display_name <> v_name or v_profile.username is distinct from v_username) then
    raise exception using errcode = 'P0001', message = 'ONBOARDING_ALREADY_COMPLETED';
  end if;
  if exists (select 1 from cohort_data.audit_logs where action = 'auth.profile.provisioned' and entity_id = p_user_id::text) then
    -- A retry of the same provisioning answers the same; nothing about the person changes.
    if exists (select 1 from public.user_cohorts where user_id = p_user_id and cohort_id = p_cohort_id and status = 'ACTIVE') then
      return jsonb_build_object('user_id', v_profile.id, 'username', v_profile.username, 'onboarding_completed', true, 'cohort_id', p_cohort_id);
    end if;
    raise exception using errcode = 'P0001', message = 'ONBOARDING_ALREADY_COMPLETED';
  end if;
  -- Only the identity this very provisioning created is placed here: the Portal stamps it (app metadata, writable by the
  -- service role only) with this correlation id, and it never signed in, so it never operated anywhere. An existing
  -- person is never re-provisioned and loses nothing.
  if not exists (select 1 from auth.users auth_user where auth_user.id = p_user_id and auth_user.last_sign_in_at is null
    and auth_user.raw_app_meta_data ->> 'germinatura_provisioning' = p_correlation_id::text) then
    raise exception using errcode = 'P0001', message = 'ONBOARDING_ALREADY_COMPLETED';
  end if;

  -- The sign-up trigger placed the brand-new identity in the default cohort; an account provisioned for another cohort
  -- does not belong there.
  if p_cohort_id is distinct from v_default then
    delete from cohort_data.user_roles where user_id = p_user_id and cohort_id = v_default;
    delete from public.user_cohorts where user_id = p_user_id and cohort_id = v_default;
  end if;
  insert into public.user_cohorts (user_id, cohort_id, status) values (p_user_id, p_cohort_id, 'ACTIVE')
  on conflict (user_id, cohort_id) do update set status = 'ACTIVE';
  insert into cohort_data.user_roles (user_id, role_id, cohort_id)
  select p_user_id, role.id, p_cohort_id from public.roles role where role.key = 'CONSUMIDOR'
  on conflict do nothing;

  update public.profiles
  set display_name = v_name, username = v_username, onboarding_completed_at = coalesce(onboarding_completed_at, statement_timestamp())
  where id = p_user_id
  returning * into v_profile;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values ('auth.profile.provisioned', p_actor_id, 'profile', p_user_id::text, p_correlation_id,
    jsonb_build_object('username', v_username), p_cohort_id);
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload, cohort_id)
  values ('auth.profile.provisioned', 'profile', p_user_id::text,
    jsonb_build_object('user_id', p_user_id, 'username', v_username, 'correlation_id', p_correlation_id), p_cohort_id);
  return jsonb_build_object('user_id', v_profile.id, 'username', v_profile.username, 'onboarding_completed', true, 'cohort_id', p_cohort_id);
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'USERNAME_ALREADY_USED';
end;
$$;
revoke all on function public.complete_admin_provisioned_profile(uuid, uuid, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_admin_provisioned_profile(uuid, uuid, text, text, uuid, uuid) to service_role;
