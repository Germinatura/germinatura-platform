alter table public.profiles
  add column active boolean not null default true;

create index profiles_active_idx on public.profiles (active, id);

create table public.institutional_auth_rate_limits (
  scope text not null,
  subject_hash text not null,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (scope, subject_hash),
  constraint institutional_auth_rate_limits_scope_valid check (scope in ('OTP_REQUEST', 'OTP_VERIFY')),
  constraint institutional_auth_rate_limits_hash_valid check (subject_hash ~ '^[0-9a-f]{64}$'),
  constraint institutional_auth_rate_limits_attempts_valid check (attempts > 0)
);

create table public.institutional_bootstrap_state (
  singleton boolean primary key default true check (singleton),
  completed_by uuid references public.profiles(id) on delete restrict,
  completed_at timestamptz,
  correlation_id uuid,
  constraint institutional_bootstrap_state_completion_valid check (
    (completed_by is null and completed_at is null and correlation_id is null)
    or (completed_by is not null and completed_at is not null and correlation_id is not null)
  )
);

insert into public.institutional_bootstrap_state (singleton) values (true);

create trigger institutional_auth_rate_limits_set_updated_at
before update on public.institutional_auth_rate_limits
for each row execute function private.set_updated_at();

create or replace function private.is_institutional_email(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(coalesce(p_email, ''))) ~ '^[^@[:space:]]+@institutojef[.]org[.]br$';
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if not private.is_institutional_email(new.email) then
    raise exception using errcode = 'P0001', message = 'INSTITUTIONAL_EMAIL_REQUIRED';
  end if;

  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(btrim(new.email)),
    coalesce(new.raw_user_meta_data ->> 'name', split_part(lower(btrim(new.email)), '@', 1))
  );

  insert into public.user_roles (user_id, role_id)
  select new.id, id from public.roles where key = 'CONSUMIDOR';
  return new;
end;
$$;

create or replace function public.has_permission(required_permission text)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    join public.user_roles ur on ur.user_id = profile.id
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions permission on permission.id = rp.permission_id
    where profile.id = auth.uid()
      and profile.active
      and permission.key = required_permission
  );
$$;

create or replace function public.get_my_session()
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  select jsonb_build_object(
    'auth_id', auth_user.id,
    'email', auth_user.email,
    'display_name', profile.display_name,
    'active', profile.active,
    'roles', coalesce(jsonb_agg(role.key order by role.key) filter (where role.key is not null), '[]'::jsonb)
  )
  from auth.users auth_user
  join public.profiles profile on profile.id = auth_user.id
  left join public.user_roles user_role on user_role.user_id = profile.id
  left join public.roles role on role.id = user_role.role_id
  where auth_user.id = auth.uid()
  group by auth_user.id, auth_user.email, profile.display_name, profile.active;
$$;

create or replace function public.consume_institutional_auth_rate_limit(
  p_scope text,
  p_subject_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_window interval := interval '15 minutes';
  v_attempts integer;
begin
  if p_scope = 'OTP_REQUEST' then
    v_limit := 5;
  elsif p_scope = 'OTP_VERIFY' then
    v_limit := 10;
  else
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_SCOPE';
  end if;

  if p_subject_hash is null or p_subject_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_SUBJECT';
  end if;

  insert into public.institutional_auth_rate_limits (
    scope, subject_hash, window_started_at, attempts
  ) values (
    p_scope, p_subject_hash, statement_timestamp(), 1
  )
  on conflict (scope, subject_hash) do update
  set
    window_started_at = case
      when public.institutional_auth_rate_limits.window_started_at + v_window <= statement_timestamp()
        then statement_timestamp()
      else public.institutional_auth_rate_limits.window_started_at
    end,
    attempts = case
      when public.institutional_auth_rate_limits.window_started_at + v_window <= statement_timestamp()
        then 1
      else public.institutional_auth_rate_limits.attempts + 1
    end
  returning attempts into v_attempts;

  return v_attempts <= v_limit;
end;
$$;

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

  update public.institutional_bootstrap_state
  set completed_by = v_actor_id, completed_at = statement_timestamp(), correlation_id = p_correlation_id
  where singleton;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    'auth.admin.bootstrap.completed', v_actor_id, 'profile', v_actor_id::text,
    p_correlation_id, jsonb_build_object('email', v_email)
  );

  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'auth.roles.changed', 'profile', v_actor_id::text,
    jsonb_build_object('user_id', v_actor_id, 'roles_added', jsonb_build_array('ADMIN'))
  );

  return jsonb_build_object('status', 'COMPLETED', 'user_id', v_actor_id);
end;
$$;

create or replace function public.set_user_access(
  p_user_id uuid,
  p_roles text[],
  p_active boolean,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
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

  select active into v_previous_active
  from public.profiles
  where id = p_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;

  select coalesce(array_agg(role.key order by role.key), '{}'::text[])
  into v_previous_roles
  from public.user_roles user_role
  join public.roles role on role.id = user_role.role_id
  where user_role.user_id = p_user_id;

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
    join public.user_roles user_role on user_role.user_id = profile.id
    join public.roles role on role.id = user_role.role_id and role.key = 'ADMIN'
    where profile.active and profile.id <> p_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'LAST_ACTIVE_ADMIN_REQUIRED';
  end if;

  delete from public.user_roles where user_id = p_user_id;
  insert into public.user_roles (user_id, role_id)
  select p_user_id, role.id from public.roles role where role.key = any(v_requested_roles);
  update public.profiles set active = p_active where id = p_user_id;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    'auth.user.access.changed', v_actor_id, 'profile', p_user_id::text, p_correlation_id,
    jsonb_build_object(
      'previous_roles', to_jsonb(v_previous_roles),
      'roles', to_jsonb(v_requested_roles),
      'previous_active', v_previous_active,
      'active', p_active
    )
  );

  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'auth.roles.changed', 'profile', p_user_id::text,
    jsonb_build_object('user_id', p_user_id, 'roles', to_jsonb(v_requested_roles), 'active', p_active)
  );

  return jsonb_build_object('user_id', p_user_id, 'roles', to_jsonb(v_requested_roles), 'active', p_active);
end;
$$;

alter table public.institutional_auth_rate_limits enable row level security;
alter table public.institutional_bootstrap_state enable row level security;

revoke all on table public.institutional_auth_rate_limits from public, anon, authenticated, service_role;
revoke all on table public.institutional_bootstrap_state from public, anon, authenticated, service_role;
revoke all on function public.consume_institutional_auth_rate_limit(text, text) from public;
revoke all on function public.bootstrap_first_admin(uuid) from public;
revoke all on function public.set_user_access(uuid, text[], boolean, uuid) from public;
grant execute on function public.consume_institutional_auth_rate_limit(text, text) to anon, authenticated, service_role;
grant execute on function public.bootstrap_first_admin(uuid) to authenticated, service_role;
grant execute on function public.set_user_access(uuid, text[], boolean, uuid) to authenticated, service_role;

comment on table public.institutional_auth_rate_limits is 'Persistent fixed-window rate limits for institutional OTP endpoints; subjects are SHA-256 hashes.';
comment on table public.institutional_bootstrap_state is 'Singleton that permanently closes the first-admin bootstrap after one verified grant.';
comment on function public.set_user_access(uuid, text[], boolean, uuid) is 'Admin-only audited replacement of cumulative roles and active access; CONSUMIDOR is always retained.';
