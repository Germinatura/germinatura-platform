-- Session resolution without a Supabase Auth round trip per request (docs/operations/stability-report.md). The Portal
-- and the PDV now verify the access token locally against the project's signing keys (`auth.getClaims`) instead of
-- asking Auth (`auth.getUser`). Auth also refused a token whose session no longer exists (logout, "Sessões ativas",
-- password recovery), so this function takes over that check: an ended session stops resolving at once, before its
-- access token expires. Like Auth, a token without a session id is not tied to a session.
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
    and (
      coalesce(auth.jwt() ->> 'session_id', '') in ('', '00000000-0000-0000-0000-000000000000')
      or exists (
        select 1 from auth.sessions session
        where session.id = (auth.jwt() ->> 'session_id')::uuid and session.user_id = auth_user.id
      )
    )
  group by auth_user.id, auth_user.email, profile.display_name, profile.username,
    profile.avatar_path, profile.active, profile.onboarding_completed_at;
$$;
