-- Etapa 9 (spec 6.1): "Abrir PDV" from the Portal without typing the password again. Portal and PDV live on
-- different domains, so the session moves by a single-use code valid for 60 seconds. Only the code's SHA-256
-- reaches the database; the code travels in the URL fragment (never in logs) and is redeemed once by the PDV
-- server with its service role. The PDV still checks the seller role after the handoff.

create table public.pdv_handoff_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint pdv_handoff_codes_window_valid check (expires_at > created_at and expires_at <= created_at + interval '2 minutes')
);
create index pdv_handoff_codes_user_idx on public.pdv_handoff_codes (user_id, created_at desc);
alter table public.pdv_handoff_codes enable row level security;
revoke all on public.pdv_handoff_codes from public, anon, authenticated, service_role;

create function public.create_pdv_handoff(p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_expires timestamptz := clock_timestamp() + interval '60 seconds';
begin
  if v_actor_id is null or not public.has_permission('sales.create')
    or not exists (select 1 from public.profiles where id = v_actor_id and active and onboarding_completed_at is not null) then
    raise exception using errcode = '42501', message = 'PDV_ACCESS_REQUIRED';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_PDV_HANDOFF';
  end if;
  if (select count(*) from public.pdv_handoff_codes where user_id = v_actor_id and created_at > clock_timestamp() - interval '10 minutes') >= 10 then
    raise exception using errcode = 'P0001', message = 'PDV_HANDOFF_RATE_LIMITED';
  end if;
  insert into public.pdv_handoff_codes (code_hash, user_id, expires_at) values (p_code_hash, v_actor_id, v_expires);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('auth.pdv_handoff.issued', v_actor_id, 'profile', v_actor_id::text, gen_random_uuid(), jsonb_build_object('expires_at', v_expires));
  return jsonb_build_object('expires_at', v_expires);
end;
$$;

-- Redeemed once, by the PDV server only; an expired, used or unknown code gives the same answer.
create function public.consume_pdv_handoff(p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
  return jsonb_build_object('user_id', v_profile.id, 'email', v_profile.email);
end;
$$;

revoke all on function public.create_pdv_handoff(text) from public, anon, authenticated, service_role;
revoke all on function public.consume_pdv_handoff(text) from public, anon, authenticated, service_role;
grant execute on function public.create_pdv_handoff(text) to authenticated;
grant execute on function public.consume_pdv_handoff(text) to service_role;
comment on table public.pdv_handoff_codes is 'Spec 6.1: single-use, 60-second Portal→PDV handoff codes; only the SHA-256 is stored.';
