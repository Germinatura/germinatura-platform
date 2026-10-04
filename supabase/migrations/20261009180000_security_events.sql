-- Etapa 9 (AUD-001, spec 5.16): logins, failed logins and authorization denials become investigable.
-- Failed logins may name no account, so they live apart from audit_logs (whose actor is mandatory). Nothing
-- stores passwords, tokens or IPs; an unknown identifier is kept only as a SHA-256 hash. Writers are bounded per
-- subject so the public failure recorder cannot be used to flood the table.

create table public.security_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGIN_RATE_LIMITED', 'AUTHORIZATION_DENIED')),
  app text not null check (app in ('PORTAL', 'PDV')),
  actor_id uuid references public.profiles(id) on delete restrict,
  subject_hash text check (subject_hash is null or subject_hash ~ '^[0-9a-f]{64}$'),
  route text check (route is null or (char_length(route) <= 200 and route ~ '^/[A-Za-z0-9/_:.%-]*$')),
  method text check (method is null or method in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),
  request_id text check (request_id is null or (char_length(request_id) <= 100 and request_id ~ '^[A-Za-z0-9._:-]+$')),
  created_at timestamptz not null default clock_timestamp(),
  constraint security_events_subject_present check (actor_id is not null or subject_hash is not null)
);
create index security_events_created_idx on public.security_events (created_at desc, id desc);
create index security_events_actor_idx on public.security_events (actor_id, created_at desc) where actor_id is not null;
create index security_events_subject_idx on public.security_events (subject_hash, created_at desc) where subject_hash is not null;
create trigger security_events_immutable before update or delete on public.security_events
for each row execute function private.prevent_immutable_record_change();
alter table public.security_events enable row level security;
revoke all on public.security_events from public, anon, authenticated, service_role;

create function private.clean_request_id(p_request_id text)
returns text language sql immutable set search_path = '' as $$
  select case when p_request_id is not null and char_length(p_request_id) <= 100 and p_request_id ~ '^[A-Za-z0-9._:-]+$' then p_request_id end;
$$;

-- Called by the login routes after a failed attempt; returns nothing, so it never tells whether an account exists.
create function public.record_login_failure(p_identifier text, p_app text, p_rate_limited boolean, p_request_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_identifier text := lower(btrim(coalesce(p_identifier, '')));
  v_hash text;
  v_actor_id uuid;
begin
  if char_length(v_identifier) not between 1 and 254 or p_app not in ('PORTAL', 'PDV') then
    return;
  end if;
  v_hash := encode(sha256(convert_to(v_identifier, 'UTF8')), 'hex');
  if (select count(*) from public.security_events where subject_hash = v_hash
      and created_at > clock_timestamp() - interval '15 minutes') >= 30 then
    return;
  end if;
  select id into v_actor_id from public.profiles where lower(email) = v_identifier or username = v_identifier limit 1;
  -- Random identifiers cannot flood the table: attempts on unknown accounts share one global budget.
  if v_actor_id is null and (select count(*) from public.security_events where actor_id is null
      and created_at > clock_timestamp() - interval '15 minutes') >= 1000 then
    return;
  end if;
  insert into public.security_events (kind, app, actor_id, subject_hash, request_id)
  values (case when p_rate_limited then 'LOGIN_RATE_LIMITED' else 'LOGIN_FAILED' end, p_app, v_actor_id, v_hash,
    private.clean_request_id(p_request_id));
end;
$$;

create function public.record_login_success(p_app text, p_request_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null or p_app not in ('PORTAL', 'PDV') then
    return;
  end if;
  if exists (select 1 from public.security_events where actor_id = v_actor_id and kind = 'LOGIN_SUCCEEDED' and app = p_app
      and created_at > clock_timestamp() - interval '5 seconds') then
    return;
  end if;
  insert into public.security_events (kind, app, actor_id, request_id)
  values ('LOGIN_SUCCEEDED', p_app, v_actor_id, private.clean_request_id(p_request_id));
end;
$$;

create function public.record_authorization_denied(p_app text, p_route text, p_method text, p_request_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null or p_app not in ('PORTAL', 'PDV') or p_route is null or char_length(p_route) > 200
    or p_route !~ '^/[A-Za-z0-9/_:.%-]*$' or p_method not in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE') then
    return;
  end if;
  if (select count(*) from public.security_events where actor_id = v_actor_id and kind = 'AUTHORIZATION_DENIED'
      and created_at > clock_timestamp() - interval '15 minutes') >= 60 then
    return;
  end if;
  insert into public.security_events (kind, app, actor_id, route, method, request_id)
  values ('AUTHORIZATION_DENIED', p_app, v_actor_id, p_route, p_method, private.clean_request_id(p_request_id));
end;
$$;

create function public.search_security_events(
  p_from date, p_to date, p_kind text default null, p_actor text default null,
  p_cursor_created_at timestamptz default null, p_cursor_id uuid default null, p_limit integer default 50
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor text := nullif(btrim(p_actor), '');
begin
  if auth.uid() is null or not public.has_permission('audit.read') then
    raise exception using errcode = '42501', message = 'AUDIT_READ_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 or p_limit is null or p_limit not between 1 and 100
    or (p_kind is not null and p_kind not in ('LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGIN_RATE_LIMITED', 'AUTHORIZATION_DENIED'))
    or (v_actor is not null and char_length(v_actor) > 80) or ((p_cursor_created_at is null) <> (p_cursor_id is null)) then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_FILTER';
  end if;
  return (
    with page as (
      select event.*, coalesce(nullif(btrim(actor.display_name), ''), actor.email) as actor_name,
        row_number() over (order by event.created_at desc, event.id desc) as position
      from public.security_events event
      left join public.profiles actor on actor.id = event.actor_id
      where event.created_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
        and event.created_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')
        and (p_kind is null or event.kind = p_kind)
        and (v_actor is null or actor.display_name ilike '%' || v_actor || '%' or actor.email ilike '%' || v_actor || '%'
          or actor.username ilike '%' || v_actor || '%'
          or event.subject_hash = encode(sha256(convert_to(lower(v_actor), 'UTF8')), 'hex'))
        and (p_cursor_created_at is null or (event.created_at, event.id) < (p_cursor_created_at, p_cursor_id))
      order by event.created_at desc, event.id desc
      limit p_limit + 1
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'kind', kind, 'app', app,
          'actor_id', actor_id, 'actor_name', actor_name, 'route', route, 'method', method, 'request_id', request_id,
          'subject_hash_prefix', left(subject_hash, 12)) order by position) from page where position <= p_limit), '[]'::jsonb),
      'next_cursor', (select jsonb_build_object('created_at', created_at, 'id', id) from page
        where position = p_limit and exists (select 1 from page where position = p_limit + 1)))
  );
end;
$$;

revoke all on function private.clean_request_id(text) from public, anon, authenticated, service_role;
revoke all on function public.record_login_failure(text, text, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.record_login_success(text, text) from public, anon, authenticated, service_role;
revoke all on function public.record_authorization_denied(text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.search_security_events(date, date, text, text, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.record_login_failure(text, text, boolean, text) to anon, authenticated, service_role;
grant execute on function public.record_login_success(text, text) to authenticated;
grant execute on function public.record_authorization_denied(text, text, text, text) to authenticated;
grant execute on function public.search_security_events(date, date, text, text, timestamptz, uuid, integer) to authenticated;
comment on table public.security_events is 'AUD-001: logins, failed logins and authorization denials; no passwords, tokens or IPs.';
