-- Etapa 9 (spec 5.17, desbloqueios): administrators see which accounts have password recovery or signup codes
-- blocked after too many requests. The limit tables stay closed to every role; this read goes through the
-- users.manage check. Unlocking keeps using the audited unlock_* commands.

create function public.list_user_locks()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('users.manage') then
    raise exception using errcode = '42501', message = 'USERS_MANAGE_REQUIRED';
  end if;
  return jsonb_build_object(
    'password_recovery', coalesce((select jsonb_agg(distinct user_id) from public.password_recovery_limits
      where blocked_at is not null and user_id is not null), '[]'::jsonb),
    'signup_code', coalesce((select jsonb_agg(distinct user_id) from public.signup_code_limits
      where blocked_at is not null and user_id is not null), '[]'::jsonb));
end;
$$;
revoke all on function public.list_user_locks() from public, anon, authenticated, service_role;
grant execute on function public.list_user_locks() to authenticated;
comment on function public.list_user_locks() is 'Accounts with password recovery or signup codes blocked, for users.manage (spec 5.17).';
