-- A2: the profile stays editable after onboarding: name, username, photo and the optional interests, in one atomic save.
-- The confirmed e-mail is the identity's anchor and never changes.
-- Every domain relation uses user_id (sales, roles, memberships, audit, notifications). The username is only a login
-- handle and a display label, so changing it rewrites no history. Audit metadata keeps a snapshot of the username at
-- that moment, never a reference to it.

create function public.update_my_profile(
  p_expected_revision integer, p_display_name text, p_username text, p_avatar_path text,
  p_bio text, p_class_name text, p_sweet_preferences text[], p_idempotency_key text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_profile public.profiles%rowtype;
  v_preferences public.profile_preferences%rowtype;
  v_claim record;
  v_result jsonb;
  v_username_changed boolean;
begin
  -- Lock identity first so all edits and administrative deactivation serialize.
  select * into v_profile from public.profiles where id = v_actor for update;
  if not found or not v_profile.active or v_profile.onboarding_completed_at is null then
    raise exception using errcode = '42501', message = 'PROFILE_EDIT_FORBIDDEN';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 2147483647
    or p_display_name is null or char_length(p_display_name) not between 2 and 120 or p_display_name <> btrim(p_display_name)
    or p_bio is null or char_length(p_bio) > 280 or p_bio <> btrim(p_bio)
    or p_class_name is null or char_length(p_class_name) > 60 or p_class_name <> btrim(p_class_name)
    or p_sweet_preferences is null or cardinality(p_sweet_preferences) > 8
    or cardinality(p_sweet_preferences) <> (select count(distinct item) from unnest(p_sweet_preferences) item)
    or not p_sweet_preferences <@ array['Chocolate','Caramelo','Frutas','Coco','Baunilha','Castanhas','Brownie','Cookie','Brigadeiro','Bolo','Bala','Chocolate branco']::text[]
    or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PROFILE';
  end if;
  -- The same rule as the sign-up (complete_my_profile and the profiles_username_valid constraint).
  if v_username !~ '^[a-z][a-z0-9._]{2,31}$' then
    raise exception using errcode = '22023', message = 'INVALID_USERNAME';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('profile', 'update', v_actor), p_idempotency_key,
    jsonb_build_object('revision',p_expected_revision,'name',p_display_name,'username',v_username,'avatar',p_avatar_path,
      'bio',p_bio,'class',p_class_name,'preferences',p_sweet_preferences)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  if p_avatar_path is not null and (
    p_avatar_path !~ ('^' || v_actor::text || '/[0-9a-f-]{36}[.](jpg|jpeg|png|webp)$') or not exists (
      select 1 from storage.objects where bucket_id = 'profile-photos' and name = p_avatar_path and owner_id = v_actor::text
    )
  ) then raise exception using errcode = '22023', message = 'INVALID_PROFILE_PHOTO'; end if;
  insert into public.profile_preferences(profile_id) values(v_actor) on conflict do nothing;
  select * into v_preferences from public.profile_preferences where profile_id = v_actor for update;
  if v_preferences.revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'PROFILE_REVISION_CONFLICT';
  end if;
  v_username_changed := v_profile.username is distinct from v_username;
  -- Two people choosing the same free username at once: the unique index decides, the loser gets a clear answer.
  begin
    update public.profiles set display_name=p_display_name, username=v_username, avatar_path=p_avatar_path where id=v_actor;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'USERNAME_ALREADY_USED';
  end;
  update public.profile_preferences set bio=p_bio,class_name=p_class_name,sweet_preferences=p_sweet_preferences,
    revision=revision+1,updated_at=now() where profile_id=v_actor returning * into v_preferences;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
  values('profile.updated',v_actor,'profile',v_actor::text,p_correlation_id,
    jsonb_build_object('revision',v_preferences.revision,'has_avatar',p_avatar_path is not null,'username_changed',v_username_changed));
  if v_username_changed then
    insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
    values('profile.username_changed',v_actor,'profile',v_actor::text,p_correlation_id,
      jsonb_build_object('previous_username',v_profile.username,'username',v_username));
    insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload)
    values('auth.username.changed','profile',v_actor::text,
      jsonb_build_object('user_id',v_actor,'username',v_username,'correlation_id',p_correlation_id));
  end if;
  v_result := jsonb_build_object('revision',v_preferences.revision,'username',v_username);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'profile',v_actor::text);
  return v_result;
end;
$$;
revoke all on function public.update_my_profile(integer,text,text,text,text,text,text[],text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.update_my_profile(integer,text,text,text,text,text,text[],text,uuid) to authenticated;

-- The previous signature (no username) stays callable only while the earlier Portal is still being replaced in a deploy.
-- It now keeps the current username and runs the single implementation above.
create or replace function public.update_my_profile(
  p_expected_revision integer, p_display_name text, p_avatar_path text,
  p_bio text, p_class_name text, p_sweet_preferences text[], p_idempotency_key text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return public.update_my_profile(p_expected_revision, p_display_name,
    (select username from public.profiles where id = auth.uid()), p_avatar_path,
    p_bio, p_class_name, p_sweet_preferences, p_idempotency_key, p_correlation_id);
end;
$$;
revoke all on function public.update_my_profile(integer,text,text,text,text,text[],text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.update_my_profile(integer,text,text,text,text,text[],text,uuid) to authenticated;

-- The confirmed e-mail is not editable. The browser holds a Supabase session, so Auth's own "update user" (PUT /user
-- with a new e-mail) would otherwise start an e-mail change. That change would bypass the institutional domain rule and
-- leave profiles.email stale. Auth persists the pending change (email_change) before sending anything, and any later
-- swap of the address, so refusing both here closes the path for every client. The error surfaces as an Auth error.
create function public.prevent_auth_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is distinct from old.email
    or (coalesce(new.email_change, '') <> '' and new.email_change is distinct from old.email_change) then
    raise exception using errcode = '42501', message = 'EMAIL_IMMUTABLE';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_auth_email_change() from public, anon, authenticated, service_role;

create trigger auth_users_email_immutable
  before update on auth.users
  for each row execute function public.prevent_auth_email_change();
