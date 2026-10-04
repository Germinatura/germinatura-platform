-- Product mutations stay behind an audited, idempotent command.  A generated SKU
-- is immutable so historic sales snapshots continue to identify the same item.
alter table public.products add column revision integer not null default 1
  check (revision > 0);

create sequence public.catalog_product_sku_sequence as bigint start with 1;

create function private.prevent_product_sku_update()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.sku is distinct from old.sku then
    raise exception using errcode = 'P0001', message = 'PRODUCT_SKU_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger products_prevent_sku_update before update on public.products
for each row execute function private.prevent_product_sku_update();

create function public.save_catalog_product(
  p_product_id uuid, p_expected_revision integer, p_category_id uuid,
  p_slug text, p_name text, p_description text, p_active boolean,
  p_published boolean, p_sellable_pdv boolean, p_reservable boolean,
  p_tracks_lots boolean, p_reason text, p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_before public.products%rowtype;
  v_product public.products%rowtype;
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
  if p_category_id is null
    or p_slug is null or char_length(p_slug) not between 1 and 100 or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or p_name is null or char_length(p_name) not between 1 and 160 or p_name <> btrim(p_name)
    or (p_description is not null and (char_length(p_description) not between 1 and 2000 or p_description <> btrim(p_description)))
    or p_active is null or p_published is null or p_sellable_pdv is null
    or p_reservable is null or p_tracks_lots is null
    or p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason)
    or p_correlation_id is null
    or (p_product_id is null and p_expected_revision is not null)
    or (p_product_id is not null and (p_expected_revision is null or p_expected_revision < 1)) then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG_PRODUCT';
  end if;

  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('catalog', 'product_save', v_actor), p_idempotency_key,
    jsonb_build_object('id', p_product_id, 'revision', p_expected_revision, 'category_id', p_category_id,
      'slug', p_slug, 'name', p_name, 'description', p_description, 'active', p_active,
      'published', p_published, 'sellable_pdv', p_sellable_pdv, 'reservable', p_reservable,
      'tracks_lots', p_tracks_lots, 'reason', p_reason)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  select * into v_category from public.categories where id = p_category_id for key share;
  if not found then
    raise exception using errcode = 'P0002', message = 'PRODUCT_CATEGORY_NOT_FOUND';
  end if;
  if not v_category.active then
    raise exception using errcode = 'P0001', message = 'PRODUCT_CATEGORY_INACTIVE';
  end if;

  if p_product_id is null then
    insert into public.products (
      category_id, sku, slug, name, description, active, published,
      sellable_pdv, reservable, tracks_lots
    ) values (
      p_category_id, 'PROD-' || lpad(nextval('public.catalog_product_sku_sequence')::text, 6, '0'),
      p_slug, p_name, p_description, p_active, p_published, p_sellable_pdv, p_reservable, p_tracks_lots
    ) returning * into v_product;
  else
    select * into v_before from public.products where id = p_product_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'PRODUCT_NOT_FOUND';
    end if;
    if v_before.revision <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'PRODUCT_REVISION_CONFLICT';
    end if;
    update public.products set
      category_id = p_category_id, slug = p_slug, name = p_name, description = p_description,
      active = p_active, published = p_published, sellable_pdv = p_sellable_pdv,
      reservable = p_reservable, tracks_lots = p_tracks_lots, revision = revision + 1
    where id = p_product_id returning * into v_product;
  end if;

  if (v_product.published or v_product.sellable_pdv) and not exists (
    select 1 from public.product_prices price
    where price.product_id = v_product.id and price.valid_from <= statement_timestamp()
      and (price.valid_to is null or price.valid_to > statement_timestamp())
  ) then
    raise exception using errcode = 'P0001', message = 'PRODUCT_CURRENT_PRICE_REQUIRED';
  end if;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    case when p_product_id is null then 'catalog.product.created' else 'catalog.product.updated' end,
    v_actor, 'product', v_product.id::text, p_correlation_id,
    jsonb_build_object('reason', p_reason, 'before', case when p_product_id is null then null else to_jsonb(v_before) end,
      'after', to_jsonb(v_product))
  );
  v_result := jsonb_build_object(
    'id', v_product.id, 'revision', v_product.revision, 'categoryId', v_product.category_id,
    'sku', v_product.sku, 'slug', v_product.slug, 'name', v_product.name,
    'description', v_product.description, 'active', v_product.active, 'published', v_product.published,
    'sellablePdv', v_product.sellable_pdv, 'reservable', v_product.reservable,
    'tracksLots', v_product.tracks_lots, 'correlationId', p_correlation_id
  );
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'product', v_product.id::text);
  return v_result;
end;
$$;

revoke all on sequence public.catalog_product_sku_sequence from public, anon, authenticated, service_role;
revoke all on function private.prevent_product_sku_update() from public, anon, authenticated, service_role;
revoke all on function public.save_catalog_product(uuid,integer,uuid,text,text,text,boolean,boolean,boolean,boolean,boolean,text,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.save_catalog_product(uuid,integer,uuid,text,text,text,boolean,boolean,boolean,boolean,boolean,text,text,uuid)
  to authenticated;

comment on function public.save_catalog_product(uuid,integer,uuid,text,text,text,boolean,boolean,boolean,boolean,boolean,text,text,uuid)
  is 'CAT-001: audited, idempotent product command with generated immutable SKU and optimistic revision.';
