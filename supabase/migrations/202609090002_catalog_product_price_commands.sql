-- Price amounts are never overwritten.  A controlled command may close an
-- open interval and append its successor, preserving the full quoted history.
create or replace function private.prevent_product_price_update()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.valid_to is null
    and new.valid_to is not null
    and new.valid_to > old.valid_from
    and new.id = old.id
    and new.product_id = old.product_id
    and new.amount_cents = old.amount_cents
    and new.valid_from = old.valid_from
    and new.created_by is not distinct from old.created_by
    and new.created_at = old.created_at then
    return new;
  end if;

  raise exception using errcode = 'P0001', message = 'PRODUCT_PRICE_HISTORY_IMMUTABLE';
end;
$$;

create function public.set_catalog_product_price(
  p_product_id uuid, p_expected_product_revision integer, p_amount_cents bigint,
  p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_before_product public.products%rowtype;
  v_product public.products%rowtype;
  v_current_price public.product_prices%rowtype;
  v_price public.product_prices%rowtype;
  v_next_valid_from timestamptz;
  v_effective_at timestamptz := statement_timestamp();
  v_claim record;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.has_permission('catalog.manage') then
    raise exception using errcode = '42501', message = 'CATALOG_MANAGE_FORBIDDEN';
  end if;
  if p_product_id is null
    or p_expected_product_revision is null or p_expected_product_revision < 1
    or p_amount_cents is null or p_amount_cents < 0 or p_amount_cents > 9007199254740991
    or p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason)
    or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CATALOG_PRODUCT_PRICE';
  end if;

  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('catalog', 'product_price_set', v_actor), p_idempotency_key,
    jsonb_build_object('product_id', p_product_id, 'product_revision', p_expected_product_revision,
      'amount_cents', p_amount_cents, 'reason', p_reason)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  select * into v_before_product from public.products where id = p_product_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PRODUCT_NOT_FOUND';
  end if;
  if v_before_product.revision <> p_expected_product_revision then
    raise exception using errcode = 'P0001', message = 'PRODUCT_REVISION_CONFLICT';
  end if;

  select * into v_current_price
  from public.product_prices
  where product_id = p_product_id
    and valid_from <= v_effective_at
    and (valid_to is null or valid_to > v_effective_at)
  order by valid_from desc
  limit 1
  for update;

  if found and v_current_price.amount_cents = p_amount_cents then
    raise exception using errcode = 'P0001', message = 'PRODUCT_PRICE_UNCHANGED';
  end if;

  select valid_from into v_next_valid_from
  from public.product_prices
  where product_id = p_product_id and valid_from > v_effective_at
  order by valid_from
  limit 1;

  if found then
    null;
  else
    v_next_valid_from := null;
  end if;

  if v_current_price.id is not null then
    update public.product_prices
    set valid_to = v_effective_at
    where id = v_current_price.id;
  end if;

  insert into public.product_prices (product_id, amount_cents, valid_from, valid_to, created_by)
  values (p_product_id, p_amount_cents, v_effective_at, v_next_valid_from, v_actor)
  returning * into v_price;

  update public.products
  set revision = revision + 1
  where id = p_product_id
  returning * into v_product;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    'catalog.product_price.set', v_actor, 'product_price', v_price.id::text, p_correlation_id,
    jsonb_build_object('reason', p_reason, 'product_id', p_product_id,
      'product_revision_before', v_before_product.revision, 'product_revision_after', v_product.revision,
      'previous_price', case when v_current_price.id is null then null else to_jsonb(v_current_price) end,
      'price', to_jsonb(v_price))
  );

  v_result := jsonb_build_object(
    'id', v_price.id, 'productId', v_price.product_id, 'amountCents', v_price.amount_cents,
    'validFrom', v_price.valid_from, 'validTo', v_price.valid_to,
    'previousPriceId', v_current_price.id, 'productRevision', v_product.revision,
    'correlationId', p_correlation_id
  );
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'product_price', v_price.id::text);
  return v_result;
end;
$$;

revoke all on function public.set_catalog_product_price(uuid,integer,bigint,text,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_catalog_product_price(uuid,integer,bigint,text,text,uuid)
  to authenticated;

comment on function public.set_catalog_product_price(uuid,integer,bigint,text,text,uuid)
  is 'CAT-001: closes only the active validity interval and appends an audited, idempotent integer-cent price.';
