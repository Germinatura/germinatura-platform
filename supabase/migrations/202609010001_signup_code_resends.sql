create table public.signup_code_limits (
  subject_hash text primary key,
  user_id uuid references public.profiles(id) on delete restrict,
  cycle integer not null default 1,
  request_count smallint not null default 0,
  last_requested_at timestamptz,
  blocked_at timestamptz,
  unlocked_at timestamptz,
  unlocked_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signup_code_limits_hash_valid check (subject_hash ~ '^[0-9a-f]{64}$'),
  constraint signup_code_limits_cycle_valid check (cycle > 0),
  constraint signup_code_limits_count_valid check (request_count between 0 and 3),
  constraint signup_code_limits_state_valid check (
    (request_count between 0 and 2 and blocked_at is null)
    or (request_count = 3 and blocked_at is not null)
  )
);

create index signup_code_limits_user_idx on public.signup_code_limits (user_id) where user_id is not null;
create trigger signup_code_limits_set_updated_at before update on public.signup_code_limits
for each row execute function private.set_updated_at();

create or replace function public.consume_signup_code_request(p_subject_hash text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_limit public.signup_code_limits%rowtype;
  v_now timestamptz := clock_timestamp();
  v_retry_after integer;
begin
  if p_subject_hash is null or p_subject_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_SIGNUP_SUBJECT';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_subject_hash, 0));
  if p_user_id is not null and not exists (select 1 from public.profiles where id = p_user_id) then
    p_user_id := null;
  end if;

  select * into v_limit from public.signup_code_limits where subject_hash = p_subject_hash for update;
  if not found then
    insert into public.signup_code_limits (subject_hash, user_id, request_count, last_requested_at)
    values (p_subject_hash, p_user_id, 1, v_now) returning * into v_limit;
    return jsonb_build_object('allowed', true, 'admin_reset_required', false,
      'request_count', 1, 'retry_after_seconds', 90, 'cycle', v_limit.cycle);
  end if;

  if v_limit.user_id is null and p_user_id is not null then
    update public.signup_code_limits set user_id = p_user_id where subject_hash = p_subject_hash;
  end if;
  if v_limit.blocked_at is not null or v_limit.request_count >= 2 then
    update public.signup_code_limits set request_count = 3,
      blocked_at = coalesce(blocked_at, v_now), user_id = coalesce(user_id, p_user_id)
    where subject_hash = p_subject_hash returning * into v_limit;
    return jsonb_build_object('allowed', false, 'admin_reset_required', true,
      'request_count', 3, 'retry_after_seconds', 0, 'cycle', v_limit.cycle);
  end if;
  if v_limit.request_count = 1 and v_limit.last_requested_at + interval '90 seconds' > v_now then
    v_retry_after := greatest(1, ceil(extract(epoch from (v_limit.last_requested_at + interval '90 seconds' - v_now)))::integer);
    return jsonb_build_object('allowed', false, 'admin_reset_required', false,
      'request_count', 1, 'retry_after_seconds', v_retry_after, 'cycle', v_limit.cycle);
  end if;

  update public.signup_code_limits set request_count = 2, last_requested_at = v_now,
    user_id = coalesce(user_id, p_user_id)
  where subject_hash = p_subject_hash returning * into v_limit;
  return jsonb_build_object('allowed', true, 'admin_reset_required', false,
    'request_count', 2, 'retry_after_seconds', 0, 'cycle', v_limit.cycle);
end;
$$;

create or replace function public.unlock_signup_code_requests(p_user_id uuid, p_reason text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_updated integer;
begin
  if v_actor_id is null or not public.has_permission('users.manage') then
    raise exception using errcode = '42501', message = 'USERS_MANAGE_REQUIRED';
  end if;
  if p_user_id is null or p_correlation_id is null or char_length(v_reason) not between 4 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_SIGNUP_UNLOCK';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;

  update public.signup_code_limits set cycle = cycle + 1, request_count = 0,
    last_requested_at = null, blocked_at = null, unlocked_at = statement_timestamp(), unlocked_by = v_actor_id
  where user_id = p_user_id;
  get diagnostics v_updated = row_count;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('auth.signup_code.unlocked', v_actor_id, 'profile', p_user_id::text, p_correlation_id,
    jsonb_build_object('reason', v_reason, 'subjects_reset', v_updated));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('auth.signup_code.unlocked', 'profile', p_user_id::text,
    jsonb_build_object('user_id', p_user_id, 'correlation_id', p_correlation_id));
  return jsonb_build_object('user_id', p_user_id, 'status', 'UNLOCKED', 'subjects_reset', v_updated);
end;
$$;

alter table public.signup_code_limits enable row level security;
revoke all on table public.signup_code_limits from public, anon, authenticated, service_role;
revoke all on function public.consume_signup_code_request(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.unlock_signup_code_requests(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.consume_signup_code_request(text, uuid) to service_role;
grant execute on function public.unlock_signup_code_requests(uuid, text, uuid) to authenticated;

comment on table public.signup_code_limits is
  'Persistent signup code cycle: initial send, one resend after 90 seconds, then audited admin unlock.';
