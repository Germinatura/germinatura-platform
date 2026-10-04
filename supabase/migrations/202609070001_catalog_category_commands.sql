-- Category writes remain RPC-only; the revision prevents lost updates across tabs.
alter table public.categories add column revision integer not null default 1
  check (revision > 0);

create function public.save_catalog_category(
  p_category_id uuid, p_expected_revision integer, p_name text, p_slug text,
  p_active boolean, p_sort_order integer, p_reason text,
  p_idempotency_key text, p_correlation_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_before public.categories%rowtype;
  v_category public.categories%rowtype;
  v_claim record;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.has_permission('catalog.manage') then
    raise exception using errcode = '42501', message = 'CATALOG_MANAGE_FORBIDDEN';
  end if;
  if p_name is null or char_length(p_name) not between 1 and 120 or p_name <> btrim(p_name)
    or p_slug is null or char_length(p_slug) not between 1 and 80 or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or p_active is null or p_sort_order is null or p_sort_order < 0
    or p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason)
    or p_correlation_id is null
    or (p_category_id is null and p_expected_revision is not null)
    or (p_category_id is not null and (p_expected_revision is null or p_expected_revision < 1)) then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG_CATEGORY';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('catalog', 'category_save', v_actor), p_idempotency_key,
    jsonb_build_object('id', p_category_id, 'revision', p_expected_revision, 'name', p_name,
      'slug', p_slug, 'active', p_active, 'sort_order', p_sort_order, 'reason', p_reason)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if p_category_id is null then
    insert into public.categories (name, slug, active, sort_order)
    values (p_name, p_slug, p_active, p_sort_order) returning * into v_category;
  else
    select * into v_before from public.categories where id = p_category_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'CATEGORY_NOT_FOUND';
    end if;
    if v_before.revision <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'CATEGORY_REVISION_CONFLICT';
    end if;
    update public.categories set name = p_name, slug = p_slug, active = p_active,
      sort_order = p_sort_order, revision = revision + 1
    where id = p_category_id returning * into v_category;
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (case when p_category_id is null then 'catalog.category.created' else 'catalog.category.updated' end,
    v_actor, 'category', v_category.id::text, p_correlation_id,
    jsonb_build_object('reason', p_reason, 'before', case when p_category_id is null then null else to_jsonb(v_before) end,
      'after', to_jsonb(v_category)));
  v_result := jsonb_build_object('id', v_category.id, 'revision', v_category.revision,
    'name', v_category.name, 'slug', v_category.slug, 'active', v_category.active,
    'sortOrder', v_category.sort_order, 'correlationId', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'category', v_category.id::text);
  return v_result;
end;
$$;

revoke all on function public.save_catalog_category(uuid,integer,text,text,boolean,integer,text,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.save_catalog_category(uuid,integer,text,text,boolean,integer,text,text,uuid)
  to authenticated;

comment on function public.save_catalog_category(uuid,integer,text,text,boolean,integer,text,text,uuid)
  is 'CAT-001: audited, idempotent category command with optimistic revision; no direct table write grants.';
