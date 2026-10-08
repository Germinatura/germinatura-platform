-- Cohort authorization (ADR 0011): request context, explicit ADMIN_MASTER, RBAC per cohort, cohort administration,
-- fan-out per cohort and the write guards attached by 20261020090200_cohort_isolation.
--
-- Request context: the Portal sends `x-germinatura-cohort: <uuid>` or `all`; the database validates it against the
-- caller's active membership (or ADMIN_MASTER). `all` is read/aggregation only. Without a header the request falls
-- back (rollout compatibility only, restricted in PR 5) to the default cohort, or to the single active membership.
-- System callers (migrations, maintenance, the jobs worker through the service role) see every cohort, unless the
-- worker entered the cohort of the event it is processing.

set local lock_timeout = '5s';

insert into public.permissions (key, description)
values ('cohorts.manage', 'Criar, alterar, arquivar e reativar turmas; gerenciar vínculos, ADMIN_MASTER e maquininhas de todas as turmas')
on conflict (key) do nothing;

-- ADMIN_MASTER: explicit, global, one row per person (never a role repeated per cohort).
create table public.admin_masters (
  user_id uuid primary key references public.profiles (id),
  granted_by uuid references public.profiles (id),
  reason text not null constraint admin_masters_reason_check check (char_length(reason) between 4 and 500 and reason = btrim(reason)),
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);
comment on table public.admin_masters is
  'ADMIN_MASTER: acesso a todas as turmas e a todas as permissões, inclusive cohorts.manage. Concedido só por outro ADMIN_MASTER ou pelo bootstrap (ADR 0011).';
alter table public.admin_masters enable row level security;
revoke all on public.admin_masters from anon, authenticated;

-- Bootstrap of the global administration capability: the administrator who completed the institutional bootstrap.
-- Fail-closed: no fallback to another administrator. A database whose bootstrap is still pending grants nothing here;
-- bootstrap_first_admin grants it when the bootstrap happens.
do $$
declare
  v_state public.institutional_bootstrap_state%rowtype;
  v_profile public.profiles%rowtype;
begin
  select * into v_state from public.institutional_bootstrap_state where singleton;
  if not found or v_state.completed_at is null then
    raise notice 'ADMIN_MASTER bootstrap skipped: the institutional bootstrap is still pending';
    return;
  end if;
  if v_state.completed_by is null then
    raise exception 'ADMIN_MASTER_BOOTSTRAP_FAILED: institutional_bootstrap_state.completed_by is empty although the bootstrap is completed';
  end if;
  if not exists (select 1 from auth.users where id = v_state.completed_by) then
    raise exception 'ADMIN_MASTER_BOOTSTRAP_FAILED: the bootstrap administrator % has no auth user', v_state.completed_by;
  end if;
  select * into v_profile from public.profiles where id = v_state.completed_by;
  if not found then
    raise exception 'ADMIN_MASTER_BOOTSTRAP_FAILED: the bootstrap administrator % has no profile', v_state.completed_by;
  end if;
  if not v_profile.active or v_profile.onboarding_completed_at is null then
    raise exception 'ADMIN_MASTER_BOOTSTRAP_FAILED: the bootstrap administrator % is inactive or has not completed onboarding', v_state.completed_by;
  end if;
  insert into public.admin_masters (user_id, granted_by, reason, correlation_id)
  values (v_profile.id, null, 'Bootstrap da capacidade global de administração (ADR 0011)', gen_random_uuid())
  on conflict (user_id) do nothing;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values ('auth.admin_master.bootstrapped', v_profile.id, 'admin_master', v_profile.id::text, gen_random_uuid(),
    jsonb_build_object('source', 'institutional_bootstrap_state.completed_by', 'cohort_scope', 'GLOBAL'), null);
end;
$$;

-- Request context ----------------------------------------------------------------------------------------------------

-- 'user' (authenticated), 'anon', 'service' (service role: the jobs worker) or 'system' (no request: migrations,
-- maintenance, tests as postgres).
create function private.cohort_caller() returns text
language sql stable set search_path = '' as $$
  -- A service-role token never carries a user, so its role wins over a leftover subject.
  select case
    when coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt() ->> 'role') = 'service_role' then 'service'
    when auth.uid() is not null then 'user'
    when coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt() ->> 'role') = 'anon' then 'anon'
    else 'system'
  end
$$;

create function private.cohort_header() returns text
language sql stable set search_path = '' as $$
  select nullif(btrim(nullif(current_setting('request.headers', true), '')::json ->> 'x-germinatura-cohort'), '')
$$;

-- The cohort a system/service caller has entered (jobs worker per event, cohort provisioning). Never set by a user.
create function private.cohort_system_context() returns uuid
language sql stable set search_path = '' as $$
  select nullif(current_setting('germinatura.system_cohort', true), '')::uuid
$$;

create function private.enter_cohort_context(p_cohort_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if private.cohort_caller() not in ('system', 'service') then
    raise exception using errcode = '42501', message = 'COHORT_CONTEXT_SYSTEM_ONLY';
  end if;
  perform set_config('germinatura.system_cohort', coalesce(p_cohort_id::text, ''), true);
end;
$$;

-- Rollout compatibility (ADR 0011): requests without a cohort header fall back to the default cohort. PR 5 restricts
-- this to callers with exactly one accessible cohort.
create function private.cohort_fallback_enabled() returns boolean
language sql immutable set search_path = '' as $$ select true $$;

create function private.is_admin_master(p_user_id uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and exists (
    select 1 from public.admin_masters master
    join public.profiles profile on profile.id = master.user_id
    where master.user_id = p_user_id and profile.active and profile.onboarding_completed_at is not null)
$$;

-- Security boundary (RLS and Realtime): may the caller read rows of this cohort at all?
create function private.cohort_readable(p_cohort_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.cohort_caller()
    when 'system' then true
    when 'service' then true
    when 'anon' then exists (select 1 from public.cohorts where id = p_cohort_id and is_default)
    else private.is_admin_master() or exists (
      select 1 from public.user_cohorts membership
      where membership.user_id = auth.uid() and membership.cohort_id = p_cohort_id and membership.status = 'ACTIVE')
  end
$$;

-- Global rows of the logs (cohort_id NULL) are visible to ADMIN_MASTER and system callers only.
create function private.cohort_sees_global() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.cohort_caller() in ('system', 'service') or private.is_admin_master()
$$;

-- The cohorts this request reads (cached per transaction and per caller/header/context).
create function private.cohort_scope() returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
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
$$;

-- 'ALL' (header all), 'COHORT' (exactly one cohort) or 'NONE'.
create function private.cohort_mode() returns text
language sql stable security definer set search_path = '' as $$
  select case
    when private.cohort_caller() in ('user', 'anon') and private.cohort_header() = 'all' and cardinality(private.cohort_scope()) > 0 then 'ALL'
    when cardinality(private.cohort_scope()) = 1 then 'COHORT'
    when private.cohort_caller() in ('system', 'service') and cardinality(private.cohort_scope()) > 1 then 'ALL'
    else 'NONE'
  end
$$;

-- The single cohort a permission is evaluated in; NULL in "all" or without a determinable cohort.
create function private.cohort_permission_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select case when private.cohort_header() is distinct from 'all' and cardinality(private.cohort_scope()) = 1
    then (private.cohort_scope())[1] end
$$;

-- The concrete cohort a user/anon write goes to. "all" never writes; neither does an undeterminable context.
-- System/service callers return their entered cohort or NULL (the guard then derives from the parent row).
create function private.cohort_write_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.cohort_caller() in ('system', 'service') then
    return private.cohort_system_context();
  end if;
  if private.cohort_header() = 'all' or cardinality(private.cohort_scope()) <> 1 then
    raise exception using errcode = '22023', message = 'COHORT_REQUIRED';
  end if;
  return (private.cohort_scope())[1];
end;
$$;

-- Cohort-scoped writes of a definer function on behalf of another cohort (provisioning a new cohort). Transaction-local
-- and only reachable from definer functions; cleared by passing NULL.
create function private.cohort_write_override(p_cohort_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform set_config('germinatura.cohort_override', coalesce(p_cohort_id::text, ''), true);
end;
$$;

revoke all on function private.cohort_caller(), private.cohort_header(), private.cohort_system_context(),
  private.enter_cohort_context(uuid), private.cohort_fallback_enabled(), private.cohort_write_override(uuid),
  private.cohort_mode(), private.cohort_permission_id(), private.cohort_write_id() from public, anon, authenticated;
revoke all on function private.is_admin_master(uuid) from public, anon;
-- RLS policies and Realtime evaluate these as the querying role.
grant execute on function private.cohort_readable(uuid), private.cohort_scope(), private.cohort_sees_global(),
  private.is_admin_master(uuid) to anon, authenticated;

-- RBAC per cohort -----------------------------------------------------------------------------------------------------

-- Permission = ADMIN_MASTER, or a role granted in the request cohort together with an active membership there.
create or replace function public.has_permission(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin_master() or exists (
    select 1
    from public.profiles profile
    join public.user_roles user_role on user_role.user_id = profile.id
    join public.user_cohorts membership on membership.user_id = profile.id and membership.cohort_id = user_role.cohort_id
      and membership.status = 'ACTIVE'
    join public.role_permissions role_permission on role_permission.role_id = user_role.role_id
    join public.permissions permission on permission.id = role_permission.permission_id
    where profile.id = auth.uid()
      and profile.active
      and profile.onboarding_completed_at is not null
      and user_role.cohort_id = private.cohort_permission_id()
      and permission.key = required_permission
  );
$$;

-- Session: roles of the request cohort, plus the cohort context. A person without any active membership (and not
-- ADMIN_MASTER) is reported inactive, as a deactivated person was before the cohorts.
create or replace function public.get_my_session()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_master boolean := private.is_admin_master();
  v_cohort_id uuid := private.cohort_permission_id();
  v_session jsonb;
begin
  select jsonb_build_object(
    'auth_id', auth_user.id,
    'email', auth_user.email,
    'display_name', profile.display_name,
    'username', profile.username,
    'avatar_path', profile.avatar_path,
    'active', profile.active and (v_master or exists (
      select 1 from public.user_cohorts membership where membership.user_id = profile.id and membership.status = 'ACTIVE')),
    'onboarding_completed', profile.onboarding_completed_at is not null,
    'roles', coalesce((select jsonb_agg(role.key order by role.key) from public.user_roles user_role
      join public.roles role on role.id = user_role.role_id
      where user_role.user_id = profile.id and user_role.cohort_id = v_cohort_id), '[]'::jsonb),
    'admin_master', v_master,
    'cohort_mode', private.cohort_mode(),
    'cohort', (select jsonb_build_object('id', cohort.id, 'name', cohort.name, 'year', cohort.year, 'slug', cohort.slug, 'status', cohort.status)
      from public.cohorts cohort where cohort.id = v_cohort_id),
    'cohorts', coalesce((select jsonb_agg(jsonb_build_object('id', cohort.id, 'name', cohort.name, 'year', cohort.year,
        'slug', cohort.slug, 'status', cohort.status, 'is_default', cohort.is_default) order by cohort.year desc)
      from public.cohorts cohort
      where v_master or exists (select 1 from public.user_cohorts membership
        where membership.user_id = profile.id and membership.cohort_id = cohort.id and membership.status = 'ACTIVE')), '[]'::jsonb)
  )
  into v_session
  from auth.users auth_user
  join public.profiles profile on profile.id = auth_user.id
  where auth_user.id = v_user_id
    and (
      coalesce(auth.jwt() ->> 'session_id', '') in ('', '00000000-0000-0000-0000-000000000000')
      or exists (
        select 1 from auth.sessions session
        where session.id = (auth.jwt() ->> 'session_id')::uuid and session.user_id = auth_user.id
      )
    );
  return v_session;
end;
$$;

-- Staff recipients of a notification: roles in the cohort being processed, with an active membership there.
create or replace function private.staff_with_permission(p_permission text)
returns table (recipient_id uuid)
language sql
stable
set search_path = ''
as $$
  select distinct profile.id
  from public.profiles profile
  join public.user_roles user_role on user_role.user_id = profile.id
  join public.user_cohorts membership on membership.user_id = profile.id and membership.cohort_id = user_role.cohort_id
    and membership.status = 'ACTIVE'
  join public.role_permissions role_permission on role_permission.role_id = user_role.role_id
  join public.permissions permission on permission.id = role_permission.permission_id
  where profile.active and profile.onboarding_completed_at is not null and permission.key = p_permission
    and user_role.cohort_id = any (private.cohort_scope());
$$;

-- Roles and access of a person in the request cohort. Membership replaces the global deactivation: deactivating
-- in a cohort removes access to that cohort only; without any active membership the session is inactive.
create or replace function public.set_user_access(p_user_id uuid, p_roles text[], p_active boolean, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_cohort_id uuid;
  v_requested_roles text[];
  v_previous_roles text[];
  v_previous_active boolean;
  v_invalid_role text;
  v_removing_admin boolean;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;
  if not public.has_permission('users.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_user_id is null or p_active is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_USER_ACCESS_INPUT';
  end if;
  v_cohort_id := private.cohort_write_id();

  perform 1 from public.profiles where id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  select coalesce((select status = 'ACTIVE' from public.user_cohorts where user_id = p_user_id and cohort_id = v_cohort_id), false)
  into v_previous_active;

  select coalesce(array_agg(role.key order by role.key), '{}'::text[])
  into v_previous_roles
  from public.user_roles user_role
  join public.roles role on role.id = user_role.role_id
  where user_role.user_id = p_user_id and user_role.cohort_id = v_cohort_id;

  select array_agg(distinct requested_role order by requested_role)
  into v_requested_roles
  from unnest(coalesce(p_roles, '{}'::text[]) || array['CONSUMIDOR']) requested_role;

  select requested_role into v_invalid_role
  from unnest(v_requested_roles) requested_role
  where not exists (select 1 from public.roles role where role.key = requested_role)
  limit 1;
  if v_invalid_role is not null then
    raise exception using errcode = '22023', message = 'INVALID_ROLE';
  end if;

  v_removing_admin := 'ADMIN' = any(v_previous_roles)
    and (not ('ADMIN' = any(v_requested_roles)) or not p_active);
  if v_removing_admin and not exists (
    select 1
    from public.profiles profile
    join public.user_roles user_role on user_role.user_id = profile.id and user_role.cohort_id = v_cohort_id
    join public.roles role on role.id = user_role.role_id and role.key = 'ADMIN'
    join public.user_cohorts membership on membership.user_id = profile.id and membership.cohort_id = v_cohort_id
      and membership.status = 'ACTIVE'
    where profile.active and profile.id <> p_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'LAST_ACTIVE_ADMIN_REQUIRED';
  end if;

  delete from public.user_roles where user_id = p_user_id and cohort_id = v_cohort_id;
  insert into public.user_roles (user_id, role_id, cohort_id)
  select p_user_id, role.id, v_cohort_id from public.roles role where role.key = any(v_requested_roles);
  insert into public.user_cohorts (user_id, cohort_id, status)
  values (p_user_id, v_cohort_id, case when p_active then 'ACTIVE' else 'INACTIVE' end::public.cohort_membership_status)
  on conflict (user_id, cohort_id) do update set status = excluded.status;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values (
    'auth.user.access.changed', v_actor_id, 'profile', p_user_id::text, p_correlation_id,
    jsonb_build_object(
      'previous_roles', to_jsonb(v_previous_roles),
      'roles', to_jsonb(v_requested_roles),
      'previous_active', v_previous_active,
      'active', p_active
    ),
    v_cohort_id
  );

  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload, cohort_id)
  values (
    'auth.roles.changed', 'profile', p_user_id::text,
    jsonb_build_object('user_id', p_user_id, 'roles', to_jsonb(v_requested_roles), 'active', p_active, 'cohort_id', v_cohort_id),
    v_cohort_id
  );

  return jsonb_build_object('user_id', p_user_id, 'roles', to_jsonb(v_requested_roles), 'active', p_active, 'cohort_id', v_cohort_id);
end;
$$;

-- The institutional bootstrap also bootstraps the global administration capability.
create or replace function public.bootstrap_first_admin(p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_email text;
  v_email_confirmed_at timestamptz;
  v_state public.institutional_bootstrap_state%rowtype;
  v_admin_role_id uuid;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'CORRELATION_ID_REQUIRED';
  end if;

  select lower(btrim(email)), email_confirmed_at
  into v_email, v_email_confirmed_at
  from auth.users
  where id = v_actor_id;

  if v_email <> 'theo.martins@institutojef.org.br' or v_email_confirmed_at is null then
    raise exception using errcode = '42501', message = 'BOOTSTRAP_NOT_ELIGIBLE';
  end if;

  select * into v_state
  from public.institutional_bootstrap_state
  where singleton
  for update;

  if v_state.completed_at is not null then
    if v_state.completed_by = v_actor_id then
      return jsonb_build_object('status', 'ALREADY_COMPLETED', 'user_id', v_actor_id);
    end if;
    raise exception using errcode = '42501', message = 'BOOTSTRAP_CLOSED';
  end if;

  select id into strict v_admin_role_id from public.roles where key = 'ADMIN';
  insert into public.user_roles (user_id, role_id)
  values (v_actor_id, v_admin_role_id)
  on conflict do nothing;
  insert into public.admin_masters (user_id, granted_by, reason, correlation_id)
  values (v_actor_id, null, 'Bootstrap da capacidade global de administração (ADR 0011)', p_correlation_id)
  on conflict (user_id) do nothing;

  update public.institutional_bootstrap_state
  set completed_by = v_actor_id, completed_at = statement_timestamp(), correlation_id = p_correlation_id
  where singleton;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    'auth.admin.bootstrap.completed', v_actor_id, 'profile', v_actor_id::text,
    p_correlation_id, jsonb_build_object('email', v_email, 'admin_master', true)
  );

  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'auth.roles.changed', 'profile', v_actor_id::text,
    jsonb_build_object('user_id', v_actor_id, 'roles_added', jsonb_build_array('ADMIN'))
  );

  return jsonb_build_object('status', 'COMPLETED', 'user_id', v_actor_id);
end;
$$;

-- Announcements reach the active members of the request cohort only.
create or replace function public.publish_announcement(p_title text, p_body text, p_all boolean, p_roles text[], p_emails text[], p_idempotency_key text, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid(); v_claim record; v_id uuid := gen_random_uuid(); v_result jsonb;
  v_title text := btrim(p_title); v_body text := btrim(p_body);
  v_roles text[] := coalesce((select array_agg(distinct role_key order by role_key) from unnest(coalesce(p_roles, '{}')) role_key), '{}');
  v_emails text[] := coalesce((select array_agg(distinct lower(btrim(email)) order by lower(btrim(email)))
    from unnest(coalesce(p_emails, '{}')) email where btrim(email) <> ''), '{}');
  v_unknown text[];
  v_recipients uuid[];
  v_count integer;
  v_cohort_id uuid;
begin
  if v_actor_id is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_all is null or v_title is null or char_length(v_title) not between 3 and 160
    or v_body is null or char_length(v_body) not between 3 and 1000
    or (not p_all and cardinality(v_roles) = 0 and cardinality(v_emails) = 0)
    or cardinality(v_emails) > 200
    or exists (select 1 from unnest(v_roles) role_key where not exists (select 1 from public.roles role where role.key = role_key)) then
    raise exception using errcode = '22023', message = 'INVALID_ANNOUNCEMENT';
  end if;
  v_cohort_id := private.cohort_write_id();
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('communications', 'announcement', v_actor_id), p_idempotency_key,
    jsonb_build_object('title', v_title, 'body', v_body, 'all', p_all, 'roles', v_roles, 'emails', v_emails));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  select array_agg(requested.address order by requested.address) into v_unknown from unnest(v_emails) as requested(address)
  where not exists (select 1 from public.profiles profile
    join public.user_cohorts membership on membership.user_id = profile.id and membership.cohort_id = v_cohort_id
      and membership.status = 'ACTIVE'
    where lower(profile.email) = requested.address and profile.active);
  if v_unknown is not null then
    raise exception using errcode = 'P0001', message = 'ANNOUNCEMENT_UNKNOWN_RECIPIENTS', detail = array_to_string(v_unknown, ', ');
  end if;

  select array_agg(distinct profile.id) into v_recipients from public.profiles profile
  join public.user_cohorts membership on membership.user_id = profile.id and membership.cohort_id = v_cohort_id
    and membership.status = 'ACTIVE'
  where profile.active and profile.onboarding_completed_at is not null and (
    p_all
    or lower(profile.email) = any (v_emails)
    or exists (select 1 from public.user_roles user_role join public.roles role on role.id = user_role.role_id
      where user_role.user_id = profile.id and user_role.cohort_id = v_cohort_id and role.key = any (v_roles)));
  v_count := coalesce(cardinality(v_recipients), 0);
  if v_count = 0 then
    raise exception using errcode = 'P0001', message = 'ANNOUNCEMENT_EMPTY_AUDIENCE';
  end if;
  insert into public.announcements (id, title, body, audience_all, audience_roles, audience_emails, recipient_count, created_by, correlation_id, created_at)
  values (v_id, v_title, v_body, p_all, v_roles, v_emails, v_count, v_actor_id, p_correlation_id, clock_timestamp());
  insert into public.announcement_recipients (announcement_id, recipient_id)
  select v_id, recipient_id from unnest(v_recipients) recipient_id;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('communications.announcement.published', v_actor_id, 'announcement', v_id::text, p_correlation_id,
    jsonb_build_object('all', p_all, 'roles', v_roles, 'emails', v_emails, 'recipient_count', v_count));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('communications.announcement.published', 'announcement', v_id::text,
    jsonb_build_object('announcement_id', v_id, 'recipient_count', v_count, 'correlation_id', p_correlation_id));
  v_result := jsonb_build_object('id', v_id, 'title', v_title, 'recipient_count', v_count, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'announcement', v_id::text);
  return v_result;
end;
$$;

-- The jobs worker processes each outbox event inside the event's cohort, so every fan-out reaches that cohort only.
alter function public.worker_process_outbox_event(uuid, text) rename to worker_process_outbox_event_in_cohort;
alter function public.worker_process_outbox_event_in_cohort(uuid, text) set schema private;
revoke all on function private.worker_process_outbox_event_in_cohort(uuid, text) from public, anon, authenticated, service_role;

create function public.worker_process_outbox_event(p_event_id uuid, p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_worker_role();
  perform private.enter_cohort_context((select cohort_id from public.outbox_events where id = p_event_id));
  return private.worker_process_outbox_event_in_cohort(p_event_id, p_worker_id);
end;
$$;
revoke all on function public.worker_process_outbox_event(uuid, text) from public, anon, authenticated;
grant execute on function public.worker_process_outbox_event(uuid, text) to service_role;

-- Cohort administration (ADMIN_MASTER) ----------------------------------------------------------------------------

-- Provisioning of a new cohort: the operational rows every cohort needs (central stock, settings, module flags), the
-- latter copied from the default cohort so the new one starts with the same behavior. Writes go to the base tables
-- (the new cohort is outside the request scope) under the write override, still through the guards.
create function private.provision_cohort(p_cohort_id uuid, p_actor_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_default uuid := (select id from public.cohorts where is_default);
begin
  perform private.cohort_write_override(p_cohort_id);
  insert into cohort_data.stock_locations (location_type, name, cohort_id)
  select 'CENTRAL', 'Estoque central', p_cohort_id
  where not exists (select 1 from cohort_data.stock_locations where cohort_id = p_cohort_id and location_type = 'CENTRAL' and active);
  insert into cohort_data.reservation_settings (singleton, hold_hours, pickup_hours, updated_by, cohort_id)
  select true, settings.hold_hours, settings.pickup_hours, p_actor_id, p_cohort_id
  from cohort_data.reservation_settings settings where settings.cohort_id = v_default
    and not exists (select 1 from cohort_data.reservation_settings where cohort_id = p_cohort_id);
  insert into cohort_data.stock_loss_settings (singleton, approval_threshold_quantity, updated_by, cohort_id)
  select true, settings.approval_threshold_quantity, p_actor_id, p_cohort_id
  from cohort_data.stock_loss_settings settings where settings.cohort_id = v_default
    and not exists (select 1 from cohort_data.stock_loss_settings where cohort_id = p_cohort_id);
  insert into cohort_data.cohort_feature_flags (cohort_id, key, enabled, updated_by)
  select p_cohort_id, flag.key, flag.enabled, p_actor_id
  from cohort_data.cohort_feature_flags flag where flag.cohort_id = v_default
  on conflict (cohort_id, key) do nothing;
  perform private.cohort_write_override(null);
end;
$$;
revoke all on function private.provision_cohort(uuid, uuid) from public, anon, authenticated;

create function public.create_cohort(p_name text, p_year integer, p_slug text, p_status public.cohort_status, p_idempotency_key text, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_cohort public.cohorts%rowtype;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('cohorts.manage') then
    raise exception using errcode = '42501', message = 'COHORTS_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_name is null or p_year is null or p_slug is null or p_status is null
    or p_status = 'ARCHIVED' then
    raise exception using errcode = '22023', message = 'INVALID_COHORT';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('cohorts', 'create', v_actor_id), p_idempotency_key,
    jsonb_build_object('name', btrim(p_name), 'year', p_year, 'slug', lower(btrim(p_slug)), 'status', p_status));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  begin
    insert into public.cohorts (name, year, slug, status)
    values (btrim(p_name), p_year, lower(btrim(p_slug)), p_status)
    returning * into v_cohort;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'COHORT_ALREADY_EXISTS';
    when check_violation then
      raise exception using errcode = '22023', message = 'INVALID_COHORT';
  end;
  perform private.provision_cohort(v_cohort.id, v_actor_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values ('cohorts.created', v_actor_id, 'cohort', v_cohort.id::text, p_correlation_id,
    jsonb_build_object('name', v_cohort.name, 'year', v_cohort.year, 'slug', v_cohort.slug, 'status', v_cohort.status, 'cohort_scope', 'GLOBAL'), null);
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload, cohort_id)
  values ('cohorts.created', 'cohort', v_cohort.id::text,
    jsonb_build_object('cohort_id', v_cohort.id, 'correlation_id', p_correlation_id, 'cohort_scope', 'GLOBAL'), null);
  v_result := jsonb_build_object('id', v_cohort.id, 'name', v_cohort.name, 'year', v_cohort.year, 'slug', v_cohort.slug,
    'status', v_cohort.status, 'is_default', v_cohort.is_default, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'cohort', v_cohort.id::text);
  return v_result;
end;
$$;

-- Rename and change status (PREPARING ↔ ACTIVE ↔ ARCHIVED). An archived cohort stays readable; the default cohort is
-- never archived.
create function public.update_cohort(p_cohort_id uuid, p_name text, p_status public.cohort_status, p_reason text, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_before public.cohorts%rowtype;
  v_after public.cohorts%rowtype;
begin
  if v_actor_id is null or not public.has_permission('cohorts.manage') then
    raise exception using errcode = '42501', message = 'COHORTS_MANAGE_REQUIRED';
  end if;
  if p_cohort_id is null or p_name is null or p_status is null or p_correlation_id is null or p_reason is null
    or char_length(btrim(p_reason)) not between 4 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_COHORT';
  end if;
  select * into v_before from public.cohorts where id = p_cohort_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'COHORT_NOT_FOUND';
  end if;
  if v_before.is_default and p_status = 'ARCHIVED' then
    raise exception using errcode = 'P0001', message = 'DEFAULT_COHORT_CANNOT_BE_ARCHIVED';
  end if;
  begin
    update public.cohorts set name = btrim(p_name), status = p_status where id = p_cohort_id returning * into v_after;
  exception
    when check_violation then
      raise exception using errcode = '22023', message = 'INVALID_COHORT';
  end;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values ('cohorts.updated', v_actor_id, 'cohort', p_cohort_id::text, p_correlation_id,
    jsonb_build_object('reason', btrim(p_reason), 'before', jsonb_build_object('name', v_before.name, 'status', v_before.status),
      'after', jsonb_build_object('name', v_after.name, 'status', v_after.status), 'cohort_scope', 'GLOBAL'), null);
  return jsonb_build_object('id', v_after.id, 'name', v_after.name, 'year', v_after.year, 'slug', v_after.slug,
    'status', v_after.status, 'is_default', v_after.is_default, 'correlation_id', p_correlation_id);
end;
$$;

-- Membership in the request cohort (ADMIN_MASTER, or users.manage there). Activating also grants the base role.
create function public.set_cohort_membership(p_user_id uuid, p_active boolean, p_reason text, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_cohort_id uuid;
begin
  if v_actor_id is null or not public.has_permission('users.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_user_id is null or p_active is null or p_correlation_id is null or p_reason is null
    or char_length(btrim(p_reason)) not between 4 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_MEMBERSHIP';
  end if;
  v_cohort_id := private.cohort_write_id();
  if exists (select 1 from public.cohorts where id = v_cohort_id and status = 'ARCHIVED') then
    raise exception using errcode = '42501', message = 'COHORT_ARCHIVED';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  insert into public.user_cohorts (user_id, cohort_id, status)
  values (p_user_id, v_cohort_id, case when p_active then 'ACTIVE' else 'INACTIVE' end::public.cohort_membership_status)
  on conflict (user_id, cohort_id) do update set status = excluded.status;
  if p_active then
    insert into public.user_roles (user_id, role_id, cohort_id)
    select p_user_id, role.id, v_cohort_id from public.roles role where role.key = 'CONSUMIDOR'
    on conflict do nothing;
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values ('cohorts.membership.changed', v_actor_id, 'profile', p_user_id::text, p_correlation_id,
    jsonb_build_object('active', p_active, 'reason', btrim(p_reason)), v_cohort_id);
  return jsonb_build_object('user_id', p_user_id, 'cohort_id', v_cohort_id, 'active', p_active, 'correlation_id', p_correlation_id);
end;
$$;

-- ADMIN_MASTER is granted and revoked only by another ADMIN_MASTER; the last active one cannot be revoked.
create function public.set_admin_master(p_user_id uuid, p_granted boolean, p_reason text, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null or not private.is_admin_master(v_actor_id) then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  if p_user_id is null or p_granted is null or p_correlation_id is null or p_reason is null
    or char_length(btrim(p_reason)) not between 4 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_ADMIN_MASTER_CHANGE';
  end if;
  perform 1 from public.admin_masters for update;
  if p_granted then
    if not exists (select 1 from public.profiles where id = p_user_id and active and onboarding_completed_at is not null) then
      raise exception using errcode = 'P0001', message = 'ADMIN_MASTER_REQUIRES_ACTIVE_IDENTITY';
    end if;
    insert into public.admin_masters (user_id, granted_by, reason, correlation_id)
    values (p_user_id, v_actor_id, btrim(p_reason), p_correlation_id)
    on conflict (user_id) do nothing;
  else
    if not exists (select 1 from public.admin_masters master join public.profiles profile on profile.id = master.user_id
      where profile.active and master.user_id <> p_user_id) then
      raise exception using errcode = 'P0001', message = 'LAST_ADMIN_MASTER_REQUIRED';
    end if;
    delete from public.admin_masters where user_id = p_user_id;
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values (case when p_granted then 'auth.admin_master.granted' else 'auth.admin_master.revoked' end, v_actor_id,
    'admin_master', p_user_id::text, p_correlation_id, jsonb_build_object('reason', btrim(p_reason), 'cohort_scope', 'GLOBAL'), null);
  return jsonb_build_object('user_id', p_user_id, 'admin_master', p_granted, 'correlation_id', p_correlation_id);
end;
$$;

revoke all on function public.create_cohort(text, integer, text, public.cohort_status, text, uuid),
  public.update_cohort(uuid, text, public.cohort_status, text, uuid), public.set_cohort_membership(uuid, boolean, text, uuid),
  public.set_admin_master(uuid, boolean, text, uuid) from public, anon;
grant execute on function public.create_cohort(text, integer, text, public.cohort_status, text, uuid),
  public.update_cohort(uuid, text, public.cohort_status, text, uuid), public.set_cohort_membership(uuid, boolean, text, uuid),
  public.set_admin_master(uuid, boolean, text, uuid) to authenticated;

-- Write guards (attached to the cohort tables by 20261020090200) --------------------------------------------------

-- Audit and outbox: which entity/aggregate types are global, and which cohort table the others derive from.
create table private.cohort_entity_types (
  entity_type text primary key,
  table_name text,
  constraint cohort_entity_types_global_or_table check (table_name is null or table_name ~ '^[a-z_]+$')
);
comment on table private.cohort_entity_types is
  'Tipos de entidade da auditoria/outbox: table_name NULL = global; senão, a turma vem da linha dessa tabela.';
insert into private.cohort_entity_types (entity_type, table_name) values
  ('profile', null), ('cohort', null), ('admin_master', null), ('payment_terminal', null),
  ('picpay_import', null), ('picpay_statement_import', null), ('picpay_statement_line', null), ('picpay_transaction', null),
  ('picpay_reconciliation', null), ('picpay_reconciliation_period', null), ('picpay_exception', null),
  ('payment_webhook_receipt', null),
  ('announcement', 'announcements'), ('category', 'categories'), ('commercial_reservation', 'commercial_reservations'),
  ('finance_balance_check', 'finance_balance_checks'), ('finance_manual_entry', 'finance_manual_entries'),
  ('finance_opening_position', 'finance_opening_positions'), ('inventory_count', 'inventory_counts'),
  ('payment_attempt', 'payment_attempts'), ('payment_link_charge', 'payment_link_charges'),
  ('payment_link_refund_request', 'payment_link_refund_requests'), ('payment_reconciliation', 'payment_reconciliations'),
  ('payment_recovery_item', 'payment_recovery_items'), ('portal_event', 'portal_events'), ('portal_highlight', 'portal_highlights'),
  ('product', 'products'), ('product_image', 'product_images'), ('product_price', 'product_prices'), ('promotion', 'promotions'),
  ('purchase_order', 'purchase_orders'), ('purchase_payable', 'purchase_payable_entries'),
  ('purchase_payable_settlement', 'purchase_payable_settlements'), ('purchase_receipt', 'purchase_receipts'),
  ('raffle_campaign', 'raffle_campaigns'), ('sale', 'sales'), ('seller_closeout', 'seller_closeouts'),
  ('seller_shift', 'seller_shifts'), ('seller_stock_transfer_request', 'seller_stock_transfer_requests'),
  ('share_campaign', 'share_campaigns'), ('stock_loss_report', 'stock_loss_reports'), ('stock_movement', 'stock_movements'),
  ('stock_reservation', 'stock_reservations'), ('stock_return_request', 'stock_return_requests'), ('supplier', 'suppliers'),
  ('fundraising_goal', 'fundraising_goal'), ('reservation_settings', 'reservation_settings'),
  ('stock_loss_settings', 'stock_loss_settings'), ('feature_flag', null)
on conflict (entity_type) do nothing;
alter table private.cohort_entity_types enable row level security;
revoke all on private.cohort_entity_types from public, anon, authenticated;

-- Required/attribution tables: fill cohort_id from the parent rows (TG_ARGV: child column, parent table, parent
-- column, parent column type, repeated), refuse a parent of another cohort, keep the cohort immutable, and for user
-- requests: no writes in "all", only into the request cohort, never into an archived cohort. TG_ARGV[0] is the mode.
create function private.guard_cohort_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Audit and outbox: an explicit cohort is kept; a global entity type (or cohort_scope GLOBAL) stays NULL; otherwise
-- the cohort of the entity/aggregate row, else the request cohort (user) or the entered cohort (worker).
create function private.assign_log_cohort()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Evidence attributed to one cohort is never attributed to another while that attribution stands.
create function private.guard_picpay_attribution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current uuid;
begin
  if new.cohort_id is null then
    return new;
  end if;
  if tg_table_name = 'picpay_transaction_links' then
    select link.cohort_id into v_current from cohort_data.picpay_transaction_links link
    where link.transaction_id = new.transaction_id order by link.sequence desc limit 1;
  else
    select resolution.cohort_id into v_current from cohort_data.picpay_statement_line_resolutions resolution
    where resolution.line_id = new.line_id order by resolution.sequence desc limit 1;
  end if;
  if v_current is not null and v_current <> new.cohort_id then
    raise exception using errcode = '42501', message = 'PICPAY_EVIDENCE_ATTRIBUTED_TO_ANOTHER_COHORT';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_cohort_write(), private.assign_log_cohort(), private.guard_picpay_attribution()
  from public, anon, authenticated;
