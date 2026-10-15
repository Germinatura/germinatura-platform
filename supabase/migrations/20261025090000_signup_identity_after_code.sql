-- A1: a sign-up attempt is not a user.
--
-- Supabase Auth's native one-time code needs an auth.users row, so a code request still creates a TECHNICAL identity
-- (no new e-mail provider, user decision of 12/10/2026). The DOMAIN user (profile, explicit membership in the ACTIVE
-- default cohort, CONSUMIDOR role) is created only after the code is validated:
--   e-mail -> technical identity -> code -> verifyOtp session -> materialization (transactional, idempotent) -> onboarding.
-- The proof of a valid code is the session verifyOtp issued: the request's JWT names a session that exists in
-- auth.sessions for that user. Neither a password (Auth gives code requests a random one), email_verified nor
-- email_confirmed_at (both filled at creation under autoconfirm) is used as proof.
--
-- Every identity born as an attempt of this flow is marked, at creation, in private.signup_attempts (written only by the
-- sign-up trigger). Only marked attempts can ever be removed automatically. Identities that existed before this
-- migration (legacy) are classified and counted read-only; none is removed. A historical cleanup is a separate,
-- explicitly authorized operation, preceded by a report.

-- 0. The unequivocal mark of an attempt created by this flow. No grants: only the definer functions below write it.
create table private.signup_attempts (
  user_id uuid primary key,
  created_at timestamptz not null default statement_timestamp(),
  materialized_at timestamptz
);
revoke all on private.signup_attempts from public, anon, authenticated, service_role;

-- The proof of a valid code: the session in the request's JWT was issued by Auth for this person and still exists.
create function private.has_issued_session(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and exists (
    select 1 from auth.sessions session
    where session.user_id = p_user_id
      and session.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
      and (session.not_after is null or session.not_after > statement_timestamp()))
$$;
revoke all on function private.has_issued_session(uuid) from public, anon, authenticated, service_role;

-- A profile created by a materialization joins only the cohort the materialization names (the default one for public
-- entry, the target cohort for administrative provisioning); every other profile keeps joining the ACTIVE default.
create or replace function private.join_default_cohort() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cohort uuid := (select id from public.cohorts where is_default and status = 'ACTIVE');
begin
  if current_setting('germinatura.materializing_identity', true) = new.id::text then
    return new;
  end if;
  if v_cohort is null then
    raise exception using errcode = 'P0001', message = 'DEFAULT_COHORT_REQUIRED';
  end if;
  insert into public.user_cohorts (user_id, cohort_id) values (new.id, v_cohort)
  on conflict (user_id, cohort_id) do nothing;
  return new;
end;
$$;

-- 1. Materialization: one transaction, serialized on the auth.users row, every insert idempotent.
create function private.materialize_identity(p_user_id uuid, p_correlation_id uuid, p_cohort_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user auth.users%rowtype;
  v_cohort uuid;
  v_name text;
  v_username text;
  v_created uuid;
begin
  if p_user_id is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_MATERIALIZATION';
  end if;
  -- The same row the purge locks: a materialization and a purge of the same identity never interleave.
  select * into v_user from auth.users where id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'IDENTITY_NOT_FOUND';
  end if;
  if exists (select 1 from public.profiles where id = p_user_id) then
    return jsonb_build_object('user_id', p_user_id, 'created', false);
  end if;
  if not private.is_institutional_email(v_user.email) then
    raise exception using errcode = 'P0001', message = 'INSTITUTIONAL_EMAIL_REQUIRED';
  end if;
  -- Public entry joins the ACTIVE default cohort, named explicitly; there is no implicit fallback (ADR 0011, PR 5).
  -- Administrative provisioning names its own (checked) target cohort, and the person joins only that one.
  if p_cohort_id is null then
    select id into v_cohort from public.cohorts where is_default and status = 'ACTIVE' for share;
    if v_cohort is null then
      raise exception using errcode = 'P0001', message = 'DEFAULT_COHORT_REQUIRED';
    end if;
  else
    select id into v_cohort from public.cohorts where id = p_cohort_id and status <> 'ARCHIVED' for share;
    if v_cohort is null then
      raise exception using errcode = '22023', message = 'COHORT_REQUIRED';
    end if;
  end if;
  v_name := nullif(btrim(v_user.raw_user_meta_data ->> 'name'), '');
  v_username := lower(nullif(btrim(v_user.raw_user_meta_data ->> 'username'), ''));
  if v_name is not null and char_length(v_name) not between 2 and 120 then v_name := null; end if;
  if v_username is not null and (v_username !~ '^[a-z][a-z0-9._]{2,31}$'
    or exists (select 1 from public.profiles where username = v_username)) then v_username := null; end if;

  perform private.cohort_write_override(v_cohort);
  perform set_config('germinatura.materializing_identity', p_user_id::text, true);
  insert into public.profiles (id, email, display_name, username)
  values (p_user_id, lower(btrim(v_user.email)), coalesce(v_name, split_part(lower(btrim(v_user.email)), '@', 1)), v_username)
  on conflict (id) do nothing
  returning id into v_created;
  perform set_config('germinatura.materializing_identity', '', true);
  insert into public.user_cohorts (user_id, cohort_id) values (p_user_id, v_cohort) on conflict (user_id, cohort_id) do nothing;
  insert into cohort_data.user_roles (user_id, role_id, cohort_id)
  select p_user_id, role.id, v_cohort from public.roles role where role.key = 'CONSUMIDOR'
  on conflict do nothing;
  update private.signup_attempts set materialized_at = statement_timestamp() where user_id = p_user_id and materialized_at is null;
  if v_created is not null then
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
    values ('auth.identity.materialized', p_user_id, 'profile', p_user_id::text, p_correlation_id,
      jsonb_build_object('cohort_id', v_cohort), v_cohort);
    insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload, cohort_id)
    values ('auth.identity.materialized', 'profile', p_user_id::text,
      jsonb_build_object('user_id', p_user_id, 'cohort_id', v_cohort, 'correlation_id', p_correlation_id), v_cohort);
  end if;
  perform private.cohort_write_override(null);
  return jsonb_build_object('user_id', p_user_id, 'created', v_created is not null, 'cohort_id', v_cohort);
end;
$$;
revoke all on function private.materialize_identity(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Called by the Portal right after a valid code, with the session that code produced. Calling it again (a retry after a
-- transient failure, or from profile completion) finishes or repeats the same materialization.
create function public.materialize_my_signup_identity(p_correlation_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not private.has_issued_session(v_actor) then
    raise exception using errcode = '42501', message = 'CODE_SESSION_REQUIRED';
  end if;
  return private.materialize_identity(v_actor, p_correlation_id);
end;
$$;
revoke all on function public.materialize_my_signup_identity(uuid) from public, anon, authenticated, service_role;
grant execute on function public.materialize_my_signup_identity(uuid) to authenticated;

-- 2. New identities: a code request stays technical and is marked as an attempt of this flow. Administrative
-- provisioning and operator fixtures become domain users at once, as before.
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
  -- Without an ACTIVE default cohort nobody could finish signing up: refuse before any code is sent.
  if v_cohort is null then
    raise exception using errcode = 'P0001', message = 'DEFAULT_COHORT_REQUIRED';
  end if;
  -- Auth gives an identity created by a code request a random password and takes user metadata from the caller, so
  -- neither proves anything. A domain user is created here only for administrative provisioning (the stamp only the
  -- service role can write) or for an operator's direct SQL with name and username (local fixtures, seeds, load
  -- fixtures). Anything else, Auth included, stays technical until a valid code (fail-closed). Auth writes the
  -- provisioning stamp after the insert, so an administrative account is materialized by its provisioning instead.
  if not coalesce(new.raw_app_meta_data ? 'germinatura_provisioning', false)
    and not (session_user in ('postgres', 'supabase_admin') and v_name is not null and v_username is not null) then
    insert into private.signup_attempts (user_id) values (new.id) on conflict (user_id) do nothing;
    return new;
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

-- 3. What an identity is. Read-only; the purge re-reads it under its locks.
--   ADMIN_PROVISIONED                created by an administrator (provisioning stamp)
--   ACTIVE_ACCOUNT                   confirmed and onboarded
--   CONFIRMED_ONBOARDING_INCOMPLETE  confirmed, onboarding pending
--   CONFIRMED_NOT_MATERIALIZED       code validated, domain user still to be created (finished by the next call)
--   SIGNUP_ATTEMPT                   attempt of THIS flow, never confirmed, no history: the only removable kind
--   SIGNUP_ATTEMPT_WITH_HISTORY      attempt of this flow that something references: kept
--   LEGACY_UNCONFIRMED_EMPTY         before A1: never confirmed, empty profile + automatic membership/role; kept, hidden
--   LEGACY_UNCONFIRMED_NO_PROFILE    before A1: never confirmed, no profile; kept
--   LEGACY_UNCONFIRMED_WITH_HISTORY  before A1: never confirmed, but referenced; kept and visible
create function private.identity_has_history(p_user_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_profile public.profiles%rowtype;
  v_fk record;
  v_found boolean;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if found and (v_profile.username is not null or v_profile.avatar_path is not null
    or v_profile.onboarding_completed_at is not null or not v_profile.active) then
    return true;
  end if;
  -- The earlier sign-up trigger gave every attempt exactly one membership and the CONSUMIDOR role, nothing else.
  if (select count(*) from public.user_cohorts where user_id = p_user_id) > 1
    or exists (select 1 from public.user_cohorts where user_id = p_user_id and status <> 'ACTIVE')
    or exists (select 1 from cohort_data.user_roles user_role join public.roles role on role.id = user_role.role_id
      where user_role.user_id = p_user_id and role.key <> 'CONSUMIDOR')
    or (select count(*) from cohort_data.user_roles where user_id = p_user_id) > 1 then
    return true;
  end if;
  -- Anything written about or by the identity is history, whether or not a foreign key points at it.
  if exists (select 1 from cohort_data.audit_logs where actor_id = p_user_id or entity_id = p_user_id::text)
    or exists (select 1 from cohort_data.outbox_events where aggregate_id = p_user_id::text)
    or exists (select 1 from storage.objects where owner_id = p_user_id::text or owner = p_user_id) then
    return true;
  end if;
  -- Every foreign key to the identity or its profile, outside Auth and the rows an attempt got automatically. Read
  -- from the catalogue at run time, so a table added later is covered without touching this function.
  for v_fk in
    select constraint_row.conrelid::regclass::text as table_name, attribute.attname::text as column_name
    from pg_constraint constraint_row
    join pg_attribute attribute on attribute.attrelid = constraint_row.conrelid and attribute.attnum = constraint_row.conkey[1]
    where constraint_row.contype = 'f' and cardinality(constraint_row.conkey) = 1
      and constraint_row.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
      and constraint_row.connamespace <> 'auth'::regnamespace
  loop
    if (v_fk.table_name, v_fk.column_name) in (('public.profiles', 'id'), ('cohort_data.user_roles', 'user_id'),
      ('public.user_cohorts', 'user_id'), ('public.signup_code_limits', 'user_id'), ('public.password_recovery_limits', 'user_id')) then
      continue;
    end if;
    execute format('select exists (select 1 from %s where %I = $1)', v_fk.table_name, v_fk.column_name) into v_found using p_user_id;
    if v_found then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
revoke all on function private.identity_has_history(uuid) from public, anon, authenticated, service_role;

create function private.identity_kind(p_user_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user auth.users%rowtype;
  v_profile public.profiles%rowtype;
  v_has_profile boolean;
  v_attempt boolean;
begin
  select * into v_user from auth.users where id = p_user_id;
  if not found then
    return 'ABSENT';
  end if;
  if coalesce(v_user.raw_app_meta_data ? 'germinatura_provisioning', false) then
    return 'ADMIN_PROVISIONED';
  end if;
  select * into v_profile from public.profiles where id = p_user_id;
  v_has_profile := found;
  if v_user.email_confirmed_at is not null or v_user.last_sign_in_at is not null
    or exists (select 1 from auth.sessions where user_id = p_user_id) then
    return case when not v_has_profile then 'CONFIRMED_NOT_MATERIALIZED'
      when v_profile.onboarding_completed_at is null then 'CONFIRMED_ONBOARDING_INCOMPLETE' else 'ACTIVE_ACCOUNT' end;
  end if;
  v_attempt := exists (select 1 from private.signup_attempts where user_id = p_user_id and materialized_at is null);
  if v_attempt then
    return case when v_has_profile or private.identity_has_history(p_user_id) then 'SIGNUP_ATTEMPT_WITH_HISTORY' else 'SIGNUP_ATTEMPT' end;
  end if;
  if private.identity_has_history(p_user_id) then
    return 'LEGACY_UNCONFIRMED_WITH_HISTORY';
  end if;
  return case when v_has_profile then 'LEGACY_UNCONFIRMED_EMPTY' else 'LEGACY_UNCONFIRMED_NO_PROFILE' end;
end;
$$;
revoke all on function private.identity_kind(uuid) from public, anon, authenticated, service_role;

-- User management hides a legacy attempt that never confirmed (it is not removed). Cheap test first: most profiles are
-- confirmed, and only the unconfirmed ones get the full classification.
create function private.is_unconfirmed_attempt(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users where id = p_user_id and email_confirmed_at is null and last_sign_in_at is null)
    and private.identity_kind(p_user_id) = 'LEGACY_UNCONFIRMED_EMPTY'
$$;
revoke all on function private.is_unconfirmed_attempt(uuid) from public, anon, authenticated, service_role;

-- 4. Inventory for ADMIN_MASTER (read-only): how many identities of each kind exist. The basis of any future,
-- separately authorized historical cleanup.
create function public.identity_inventory() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  return coalesce((select jsonb_object_agg(kind, total) from (
    select private.identity_kind(id) as kind, count(*) as total from auth.users group by 1) counted), '{}');
end;
$$;
revoke all on function public.identity_inventory() from public, anon, authenticated, service_role;
grant execute on function public.identity_inventory() to authenticated;

-- Record of every removal (the domain audit needs an actor profile, and the worker has none). No e-mail is kept.
create table private.identity_purges (
  user_id uuid primary key,
  kind text not null check (kind = 'SIGNUP_ATTEMPT'),
  identity_created_at timestamptz not null,
  attempt_created_at timestamptz not null,
  purged_at timestamptz not null default now()
);
revoke all on private.identity_purges from public, anon, authenticated, service_role;

-- 5. Purge, run by the jobs worker. ONLY attempts marked by this flow (private.signup_attempts, not materialized). A row
-- is removed only when ALL of these hold, re-checked under its lock:
--   marked as an attempt of this flow at creation; not provisioned;
--   e-mail never confirmed, never signed in, no session at all;
--   expired: quiet for the whole window (no code sent, no change, no creation within it; codes last 10 minutes; the
--   window is at least one hour, 24 hours by default), so no valid confirmation can be in progress;
--   kind SIGNUP_ATTEMPT: no profile, membership, role, audit, outbox, Storage or foreign-key reference.
-- Legacy identities are never candidates. A confirmation, a resend or a materialization of the same identity holds
-- its row: the purge skips it (SKIP LOCKED) and re-reads everything under its own lock.
create function public.worker_purge_unconfirmed_identities(p_limit integer default 50, p_quiet interval default interval '24 hours')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_kind text;
  v_purged integer := 0;
  v_kept integer := 0;
begin
  perform private.assert_worker_role();
  if p_limit is null or p_limit not between 1 and 200 or p_quiet is null or p_quiet < interval '1 hour' then
    raise exception using errcode = '22023', message = 'INVALID_PURGE_REQUEST';
  end if;
  for v_id in
    select auth_user.id from auth.users auth_user
    join private.signup_attempts attempt on attempt.user_id = auth_user.id and attempt.materialized_at is null
    where auth_user.email_confirmed_at is null and auth_user.last_sign_in_at is null
      and not coalesce(auth_user.raw_app_meta_data ? 'germinatura_provisioning', false)
      and greatest(attempt.created_at, auth_user.created_at, coalesce(auth_user.updated_at, auth_user.created_at),
        coalesce(auth_user.confirmation_sent_at, auth_user.created_at), coalesce(auth_user.recovery_sent_at, auth_user.created_at),
        coalesce(auth_user.email_change_sent_at, auth_user.created_at)) < statement_timestamp() - p_quiet
    order by auth_user.created_at
    limit p_limit
    for update of auth_user skip locked
  loop
    perform 1 from public.profiles where id = v_id for update;
    v_kind := private.identity_kind(v_id);
    if v_kind <> 'SIGNUP_ATTEMPT' or exists (select 1 from auth.sessions where user_id = v_id) then
      v_kept := v_kept + 1;
      continue;
    end if;
    -- The code-request limit is keyed by the e-mail hash and stays; it just stops pointing at the attempt.
    update public.signup_code_limits set user_id = null where user_id = v_id;
    insert into private.identity_purges (user_id, kind, identity_created_at, attempt_created_at)
    select v_id, v_kind, auth_user.created_at, attempt.created_at
    from auth.users auth_user join private.signup_attempts attempt on attempt.user_id = auth_user.id where auth_user.id = v_id;
    delete from private.signup_attempts where user_id = v_id;
    delete from auth.users where id = v_id;
    v_purged := v_purged + 1;
  end loop;
  return jsonb_build_object('purged_attempts', v_purged, 'kept', v_kept);
end;
$$;
revoke all on function public.worker_purge_unconfirmed_identities(integer, interval) from public, anon, authenticated;
grant execute on function public.worker_purge_unconfirmed_identities(integer, interval) to service_role;

-- 6. Signup code unlock by e-mail. The code-request limit (one send, one resend, then an audited administrative
-- unlock) is keyed by the e-mail hash. Before A1 the attempt had a profile and was unlocked from its row in user
-- management; an attempt is no longer a user, so the administrator names the e-mail. The answer is the same whether or
-- not the e-mail exists, was blocked or was ever tried, so it enumerates nothing; the audit keeps what happened.
-- Who may unlock: ADMIN_MASTER, or users.manage in the default cohort (the cohort the person would join). At most 30
-- unlocks per administrator per hour.
create function public.unlock_signup_code_by_email(p_email text, p_reason text, p_correlation_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_default uuid := (select id from public.cohorts where is_default);
  v_hash text;
  v_updated integer;
begin
  if v_actor is null or not (private.is_admin_master() or (public.has_permission('users.manage')
    and private.cohort_mode() = 'COHORT' and private.cohort_permission_id() is not distinct from v_default)) then
    raise exception using errcode = '42501', message = 'SIGNUP_UNLOCK_FORBIDDEN';
  end if;
  if not private.is_institutional_email(v_email) or p_correlation_id is null or char_length(v_reason) not between 4 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_SIGNUP_UNLOCK';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('signup_unlock:' || v_actor::text, 0));
  if (select count(*) from cohort_data.audit_logs where action = 'auth.signup_code.unlocked_by_email' and actor_id = v_actor
    and created_at > statement_timestamp() - interval '1 hour') >= 30 then
    raise exception using errcode = 'P0001', message = 'SIGNUP_UNLOCK_RATE_LIMITED';
  end if;
  -- The Portal's subject for code requests: sha256('SIGNUP_CODE:' || normalized e-mail), hex.
  v_hash := encode(extensions.digest('SIGNUP_CODE:' || v_email, 'sha256'), 'hex');
  update public.signup_code_limits set cycle = cycle + 1, request_count = 0, last_requested_at = null, blocked_at = null,
    unlocked_at = statement_timestamp(), unlocked_by = v_actor
  where subject_hash = v_hash and blocked_at is not null;
  get diagnostics v_updated = row_count;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('auth.signup_code.unlocked_by_email', v_actor, 'signup_code_limit', v_hash, p_correlation_id,
    jsonb_build_object('reason', v_reason, 'released', v_updated > 0, 'cohort_scope', 'GLOBAL'));
  return jsonb_build_object('status', 'PROCESSED');
end;
$$;
revoke all on function public.unlock_signup_code_by_email(text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.unlock_signup_code_by_email(text, text, uuid) to authenticated;

-- 7. Profile completion finishes a materialization that a verify left undone (a transient failure after the code was
-- spent), with the same session as proof: nobody has to validate a consumed code again.
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

  -- A1: the domain user normally exists since the code was validated; a verify whose materialization did not finish
  -- (network, retry) finishes it here, once, with the session the code produced as proof.
  if not exists (select 1 from public.profiles where id = v_actor_id) then
    if not private.has_issued_session(v_actor_id) then
      raise exception using errcode = '42501', message = 'CODE_SESSION_REQUIRED';
    end if;
    perform private.materialize_identity(v_actor_id, p_correlation_id);
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

-- 8. User management lists people, not attempts.
create or replace function public.list_cohort_users(
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
    -- A1: an attempt whose e-mail was never confirmed is not a user: no row, no count.
    where not private.is_unconfirmed_attempt(profile.id)
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

-- 9. Administrative provisioning creates its domain user once the stamp is proven.
create or replace function public.complete_admin_provisioned_profile(p_actor_id uuid, p_user_id uuid, p_display_name text, p_username text, p_cohort_id uuid, p_correlation_id uuid)
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

  -- A1: Auth writes the provisioning stamp after inserting the identity, so the sign-up trigger saw a technical
  -- identity. The stamp of this very provisioning, on an identity that never signed in, proves it: the domain user is
  -- created now, directly in the target cohort (nothing is written in the default cohort for a person of another one).
  if not exists (select 1 from public.profiles where id = p_user_id) and exists (select 1 from auth.users auth_user
    where auth_user.id = p_user_id and auth_user.last_sign_in_at is null
      and auth_user.raw_app_meta_data ->> 'germinatura_provisioning' = p_correlation_id::text) then
    perform private.materialize_identity(p_user_id, p_correlation_id, p_cohort_id);
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
