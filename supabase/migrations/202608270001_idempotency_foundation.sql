create type public.idempotency_status as enum (
  'IN_PROGRESS',
  'SUCCEEDED',
  'REJECTED',
  'FAILED'
);

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  key text not null,
  request_hash bytea not null,
  status public.idempotency_status not null default 'IN_PROGRESS',
  result jsonb,
  error_code text,
  resource_type text,
  resource_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint idempotency_keys_scope_key_unique unique (scope, key),
  constraint idempotency_keys_scope_valid check (
    char_length(scope) between 1 and 200
    and scope = btrim(scope)
    and scope ~ '^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_-]{0,63}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint idempotency_keys_key_valid check (
    char_length(key) between 1 and 128
    and key = btrim(key)
    and key ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint idempotency_keys_request_hash_valid check (octet_length(request_hash) = 32),
  constraint idempotency_keys_result_object check (
    result is null or jsonb_typeof(result) = 'object'
  ),
  constraint idempotency_keys_resource_pair check (
    (resource_type is null and resource_id is null)
    or (
      resource_type is not null
      and resource_id is not null
      and char_length(resource_type) between 1 and 64
      and char_length(resource_id) between 1 and 128
    )
  ),
  constraint idempotency_keys_terminal_state check (
    (
      status = 'IN_PROGRESS'
      and result is null
      and error_code is null
      and resource_type is null
      and resource_id is null
      and completed_at is null
    )
    or (
      status = 'SUCCEEDED'
      and result is not null
      and error_code is null
      and completed_at is not null
    )
    or (
      status in ('REJECTED', 'FAILED')
      and result is not null
      and error_code is not null
      and char_length(error_code) between 1 and 64
      and error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
      and completed_at is not null
    )
  )
);

create index idempotency_keys_in_progress_created_at_idx
  on public.idempotency_keys (created_at)
  where status = 'IN_PROGRESS';

alter table public.idempotency_keys enable row level security;
revoke all on table public.idempotency_keys from public, anon, authenticated, service_role;

create or replace function private.hash_idempotency_request(p_request jsonb)
returns bytea
language sql
immutable
strict
set search_path = ''
as $$
  select extensions.digest(pg_catalog.convert_to(p_request::text, 'UTF8'), 'sha256');
$$;

create or replace function private.build_idempotency_scope(
  p_domain text,
  p_operation text,
  p_principal_id uuid
)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
begin
  if p_domain !~ '^[a-z][a-z0-9_-]{0,63}$'
    or p_operation !~ '^[a-z][a-z0-9_-]{0,63}$' then
    raise exception using
      errcode = '22023',
      message = 'INVALID_IDEMPOTENCY_SCOPE';
  end if;

  return p_domain || '.' || p_operation || ':' || p_principal_id::text;
end;
$$;

create or replace function private.claim_idempotency(
  p_scope text,
  p_key text,
  p_request jsonb
)
returns table (
  record_id uuid,
  is_new boolean,
  operation_status public.idempotency_status,
  stored_result jsonb,
  stored_error_code text,
  stored_resource_type text,
  stored_resource_id text
)
language plpgsql
set search_path = ''
as $$
declare
  v_hash bytea;
  v_record_id uuid;
  v_is_new boolean;
  v_existing public.idempotency_keys%rowtype;
begin
  if p_scope is null
    or char_length(p_scope) not between 1 and 200
    or p_scope <> btrim(p_scope)
    or p_scope !~ '^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_-]{0,63}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_SCOPE';
  end if;

  if p_key is null
    or char_length(p_key) not between 1 and 128
    or p_key <> btrim(p_key)
    or p_key !~ '^[A-Za-z0-9._:-]+$' then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;

  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_REQUEST';
  end if;

  v_hash := private.hash_idempotency_request(p_request);

  insert into public.idempotency_keys (scope, key, request_hash)
  values (p_scope, p_key, v_hash)
  on conflict (scope, key) do nothing
  returning id into v_record_id;

  v_is_new := found;
  if v_is_new then
    return query
      select v_record_id, true, 'IN_PROGRESS'::public.idempotency_status,
        null::jsonb, null::text, null::text, null::text;
    return;
  end if;

  select * into strict v_existing
  from public.idempotency_keys
  where scope = p_scope and key = p_key
  for update;

  if v_existing.request_hash <> v_hash then
    raise exception using
      errcode = 'P0001',
      message = 'IDEMPOTENCY_CONFLICT';
  end if;

  return query
    select v_existing.id, false, v_existing.status, v_existing.result,
      v_existing.error_code, v_existing.resource_type, v_existing.resource_id;
end;
$$;

create or replace function private.complete_idempotency(
  p_record_id uuid,
  p_status public.idempotency_status,
  p_result jsonb,
  p_error_code text default null,
  p_resource_type text default null,
  p_resource_id text default null
)
returns public.idempotency_keys
language plpgsql
set search_path = ''
as $$
declare
  v_record public.idempotency_keys%rowtype;
begin
  if p_status = 'IN_PROGRESS'
    or p_result is null
    or jsonb_typeof(p_result) <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_COMPLETION';
  end if;

  if (p_status = 'SUCCEEDED' and p_error_code is not null)
    or (p_status in ('REJECTED', 'FAILED') and p_error_code is null) then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_COMPLETION';
  end if;

  if (p_resource_type is null) <> (p_resource_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_RESOURCE';
  end if;

  update public.idempotency_keys
  set status = p_status,
      result = p_result,
      error_code = p_error_code,
      resource_type = p_resource_type,
      resource_id = p_resource_id,
      updated_at = now(),
      completed_at = now()
  where id = p_record_id and status = 'IN_PROGRESS'
  returning * into v_record;

  if not found then
    raise exception using errcode = 'P0002', message = 'IDEMPOTENCY_RECORD_NOT_IN_PROGRESS';
  end if;

  return v_record;
end;
$$;

revoke all on function private.hash_idempotency_request(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.build_idempotency_scope(text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.claim_idempotency(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.complete_idempotency(uuid, public.idempotency_status, jsonb, text, text, text) from public, anon, authenticated, service_role;

comment on table public.idempotency_keys is
  'Internal idempotency records. Business RPCs construct scope and access rows only through private helpers.';
comment on column public.idempotency_keys.result is
  'Sanitized terminal result only; never stores credentials, card data, tokens, or raw provider payloads.';
