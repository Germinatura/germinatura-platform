-- Optional interests are private, separate from operational identity and role data.
create table public.profile_preferences (
  profile_id uuid primary key references public.profiles(id),
  revision integer not null default 0 check (revision >= 0),
  bio text not null default '' check (char_length(bio) <= 280),
  class_name text not null default '' check (char_length(class_name) <= 60),
  sweet_preferences text[] not null default '{}',
  updated_at timestamptz not null default now(),
  constraint valid_sweet_preferences check (
    cardinality(sweet_preferences) <= 8 and array_position(sweet_preferences, null) is null
    and sweet_preferences <@ array['Chocolate','Caramelo','Frutas','Coco','Baunilha','Castanhas','Brownie','Cookie','Brigadeiro','Bolo','Bala','Chocolate branco']::text[]
  )
);
alter table public.profile_preferences enable row level security;
revoke all on public.profile_preferences from public, anon, authenticated;
grant select on public.profile_preferences to authenticated;
create policy own_preferences on public.profile_preferences for select to authenticated using (
  profile_id = auth.uid() and exists (
    select 1 from public.profiles where id = auth.uid() and active and onboarding_completed_at is not null
  )
);

create function public.update_my_profile(
  p_expected_revision integer, p_display_name text, p_avatar_path text,
  p_bio text, p_class_name text, p_sweet_preferences text[], p_idempotency_key text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_preferences public.profile_preferences%rowtype;
  v_claim record;
  v_result jsonb;
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
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('profile', 'update', v_actor), p_idempotency_key,
    jsonb_build_object('revision',p_expected_revision,'name',p_display_name,'avatar',p_avatar_path,
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
  update public.profiles set display_name=p_display_name, avatar_path=p_avatar_path where id=v_actor;
  update public.profile_preferences set bio=p_bio,class_name=p_class_name,sweet_preferences=p_sweet_preferences,
    revision=revision+1,updated_at=now() where profile_id=v_actor returning * into v_preferences;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
  values('profile.updated',v_actor,'profile',v_actor::text,p_correlation_id,
    jsonb_build_object('revision',v_preferences.revision,'has_avatar',p_avatar_path is not null));
  v_result := jsonb_build_object('revision',v_preferences.revision);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'profile',v_actor::text);
  return v_result;
end;
$$;
revoke all on function public.update_my_profile(integer,text,text,text,text,text[],text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.update_my_profile(integer,text,text,text,text,text[],text,uuid) to authenticated;
