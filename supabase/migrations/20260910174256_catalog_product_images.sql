-- Product image metadata is authoritative in public schema. Binary objects are
-- written and deleted only through the Storage API, outside database commands.
create table public.product_images (
  id uuid primary key,
  product_id uuid not null references public.products(id) on delete restrict,
  object_path text not null unique,
  alt_text text not null,
  sort_order smallint not null,
  status text not null default 'ACTIVE',
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  removed_by uuid references auth.users(id) on delete restrict,
  removed_at timestamptz,
  constraint product_images_alt_text_valid check (char_length(alt_text) between 1 and 180 and alt_text = btrim(alt_text)),
  constraint product_images_sort_order_valid check (sort_order between 0 and 5),
  constraint product_images_status_valid check (status in ('ACTIVE', 'REMOVING', 'REMOVED')),
  constraint product_images_removal_valid check (
    (status = 'ACTIVE' and removed_by is null and removed_at is null)
    or (status in ('REMOVING', 'REMOVED') and removed_by is not null and removed_at is not null)
  )
);

create index product_images_product_order_idx
  on public.product_images(product_id, status, sort_order, id);
create index product_images_created_by_idx on public.product_images(created_by);
create index product_images_removed_by_idx on public.product_images(removed_by) where removed_by is not null;

alter table public.product_images enable row level security;
revoke all on table public.product_images from public, anon, authenticated, service_role;
grant select on table public.product_images to anon, authenticated;

create policy product_images_public_read on public.product_images
  for select to anon, authenticated using (
    status = 'ACTIVE' and exists (
      select 1 from public.products product
      join public.categories category on category.id = product.category_id
      where product.id = product_images.product_id
        and product.active and product.published and category.active
    )
  );

create policy product_images_manager_read on public.product_images
  for select to authenticated using ((select public.has_permission('catalog.manage')));

-- Public buckets do not require SELECT policies for public URL downloads. Drop
-- object listing and overwrites; every upload gets an immutable canonical path.
drop policy if exists "catalog_images_public_read" on storage.objects;
drop policy if exists "catalog_images_admin_insert" on storage.objects;
drop policy if exists "catalog_images_admin_update" on storage.objects;
drop policy if exists "catalog_images_admin_delete" on storage.objects;

update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'product-images';

create policy "catalog_images_admin_insert" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'product-images'
    and (select public.has_permission('catalog.manage'))
    and name ~ '^products/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
    and lower(storage.extension(name)) in ('jpg', 'png', 'webp')
  );

create policy "catalog_images_admin_delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'product-images'
    and (select public.has_permission('catalog.manage'))
    and name ~ '^products/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
  );

create function public.add_catalog_product_image(
  p_product_id uuid, p_expected_product_revision integer, p_image_id uuid,
  p_object_path text, p_alt_text text, p_reason text,
  p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_product public.products%rowtype;
  v_image public.product_images%rowtype;
  v_claim record;
  v_result jsonb;
  v_expected_path text;
  v_extension text;
  v_object record;
begin
  if v_actor is null then raise exception using errcode='42501', message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('catalog.manage') then raise exception using errcode='42501', message='CATALOG_MANAGE_FORBIDDEN'; end if;
  v_extension := lower(substring(p_object_path from '\.([a-z0-9]+)$'));
  v_expected_path := 'products/' || p_product_id::text || '/' || p_image_id::text || '.' || v_extension;
  if p_product_id is null or p_expected_product_revision is null or p_expected_product_revision < 1
    or p_image_id is null or p_object_path is null or p_object_path <> v_expected_path
    or v_extension is null or v_extension not in ('jpg','png','webp')
    or p_alt_text is null or char_length(p_alt_text) not between 1 and 180 or p_alt_text <> btrim(p_alt_text)
    or p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason)
    or p_correlation_id is null then
    raise exception using errcode='22023', message='INVALID_CATALOG_PRODUCT_IMAGE';
  end if;

  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('catalog','product_image_add',v_actor), p_idempotency_key,
    jsonb_build_object('product_id',p_product_id,'revision',p_expected_product_revision,'image_id',p_image_id,
      'object_path',p_object_path,'alt_text',p_alt_text,'reason',p_reason)
  );
  if not v_claim.is_new then
    if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001', message='IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;

  select * into v_product from public.products where id=p_product_id for update;
  if not found then raise exception using errcode='P0002', message='PRODUCT_NOT_FOUND'; end if;
  if v_product.revision <> p_expected_product_revision then raise exception using errcode='P0001', message='PRODUCT_REVISION_CONFLICT'; end if;
  if (select count(*) from public.product_images where product_id=p_product_id and status='ACTIVE') >= 6 then
    raise exception using errcode='P0001', message='PRODUCT_IMAGE_LIMIT_REACHED';
  end if;

  select metadata->>'mimetype' as mime_type, (metadata->>'size')::bigint as byte_size
  into v_object from storage.objects where bucket_id='product-images' and name=p_object_path;
  if not found or v_object.mime_type not in ('image/jpeg','image/png','image/webp')
    or v_object.byte_size is null or v_object.byte_size < 1 or v_object.byte_size > 5242880 then
    raise exception using errcode='P0001', message='PRODUCT_IMAGE_OBJECT_INVALID';
  end if;

  insert into public.product_images(id,product_id,object_path,alt_text,sort_order,created_by)
  values (p_image_id,p_product_id,p_object_path,p_alt_text,
    (select count(*)::smallint from public.product_images where product_id=p_product_id and status='ACTIVE'),v_actor)
  returning * into v_image;
  update public.products set revision=revision+1 where id=p_product_id returning * into v_product;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
  values ('catalog.product_image.added',v_actor,'product_image',v_image.id::text,p_correlation_id,
    jsonb_build_object('reason',p_reason,'product_id',p_product_id,'product_revision_after',v_product.revision,'image',to_jsonb(v_image)));
  v_result := jsonb_build_object('id',v_image.id,'productId',v_image.product_id,'objectPath',v_image.object_path,
    'altText',v_image.alt_text,'sortOrder',v_image.sort_order,'productRevision',v_product.revision,'correlationId',p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'product_image',v_image.id::text);
  return v_result;
end;
$$;

create function public.reorder_catalog_product_images(
  p_product_id uuid, p_expected_product_revision integer, p_image_ids uuid[],
  p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid(); v_product public.products%rowtype; v_claim record; v_result jsonb;
  v_before jsonb; v_count integer;
begin
  if v_actor is null then raise exception using errcode='42501', message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('catalog.manage') then raise exception using errcode='42501', message='CATALOG_MANAGE_FORBIDDEN'; end if;
  if p_product_id is null or p_expected_product_revision is null or p_expected_product_revision < 1
    or p_image_ids is null or cardinality(p_image_ids) not between 1 and 6
    or p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason)
    or p_correlation_id is null then raise exception using errcode='22023', message='INVALID_CATALOG_PRODUCT_IMAGE_ORDER'; end if;
  select count(distinct id) into v_count from unnest(p_image_ids) id;
  if v_count <> cardinality(p_image_ids) then raise exception using errcode='22023', message='INVALID_CATALOG_PRODUCT_IMAGE_ORDER'; end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('catalog','product_image_reorder',v_actor),p_idempotency_key,
    jsonb_build_object('product_id',p_product_id,'revision',p_expected_product_revision,'image_ids',p_image_ids,'reason',p_reason));
  if not v_claim.is_new then
    if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001', message='IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_product from public.products where id=p_product_id for update;
  if not found then raise exception using errcode='P0002', message='PRODUCT_NOT_FOUND'; end if;
  if v_product.revision <> p_expected_product_revision then raise exception using errcode='P0001', message='PRODUCT_REVISION_CONFLICT'; end if;
  select coalesce(jsonb_agg(id order by sort_order,id),'[]'::jsonb),count(*) into v_before,v_count
  from public.product_images where product_id=p_product_id and status='ACTIVE';
  if v_count <> cardinality(p_image_ids) or exists (
    select 1 from unnest(p_image_ids) id where not exists (
      select 1 from public.product_images image where image.id=id and image.product_id=p_product_id and image.status='ACTIVE')) then
    raise exception using errcode='P0001', message='PRODUCT_IMAGE_SET_CHANGED';
  end if;
  update public.product_images image set sort_order=ordered.position::smallint
  from (select id, ordinality-1 as position from unnest(p_image_ids) with ordinality as entry(id,ordinality)) ordered
  where image.id=ordered.id;
  update public.products set revision=revision+1 where id=p_product_id returning * into v_product;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
  values ('catalog.product_images.reordered',v_actor,'product',p_product_id::text,p_correlation_id,
    jsonb_build_object('reason',p_reason,'before',v_before,'after',to_jsonb(p_image_ids),'product_revision_after',v_product.revision));
  v_result := jsonb_build_object('productId',p_product_id,'productRevision',v_product.revision,
    'imageIds',to_jsonb(p_image_ids),'correlationId',p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'product',p_product_id::text);
  return v_result;
end;
$$;

create function public.begin_remove_catalog_product_image(
  p_image_id uuid, p_product_id uuid, p_expected_product_revision integer,
  p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid(); v_product public.products%rowtype; v_image public.product_images%rowtype;
  v_claim record; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode='42501', message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('catalog.manage') then raise exception using errcode='42501', message='CATALOG_MANAGE_FORBIDDEN'; end if;
  if p_image_id is null or p_product_id is null or p_expected_product_revision is null or p_expected_product_revision < 1
    or p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason)
    or p_correlation_id is null then raise exception using errcode='22023', message='INVALID_CATALOG_PRODUCT_IMAGE_REMOVAL'; end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('catalog','product_image_remove',v_actor),p_idempotency_key,
    jsonb_build_object('image_id',p_image_id,'product_id',p_product_id,'revision',p_expected_product_revision,'reason',p_reason));
  if not v_claim.is_new then
    if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001', message='IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_product from public.products where id=p_product_id for update;
  if not found then raise exception using errcode='P0002', message='PRODUCT_NOT_FOUND'; end if;
  select * into v_image from public.product_images where id=p_image_id and product_id=p_product_id for update;
  if not found then raise exception using errcode='P0002', message='PRODUCT_IMAGE_NOT_FOUND'; end if;
  if v_image.status in ('REMOVING','REMOVED') then
    v_result := jsonb_build_object('id',v_image.id,'productId',v_image.product_id,'objectPath',v_image.object_path,
      'productRevision',v_product.revision,'correlationId',p_correlation_id);
    perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'product_image',v_image.id::text);
    return v_result;
  end if;
  if v_product.revision <> p_expected_product_revision then raise exception using errcode='P0001', message='PRODUCT_REVISION_CONFLICT'; end if;
  update public.product_images set status='REMOVING',removed_by=v_actor,removed_at=statement_timestamp() where id=p_image_id returning * into v_image;
  with ordered as (select id,row_number() over(order by sort_order,id)-1 as position from public.product_images where product_id=p_product_id and status='ACTIVE')
  update public.product_images image set sort_order=ordered.position::smallint from ordered where image.id=ordered.id;
  update public.products set revision=revision+1 where id=p_product_id returning * into v_product;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
  values ('catalog.product_image.removal_started',v_actor,'product_image',v_image.id::text,p_correlation_id,
    jsonb_build_object('reason',p_reason,'product_id',p_product_id,'product_revision_after',v_product.revision,'image',to_jsonb(v_image)));
  v_result := jsonb_build_object('id',v_image.id,'productId',v_image.product_id,'objectPath',v_image.object_path,
    'productRevision',v_product.revision,'correlationId',p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'product_image',v_image.id::text);
  return v_result;
end;
$$;

create function public.finish_remove_catalog_product_image(p_image_id uuid, p_correlation_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid:=auth.uid(); v_image public.product_images%rowtype;
begin
  if v_actor is null then raise exception using errcode='42501', message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('catalog.manage') then raise exception using errcode='42501', message='CATALOG_MANAGE_FORBIDDEN'; end if;
  if p_image_id is null or p_correlation_id is null then raise exception using errcode='22023', message='INVALID_CATALOG_PRODUCT_IMAGE_REMOVAL'; end if;
  select * into v_image from public.product_images where id=p_image_id for update;
  if not found then raise exception using errcode='P0002', message='PRODUCT_IMAGE_NOT_FOUND'; end if;
  if v_image.status='REMOVED' then return; end if;
  if v_image.status<>'REMOVING' then raise exception using errcode='P0001', message='PRODUCT_IMAGE_REMOVAL_NOT_STARTED'; end if;
  update public.product_images set status='REMOVED' where id=p_image_id;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
  values ('catalog.product_image.removed',v_actor,'product_image',p_image_id::text,p_correlation_id,
    jsonb_build_object('product_id',v_image.product_id,'object_path',v_image.object_path));
end;
$$;

revoke all on function public.add_catalog_product_image(uuid,integer,uuid,text,text,text,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.reorder_catalog_product_images(uuid,integer,uuid[],text,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.begin_remove_catalog_product_image(uuid,uuid,integer,text,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.finish_remove_catalog_product_image(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.add_catalog_product_image(uuid,integer,uuid,text,text,text,text,uuid) to authenticated;
grant execute on function public.reorder_catalog_product_images(uuid,integer,uuid[],text,text,uuid) to authenticated;
grant execute on function public.begin_remove_catalog_product_image(uuid,uuid,integer,text,text,uuid) to authenticated;
grant execute on function public.finish_remove_catalog_product_image(uuid,uuid) to authenticated;

comment on table public.product_images is 'CAT-001 ordered metadata for immutable public product image objects.';
