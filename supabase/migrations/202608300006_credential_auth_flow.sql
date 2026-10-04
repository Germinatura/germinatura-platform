alter table public.profiles
  add column username text,
  add column avatar_path text,
  add column onboarding_completed_at timestamptz;

alter table public.profiles
  add constraint profiles_username_valid check (
    username is null or (
      username = lower(username)
      and char_length(username) between 3 and 32
      and username ~ '^[a-z][a-z0-9._]{2,31}$'
    )
  ),
  add constraint profiles_display_name_valid check (
    display_name is null or (
      display_name = btrim(display_name)
      and char_length(display_name) between 2 and 120
    )
  ),
  add constraint profiles_avatar_path_valid check (
    avatar_path is null or avatar_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}[.](jpg|jpeg|png|webp)$'
  ),
  add constraint profiles_onboarding_valid check (
    onboarding_completed_at is null
    or (username is not null and display_name is not null)
  );

create unique index profiles_username_unique on public.profiles (username) where username is not null;

alter table public.institutional_auth_rate_limits
  drop constraint institutional_auth_rate_limits_scope_valid;

update public.institutional_auth_rate_limits
set scope = case scope
  when 'OTP_REQUEST' then 'SIGNUP_REQUEST'
  when 'OTP_VERIFY' then 'SIGNUP_VERIFY'
  else scope
end
where scope in ('OTP_REQUEST', 'OTP_VERIFY');

alter table public.institutional_auth_rate_limits
  add constraint institutional_auth_rate_limits_scope_valid check (
    scope in ('SIGNUP_REQUEST', 'SIGNUP_VERIFY', 'RECOVERY_VERIFY', 'LOGIN')
  );

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
  if p_scope = 'SIGNUP_REQUEST' then
    v_limit := 5;
  elsif p_scope = 'LOGIN' then
    v_limit := 10;
  elsif p_scope in ('SIGNUP_VERIFY', 'RECOVERY_VERIFY') then
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

update public.profiles profile
set
  username = candidate.username,
  onboarding_completed_at = statement_timestamp()
from (
  select
    auth_user.id,
    case
      when lower(split_part(auth_user.email, '@', 1)) ~ '^[a-z][a-z0-9._]{2,31}$'
        then lower(split_part(auth_user.email, '@', 1))
      else 'user_' || left(replace(auth_user.id::text, '-', ''), 12)
    end as username
  from auth.users auth_user
  where nullif(auth_user.encrypted_password, '') is not null
) candidate
where profile.id = candidate.id and profile.username is null;

create table public.password_recovery_limits (
  subject_hash text primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  cycle integer not null default 1,
  request_count integer not null default 0,
  blocked_at timestamptz,
  last_requested_at timestamptz,
  unlocked_at timestamptz,
  unlocked_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  constraint password_recovery_limits_hash_valid check (subject_hash ~ '^[0-9a-f]{64}$'),
  constraint password_recovery_limits_cycle_valid check (cycle > 0),
  constraint password_recovery_limits_count_valid check (request_count between 0 and 3),
  constraint password_recovery_limits_block_valid check (
    (request_count < 3 and blocked_at is null)
    or (request_count = 3 and blocked_at is not null)
  )
);

create index password_recovery_limits_user_idx
  on public.password_recovery_limits (user_id) where user_id is not null;

create trigger password_recovery_limits_set_updated_at
before update on public.password_recovery_limits
for each row execute function private.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
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
      and profile.onboarding_completed_at is not null
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
    'username', profile.username,
    'avatar_path', profile.avatar_path,
    'active', profile.active,
    'onboarding_completed', profile.onboarding_completed_at is not null,
    'roles', coalesce(jsonb_agg(role.key order by role.key) filter (where role.key is not null), '[]'::jsonb)
  )
  from auth.users auth_user
  join public.profiles profile on profile.id = auth_user.id
  left join public.user_roles user_role on user_role.user_id = profile.id
  left join public.roles role on role.id = user_role.role_id
  where auth_user.id = auth.uid()
  group by auth_user.id, auth_user.email, profile.display_name, profile.username,
    profile.avatar_path, profile.active, profile.onboarding_completed_at;
$$;

create or replace function public.complete_my_profile(
  p_display_name text,
  p_username text,
  p_avatar_path text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_email_confirmed_at timestamptz;
  v_profile public.profiles%rowtype;
  v_name text := btrim(coalesce(p_display_name, ''));
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_avatar_path text := nullif(btrim(coalesce(p_avatar_path, '')), '');
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'CORRELATION_ID_REQUIRED';
  end if;
  if char_length(v_name) not between 2 and 120 then
    raise exception using errcode = '22023', message = 'INVALID_PROFILE_NAME';
  end if;
  if v_username !~ '^[a-z][a-z0-9._]{2,31}$' then
    raise exception using errcode = '22023', message = 'INVALID_USERNAME';
  end if;
  if v_avatar_path is not null and (
    v_avatar_path !~ ('^' || v_actor_id::text || '/[0-9a-f-]{36}[.](jpg|jpeg|png|webp)$')
    or not exists (
      select 1 from storage.objects
      where bucket_id = 'profile-photos' and name = v_avatar_path and owner_id = v_actor_id::text
    )
  ) then
    raise exception using errcode = '22023', message = 'INVALID_PROFILE_PHOTO';
  end if;

  select email_confirmed_at into v_email_confirmed_at from auth.users where id = v_actor_id;
  if v_email_confirmed_at is null then
    raise exception using errcode = '42501', message = 'EMAIL_NOT_VERIFIED';
  end if;

  select * into v_profile from public.profiles where id = v_actor_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PROFILE_NOT_FOUND';
  end if;
  if v_profile.onboarding_completed_at is not null then
    if v_profile.username = v_username and v_profile.display_name = v_name
      and v_profile.avatar_path is not distinct from v_avatar_path then
      return jsonb_build_object(
        'user_id', v_profile.id, 'email', v_profile.email, 'display_name', v_profile.display_name,
        'username', v_profile.username, 'avatar_path', v_profile.avatar_path,
        'onboarding_completed', true
      );
    end if;
    raise exception using errcode = 'P0001', message = 'ONBOARDING_ALREADY_COMPLETED';
  end if;

  update public.profiles
  set display_name = v_name, username = v_username, avatar_path = v_avatar_path,
    onboarding_completed_at = statement_timestamp()
  where id = v_actor_id
  returning * into v_profile;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    'auth.profile.completed', v_actor_id, 'profile', v_actor_id::text, p_correlation_id,
    jsonb_build_object('username', v_username, 'has_avatar', v_avatar_path is not null)
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'auth.profile.completed', 'profile', v_actor_id::text,
    jsonb_build_object('user_id', v_actor_id, 'username', v_username, 'correlation_id', p_correlation_id)
  );

  return jsonb_build_object(
    'user_id', v_profile.id, 'email', v_profile.email, 'display_name', v_profile.display_name,
    'username', v_profile.username, 'avatar_path', v_profile.avatar_path,
    'onboarding_completed', true
  );
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'USERNAME_ALREADY_USED';
end;
$$;

create or replace function public.resolve_login_identifier(p_identifier text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_identifier text := lower(btrim(coalesce(p_identifier, '')));
  v_profile public.profiles%rowtype;
begin
  if char_length(v_identifier) not between 3 and 254 then
    return null;
  end if;
  if position('@' in v_identifier) > 0 then
    if not private.is_institutional_email(v_identifier) then return null; end if;
    select * into v_profile from public.profiles where email = v_identifier;
  else
    if v_identifier !~ '^[a-z][a-z0-9._]{2,31}$' then return null; end if;
    select * into v_profile from public.profiles where username = v_identifier;
  end if;
  if not found then return null; end if;
  return jsonb_build_object(
    'user_id', v_profile.id,
    'email', v_profile.email,
    'active', v_profile.active,
    'onboarding_completed', v_profile.onboarding_completed_at is not null
  );
end;
$$;

create or replace function public.complete_admin_provisioned_profile(
  p_actor_id uuid,
  p_user_id uuid,
  p_display_name text,
  p_username text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_display_name, ''));
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_profile public.profiles%rowtype;
begin
  if p_actor_id is null or p_user_id is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PROVISIONING_REQUEST';
  end if;
  if char_length(v_name) not between 2 and 120
    or v_username !~ '^[a-z][a-z0-9._]{2,31}$' then
    raise exception using errcode = '22023', message = 'INVALID_PROVISIONING_PROFILE';
  end if;
  if not exists (
    select 1
    from public.profiles actor
    join public.user_roles user_role on user_role.user_id = actor.id
    join public.role_permissions role_permission on role_permission.role_id = user_role.role_id
    join public.permissions permission on permission.id = role_permission.permission_id
    where actor.id = p_actor_id and actor.active
      and actor.onboarding_completed_at is not null
      and permission.key = 'users.manage'
  ) then
    raise exception using errcode = '42501', message = 'USERS_MANAGE_REQUIRED';
  end if;
  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = p_user_id
      and auth_user.email_confirmed_at is not null
      and nullif(auth_user.encrypted_password, '') is not null
      and lower(auth_user.email) ~ '^[^@[:space:]]+@institutojef[.]org[.]br$'
  ) then
    raise exception using errcode = '42501', message = 'PROVISIONED_IDENTITY_INCOMPLETE';
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PROFILE_NOT_FOUND';
  end if;
  if v_profile.onboarding_completed_at is not null then
    if v_profile.display_name = v_name and v_profile.username = v_username then
      return jsonb_build_object(
        'user_id', v_profile.id, 'username', v_profile.username,
        'onboarding_completed', true
      );
    end if;
    raise exception using errcode = 'P0001', message = 'ONBOARDING_ALREADY_COMPLETED';
  end if;

  update public.profiles
  set display_name = v_name, username = v_username, onboarding_completed_at = statement_timestamp()
  where id = p_user_id
  returning * into v_profile;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    'auth.profile.provisioned', p_actor_id, 'profile', p_user_id::text, p_correlation_id,
    jsonb_build_object('username', v_username)
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'auth.profile.provisioned', 'profile', p_user_id::text,
    jsonb_build_object('user_id', p_user_id, 'username', v_username, 'correlation_id', p_correlation_id)
  );

  return jsonb_build_object(
    'user_id', v_profile.id, 'username', v_profile.username,
    'onboarding_completed', true
  );
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'USERNAME_ALREADY_USED';
end;
$$;

create or replace function public.consume_password_recovery_request(
  p_subject_hash text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit public.password_recovery_limits%rowtype;
begin
  if p_subject_hash is null or p_subject_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_RECOVERY_SUBJECT';
  end if;
  if p_user_id is not null and not exists (select 1 from public.profiles where id = p_user_id) then
    p_user_id := null;
  end if;

  insert into public.password_recovery_limits (
    subject_hash, user_id, request_count, blocked_at, last_requested_at
  ) values (
    p_subject_hash, p_user_id, 1, null, statement_timestamp()
  )
  on conflict (subject_hash) do update
  set
    user_id = coalesce(public.password_recovery_limits.user_id, excluded.user_id),
    request_count = least(public.password_recovery_limits.request_count + 1, 3),
    blocked_at = case
      when public.password_recovery_limits.request_count >= 2
        then coalesce(public.password_recovery_limits.blocked_at, statement_timestamp())
      else null
    end,
    last_requested_at = statement_timestamp()
  returning * into v_limit;

  return jsonb_build_object(
    'allowed', v_limit.request_count <= 2,
    'admin_reset_required', v_limit.request_count = 3,
    'request_count', v_limit.request_count,
    'cycle', v_limit.cycle
  );
end;
$$;

create or replace function public.unlock_password_recovery(
  p_user_id uuid,
  p_reason text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_updated integer;
begin
  if v_actor_id is null or not public.has_permission('users.manage') then
    raise exception using errcode = '42501', message = 'USERS_MANAGE_REQUIRED';
  end if;
  if p_user_id is null or p_correlation_id is null or char_length(v_reason) not between 4 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_RECOVERY_UNLOCK';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;

  update public.password_recovery_limits
  set cycle = cycle + 1, request_count = 0, blocked_at = null,
    unlocked_at = statement_timestamp(), unlocked_by = v_actor_id
  where user_id = p_user_id;
  get diagnostics v_updated = row_count;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    'auth.password_recovery.unlocked', v_actor_id, 'profile', p_user_id::text,
    p_correlation_id, jsonb_build_object('reason', v_reason, 'subjects_reset', v_updated)
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'auth.password_recovery.unlocked', 'profile', p_user_id::text,
    jsonb_build_object('user_id', p_user_id, 'correlation_id', p_correlation_id)
  );

  return jsonb_build_object('user_id', p_user_id, 'status', 'UNLOCKED', 'subjects_reset', v_updated);
end;
$$;

create or replace function public.complete_password_recovery(p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_updated integer;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'CORRELATION_ID_REQUIRED';
  end if;

  update public.password_recovery_limits
  set cycle = cycle + 1, request_count = 0, blocked_at = null,
    unlocked_at = null, unlocked_by = null
  where user_id = v_actor_id;
  get diagnostics v_updated = row_count;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    'auth.password_recovery.completed', v_actor_id, 'profile', v_actor_id::text,
    p_correlation_id, jsonb_build_object('subjects_reset', v_updated)
  );
  return jsonb_build_object('user_id', v_actor_id, 'status', 'COMPLETED');
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy profile_photos_own_read on storage.objects
  for select to authenticated
  using (bucket_id = 'profile-photos' and owner_id = auth.uid()::text);
create policy profile_photos_own_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'profile-photos'
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f-]{36}[.](jpg|jpeg|png|webp)$')
    and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
  );
create policy profile_photos_own_update on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-photos' and owner_id = auth.uid()::text)
  with check (
    bucket_id = 'profile-photos'
    and owner_id = auth.uid()::text
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f-]{36}[.](jpg|jpeg|png|webp)$')
  );
create policy profile_photos_own_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'profile-photos' and owner_id = auth.uid()::text);

alter table public.password_recovery_limits enable row level security;
revoke all on table public.password_recovery_limits from public, anon, authenticated, service_role;

revoke all on function public.complete_my_profile(text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.complete_admin_provisioned_profile(uuid, uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.resolve_login_identifier(text) from public, anon, authenticated, service_role;
revoke all on function public.consume_password_recovery_request(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.unlock_password_recovery(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.complete_password_recovery(uuid) from public, anon, authenticated, service_role;
grant execute on function public.complete_my_profile(text, text, text, uuid) to authenticated;
grant execute on function public.complete_admin_provisioned_profile(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.resolve_login_identifier(text) to service_role;
grant execute on function public.consume_password_recovery_request(text, uuid) to service_role;
grant execute on function public.unlock_password_recovery(uuid, text, uuid) to authenticated;
grant execute on function public.complete_password_recovery(uuid) to authenticated;

comment on table public.password_recovery_limits is
  'Persistent two-send password recovery cycles; the third request remains blocked until audited admin unlock.';
comment on function public.resolve_login_identifier(text) is
  'Service-only username/email resolver; never expose its result to clients.';
