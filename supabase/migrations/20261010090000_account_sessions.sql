-- Etapa 9 (spec 4.8, "Minha conta: alteração de senha e sessões ativas"): each person sees their own signed-in
-- sessions and ends the ones they do not recognize. Only the caller's sessions are ever read or removed; the IP
-- is not shown. Ending a session removes it with its refresh tokens, so it cannot be renewed.

create function public.list_my_sessions()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_current text := auth.jwt() ->> 'session_id';
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', session.id, 'created_at', session.created_at,
      'last_active_at', coalesce(session.refreshed_at::timestamptz, session.updated_at, session.created_at),
      'user_agent', left(session.user_agent, 300), 'current', session.id::text = v_current)
      order by (session.id::text = v_current) desc, coalesce(session.refreshed_at::timestamptz, session.updated_at, session.created_at) desc)
    from auth.sessions session where session.user_id = v_actor_id
  ), '[]'::jsonb);
end;
$$;

create function public.end_my_sessions(p_session_id uuid, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_current text := auth.jwt() ->> 'session_id';
  v_ended integer;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_SESSION_END';
  end if;
  if p_session_id is not null and p_session_id::text = v_current then
    raise exception using errcode = 'P0001', message = 'CURRENT_SESSION_USE_LOGOUT';
  end if;
  -- A given session, or every other session when none is given; never another person's.
  delete from auth.sessions session
  where session.user_id = v_actor_id
    and (v_current is null or session.id::text <> v_current)
    and (p_session_id is null or session.id = p_session_id);
  get diagnostics v_ended = row_count;
  if p_session_id is not null and v_ended = 0 then
    raise exception using errcode = 'P0001', message = 'SESSION_NOT_FOUND';
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('auth.sessions.ended', v_actor_id, 'profile', v_actor_id::text, p_correlation_id,
    jsonb_build_object('ended', v_ended, 'scope', case when p_session_id is null then 'OTHERS' else 'ONE' end));
  return jsonb_build_object('ended', v_ended);
end;
$$;

revoke all on function public.list_my_sessions() from public, anon, authenticated, service_role;
revoke all on function public.end_my_sessions(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_my_sessions() to authenticated;
grant execute on function public.end_my_sessions(uuid, uuid) to authenticated;
comment on function public.list_my_sessions() is 'Spec 4.8: the caller''s own sessions (no IP), current first.';
comment on function public.end_my_sessions(uuid, uuid) is 'Spec 4.8: ends one of the caller''s other sessions, or all of them when no id is given; audited.';
