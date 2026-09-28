-- PROMO-001/PROMO-004/PROMO-005: COMBO_MIX ("cookie + brownie por R$ 20"). A combo is a set of distinct
-- products priced together; its discount is split across its lines proportionally to their full value.

create table public.promotion_combo_rules (
  promotion_id uuid primary key references public.promotions(id) on delete restrict,
  rule_type public.promotion_rule_type not null default 'COMBO_MIX' check (rule_type = 'COMBO_MIX'),
  combo_price_cents bigint not null check (combo_price_cents between 0 and 9007199254740991),
  max_combos_per_cart integer check (max_combos_per_cart is null or max_combos_per_cart >= 1),
  created_at timestamptz not null default now()
);

create table public.promotion_combo_components (
  promotion_id uuid not null references public.promotion_combo_rules(promotion_id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity between 1 and 1000),
  primary key (promotion_id, product_id)
);

create or replace function private.assert_single_promotion_rule()
returns trigger language plpgsql set search_path='' as $$
begin
  if (tg_table_name <> 'promotion_quantity_price_rules'
      and exists(select 1 from public.promotion_quantity_price_rules where promotion_id=new.promotion_id))
    or (tg_table_name <> 'promotion_percentage_rules'
      and exists(select 1 from public.promotion_percentage_rules where promotion_id=new.promotion_id))
    or (tg_table_name <> 'promotion_fixed_unit_price_rules'
      and exists(select 1 from public.promotion_fixed_unit_price_rules where promotion_id=new.promotion_id))
    or (tg_table_name <> 'promotion_buy_pay_rules'
      and exists(select 1 from public.promotion_buy_pay_rules where promotion_id=new.promotion_id))
    or (tg_table_name <> 'promotion_tiered_rules'
      and exists(select 1 from public.promotion_tiered_rules where promotion_id=new.promotion_id))
    or (tg_table_name <> 'promotion_combo_rules'
      and exists(select 1 from public.promotion_combo_rules where promotion_id=new.promotion_id)) then
    raise exception using errcode='P0001',message='PROMOTION_RULE_TYPE_CONFLICT';
  end if;
  return new;
end;
$$;

create trigger promotion_combo_rule_single before insert on public.promotion_combo_rules
for each row execute function private.assert_single_promotion_rule();
create trigger promotion_combo_rules_prevent_hard_delete before delete on public.promotion_combo_rules
for each row execute function private.prevent_promotion_hard_delete();
create trigger promotion_combo_components_prevent_hard_delete before delete on public.promotion_combo_components
for each row execute function private.prevent_promotion_hard_delete();

alter table public.promotion_combo_rules enable row level security;
alter table public.promotion_combo_components enable row level security;
revoke all on public.promotion_combo_rules from public,anon,authenticated,service_role;
revoke all on public.promotion_combo_components from public,anon,authenticated,service_role;
grant select on public.promotion_combo_rules to anon,authenticated;
grant select on public.promotion_combo_components to anon,authenticated;
create policy promotion_combo_rules_public_current_read on public.promotion_combo_rules
for select to anon,authenticated using (exists(
  select 1 from public.promotions where promotions.id=promotion_combo_rules.promotion_id
    and promotions.active and promotions.publicable and not promotions.cumulative
    and promotions.valid_from<=now() and (promotions.valid_to is null or promotions.valid_to>now())
));
create policy promotion_combo_rules_manager_read on public.promotion_combo_rules
for select to authenticated using ((select public.has_permission('catalog.manage')));
create policy promotion_combo_components_public_current_read on public.promotion_combo_components
for select to anon,authenticated using (exists(
  select 1 from public.promotions where promotions.id=promotion_combo_components.promotion_id
    and promotions.active and promotions.publicable and not promotions.cumulative
    and promotions.valid_from<=now() and (promotions.valid_to is null or promotions.valid_to>now())
));
create policy promotion_combo_components_manager_read on public.promotion_combo_components
for select to authenticated using ((select public.has_permission('catalog.manage')));

create or replace function private.promotion_rule_document(p_promotion_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(
    (select jsonb_build_object('type',rule.rule_type,'groupQuantity',rule.group_quantity,
      'groupPriceCents',rule.group_price_cents,'maxGroupsPerLine',rule.max_groups_per_line)
      from public.promotion_quantity_price_rules rule where rule.promotion_id=p_promotion_id),
    (select jsonb_build_object('type',rule.rule_type,'percentageBasisPoints',rule.percentage_basis_points)
      from public.promotion_percentage_rules rule where rule.promotion_id=p_promotion_id),
    (select jsonb_build_object('type',rule.rule_type,'fixedUnitPriceCents',rule.fixed_unit_price_cents)
      from public.promotion_fixed_unit_price_rules rule where rule.promotion_id=p_promotion_id),
    (select jsonb_build_object('type',rule.rule_type,'buyQuantity',rule.buy_quantity,
      'payQuantity',rule.pay_quantity,'maxGroupsPerLine',rule.max_groups_per_line)
      from public.promotion_buy_pay_rules rule where rule.promotion_id=p_promotion_id),
    (select jsonb_build_object('type',rule.rule_type,'tiers',coalesce((select jsonb_agg(jsonb_build_object(
        'minQuantity',tier.min_quantity,'percentageBasisPoints',tier.percentage_basis_points) order by tier.min_quantity)
        from public.promotion_tiered_rule_tiers tier where tier.promotion_id=rule.promotion_id),'[]'::jsonb))
      from public.promotion_tiered_rules rule where rule.promotion_id=p_promotion_id),
    (select jsonb_build_object('type',rule.rule_type,'components',coalesce((select jsonb_agg(jsonb_build_object(
        'productId',component.product_id,'quantity',component.quantity) order by component.product_id)
        from public.promotion_combo_components component where component.promotion_id=rule.promotion_id),'[]'::jsonb),
        'comboPriceCents',rule.combo_price_cents,'maxCombosPerCart',rule.max_combos_per_cart)
      from public.promotion_combo_rules rule where rule.promotion_id=p_promotion_id)
  );
$$;

-- Returns the canonical rule document or raises INVALID_PROMOTION; unknown keys are rejected.
create or replace function private.normalize_promotion_rule(p_rule jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_type text; v_keys text[]; v_buy bigint; v_tier jsonb; v_min bigint; v_bps bigint;
  v_previous_min bigint; v_previous_bps bigint; v_items jsonb:='[]'::jsonb; v_component jsonb; v_product text;
begin
  if p_rule is null or jsonb_typeof(p_rule)<>'object' or jsonb_typeof(p_rule->'type') is distinct from 'string' then
    raise exception using errcode='22023',message='INVALID_PROMOTION';
  end if;
  v_type:=p_rule->>'type';
  v_keys:=case v_type
    when 'QUANTIDADE_PRECO' then array['groupPriceCents','groupQuantity','maxGroupsPerLine','type']
    when 'PERCENTUAL' then array['percentageBasisPoints','type']
    when 'VALOR_FIXO_UNITARIO' then array['fixedUnitPriceCents','type']
    when 'LEVE_PAGUE' then array['buyQuantity','maxGroupsPerLine','payQuantity','type']
    when 'ESCALONADA' then array['tiers','type']
    when 'COMBO_MIX' then array['comboPriceCents','components','maxCombosPerCart','type']
    else null end;
  if v_keys is null or v_keys<>(select array_agg(key order by key) from jsonb_object_keys(p_rule) key) then
    raise exception using errcode='22023',message='INVALID_PROMOTION';
  end if;
  if v_type='QUANTIDADE_PRECO' then
    return jsonb_build_object('type',v_type,
      'groupQuantity',private.promotion_rule_integer(p_rule,'groupQuantity',2,2147483647,false),
      'groupPriceCents',private.promotion_rule_integer(p_rule,'groupPriceCents',0,9007199254740991,false),
      'maxGroupsPerLine',private.promotion_rule_integer(p_rule,'maxGroupsPerLine',1,2147483647,true));
  elsif v_type='PERCENTUAL' then
    return jsonb_build_object('type',v_type,
      'percentageBasisPoints',private.promotion_rule_integer(p_rule,'percentageBasisPoints',1,9999,false));
  elsif v_type='VALOR_FIXO_UNITARIO' then
    return jsonb_build_object('type',v_type,
      'fixedUnitPriceCents',private.promotion_rule_integer(p_rule,'fixedUnitPriceCents',0,9007199254740991,false));
  elsif v_type='LEVE_PAGUE' then
    v_buy:=private.promotion_rule_integer(p_rule,'buyQuantity',2,1000,false);
    return jsonb_build_object('type',v_type,'buyQuantity',v_buy,
      'payQuantity',private.promotion_rule_integer(p_rule,'payQuantity',1,v_buy-1,false),
      'maxGroupsPerLine',private.promotion_rule_integer(p_rule,'maxGroupsPerLine',1,2147483647,true));
  elsif v_type='COMBO_MIX' then
    -- 2 to 10 distinct products; stored and returned in product_id order.
    if jsonb_typeof(p_rule->'components') is distinct from 'array'
      or jsonb_array_length(p_rule->'components') not between 2 and 10 then
      raise exception using errcode='22023',message='INVALID_PROMOTION';
    end if;
    for v_component in select value from jsonb_array_elements(p_rule->'components') loop
      if jsonb_typeof(v_component)<>'object'
        or array['productId','quantity']<>(select array_agg(key order by key) from jsonb_object_keys(v_component) key)
        or jsonb_typeof(v_component->'productId') is distinct from 'string'
        or v_component->>'productId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception using errcode='22023',message='INVALID_PROMOTION';
      end if;
      v_items:=v_items||jsonb_build_array(jsonb_build_object('productId',v_component->>'productId',
        'quantity',private.promotion_rule_integer(v_component,'quantity',1,1000,false)));
    end loop;
    if (select count(distinct item->>'productId') from jsonb_array_elements(v_items) item)<>jsonb_array_length(v_items) then
      raise exception using errcode='22023',message='INVALID_PROMOTION';
    end if;
    return jsonb_build_object('type',v_type,
      'components',(select jsonb_agg(item order by (item->>'productId')::uuid) from jsonb_array_elements(v_items) item),
      'comboPriceCents',private.promotion_rule_integer(p_rule,'comboPriceCents',0,9007199254740991,false),
      'maxCombosPerCart',private.promotion_rule_integer(p_rule,'maxCombosPerCart',1,2147483647,true));
  end if;
  -- ESCALONADA: 1 to 10 tiers in ascending quantity; a larger tier must give a larger discount.
  if jsonb_typeof(p_rule->'tiers') is distinct from 'array' or jsonb_array_length(p_rule->'tiers') not between 1 and 10 then
    raise exception using errcode='22023',message='INVALID_PROMOTION';
  end if;
  for v_tier in select value from jsonb_array_elements(p_rule->'tiers') with ordinality item(value,position) order by position loop
    if jsonb_typeof(v_tier)<>'object'
      or array['minQuantity','percentageBasisPoints']<>(select array_agg(key order by key) from jsonb_object_keys(v_tier) key) then
      raise exception using errcode='22023',message='INVALID_PROMOTION';
    end if;
    v_min:=private.promotion_rule_integer(v_tier,'minQuantity',2,1000000,false);
    v_bps:=private.promotion_rule_integer(v_tier,'percentageBasisPoints',1,9999,false);
    if v_previous_min is not null and (v_min<=v_previous_min or v_bps<=v_previous_bps) then
      raise exception using errcode='22023',message='INVALID_PROMOTION';
    end if;
    v_previous_min:=v_min; v_previous_bps:=v_bps;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('minQuantity',v_min,'percentageBasisPoints',v_bps));
  end loop;
  return jsonb_build_object('type',v_type,'tiers',v_items);
end;
$$;

-- Rule persistence is isolated so new rule types only extend these two functions.
create function private.clear_promotion_rule(p_promotion_id uuid)
returns void language plpgsql set search_path='' as $$
begin
  delete from public.promotion_quantity_price_rules where promotion_id=p_promotion_id;
  delete from public.promotion_percentage_rules where promotion_id=p_promotion_id;
  delete from public.promotion_fixed_unit_price_rules where promotion_id=p_promotion_id;
  delete from public.promotion_buy_pay_rules where promotion_id=p_promotion_id;
  delete from public.promotion_tiered_rule_tiers where promotion_id=p_promotion_id;
  delete from public.promotion_combo_components where promotion_id=p_promotion_id;
end;
$$;

create function private.write_promotion_rule(p_promotion_id uuid,p_rule jsonb)
returns void language plpgsql set search_path='' as $$
begin
  case p_rule->>'type'
    when 'QUANTIDADE_PRECO' then
      insert into public.promotion_quantity_price_rules(promotion_id,group_quantity,group_price_cents,max_groups_per_line)
        values(p_promotion_id,(p_rule->>'groupQuantity')::integer,(p_rule->>'groupPriceCents')::bigint,(p_rule->>'maxGroupsPerLine')::integer);
    when 'PERCENTUAL' then
      insert into public.promotion_percentage_rules(promotion_id,percentage_basis_points)
        values(p_promotion_id,(p_rule->>'percentageBasisPoints')::integer);
    when 'VALOR_FIXO_UNITARIO' then
      insert into public.promotion_fixed_unit_price_rules(promotion_id,fixed_unit_price_cents)
        values(p_promotion_id,(p_rule->>'fixedUnitPriceCents')::bigint);
    when 'LEVE_PAGUE' then
      insert into public.promotion_buy_pay_rules(promotion_id,buy_quantity,pay_quantity,max_groups_per_line)
        values(p_promotion_id,(p_rule->>'buyQuantity')::integer,(p_rule->>'payQuantity')::integer,(p_rule->>'maxGroupsPerLine')::integer);
    when 'ESCALONADA' then
      -- The parent row is kept across revisions; only its tiers are replaced.
      insert into public.promotion_tiered_rules(promotion_id) values(p_promotion_id) on conflict (promotion_id) do nothing;
      insert into public.promotion_tiered_rule_tiers(promotion_id,min_quantity,percentage_basis_points)
        select p_promotion_id,(tier->>'minQuantity')::integer,(tier->>'percentageBasisPoints')::integer
        from jsonb_array_elements(p_rule->'tiers') tier;
    when 'COMBO_MIX' then
      insert into public.promotion_combo_rules(promotion_id,combo_price_cents,max_combos_per_cart)
        values(p_promotion_id,(p_rule->>'comboPriceCents')::bigint,(p_rule->>'maxCombosPerCart')::integer)
      on conflict (promotion_id) do update set combo_price_cents=excluded.combo_price_cents,
        max_combos_per_cart=excluded.max_combos_per_cart;
      insert into public.promotion_combo_components(promotion_id,product_id,quantity)
        select p_promotion_id,(component->>'productId')::uuid,(component->>'quantity')::integer
        from jsonb_array_elements(p_rule->'components') component;
  end case;
end;
$$;

create or replace function public.save_promotion(
  p_promotion_id uuid,p_expected_revision integer,p_code text,p_name text,p_description text,
  p_active boolean,p_publicable boolean,p_priority integer,p_cumulative boolean,
  p_valid_from timestamptz,p_valid_to timestamptz,p_global_redemption_limit bigint,
  p_per_user_redemption_limit integer,p_product_ids uuid[],p_channels public.promotion_channel[],
  p_rule jsonb,p_reason text,p_idempotency_key text,p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid(); v_claim record; v_promotion public.promotions%rowtype;
  v_rule jsonb; v_before jsonb; v_after jsonb; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('catalog.manage') then raise exception using errcode='42501',message='PROMOTION_MANAGE_FORBIDDEN'; end if;
  -- PROMO-004: cumulative and limited promotions stay closed until coupons and atomic limit consumption exist.
  if p_code is null or char_length(p_code) not between 1 and 80 or p_code<>btrim(p_code)
    or p_code!~'^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$'
    or p_name is null or char_length(p_name) not between 1 and 160 or p_name<>btrim(p_name)
    or (p_description is not null and (char_length(p_description) not between 1 and 2000 or p_description<>btrim(p_description)))
    or p_active is null or p_publicable is null or p_cumulative is null or p_cumulative
    or p_priority is null or p_priority not between 0 and 1000 or p_valid_from is null
    or (p_valid_to is not null and p_valid_to<=p_valid_from)
    or p_global_redemption_limit is not null or p_per_user_redemption_limit is not null
    or p_product_ids is null or cardinality(p_product_ids) not between 1 and 100
    or array_position(p_product_ids,null) is not null
    or cardinality(p_product_ids)<>(select count(distinct item) from unnest(p_product_ids) item)
    or p_channels is null or cardinality(p_channels) not between 1 and 3
    or array_position(p_channels,null) is not null
    or cardinality(p_channels)<>(select count(distinct item) from unnest(p_channels) item)
    or p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason<>btrim(p_reason)
    or p_correlation_id is null
    or (p_promotion_id is null and p_expected_revision is not null)
    or (p_promotion_id is not null and (p_expected_revision is null or p_expected_revision<1)) then
    raise exception using errcode='22023',message='INVALID_PROMOTION';
  end if;
  v_rule:=private.normalize_promotion_rule(p_rule);
  -- A combo's product scope is exactly its component set.
  if v_rule->>'type'='COMBO_MIX' and (select array_agg(item order by item) from unnest(p_product_ids) item)
    <>(select array_agg((component->>'productId')::uuid order by (component->>'productId')::uuid)
      from jsonb_array_elements(v_rule->'components') component) then
    raise exception using errcode='22023',message='INVALID_PROMOTION';
  end if;
  if (select count(*) from public.products where id=any(p_product_ids))<>cardinality(p_product_ids) then
    raise exception using errcode='P0002',message='PROMOTION_PRODUCT_NOT_FOUND'; end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('promotion','save',v_actor),p_idempotency_key,
    jsonb_build_object('id',p_promotion_id,'revision',p_expected_revision,'code',p_code,'name',p_name,
      'description',p_description,'active',p_active,'publicable',p_publicable,'priority',p_priority,
      'cumulative',p_cumulative,'valid_from',p_valid_from,'valid_to',p_valid_to,
      'products',p_product_ids,'channels',p_channels,'rule',v_rule,'reason',p_reason));
  if not v_claim.is_new then
    if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001',message='IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  if p_promotion_id is null then
    insert into public.promotions(code,name,description,active,publicable,priority,cumulative,valid_from,valid_to,
      global_redemption_limit,per_user_redemption_limit,created_by)
    values(p_code,p_name,p_description,p_active,p_publicable,p_priority,p_cumulative,p_valid_from,p_valid_to,
      p_global_redemption_limit,p_per_user_redemption_limit,v_actor) returning * into v_promotion;
  else
    select * into v_promotion from public.promotions where id=p_promotion_id for update;
    if not found then raise exception using errcode='P0002',message='PROMOTION_NOT_FOUND'; end if;
    if v_promotion.revision<>p_expected_revision then raise exception using errcode='P0001',message='PROMOTION_REVISION_CONFLICT'; end if;
    v_before:=private.promotion_snapshot(p_promotion_id);
    if v_before->'rule'->>'type' is distinct from v_rule->>'type' then
      raise exception using errcode='P0001',message='PROMOTION_RULE_TYPE_IMMUTABLE'; end if;
    update public.promotions set code=p_code,name=p_name,description=p_description,active=p_active,
      publicable=p_publicable,priority=p_priority,cumulative=p_cumulative,valid_from=p_valid_from,
      valid_to=p_valid_to,global_redemption_limit=p_global_redemption_limit,
      per_user_redemption_limit=p_per_user_redemption_limit,revision=revision+1
    where id=p_promotion_id returning * into v_promotion;
    perform set_config('app.promotion_command','on',true);
    delete from public.promotion_products where promotion_id=p_promotion_id;
    delete from public.promotion_channels where promotion_id=p_promotion_id;
    perform private.clear_promotion_rule(p_promotion_id);
  end if;
  insert into public.promotion_products(promotion_id,product_id)
    select v_promotion.id,item from unnest(p_product_ids) item;
  insert into public.promotion_channels(promotion_id,channel)
    select v_promotion.id,item from unnest(p_channels) item;
  perform private.write_promotion_rule(v_promotion.id,v_rule);
  perform set_config('app.promotion_command','off',true);
  v_after:=private.promotion_snapshot(v_promotion.id);
  insert into public.promotion_versions(promotion_id,revision,snapshot,actor_id,reason,correlation_id)
    values(v_promotion.id,v_promotion.revision,v_after,v_actor,p_reason,p_correlation_id);
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
    values(case when p_promotion_id is null then 'promotion.created' else 'promotion.updated' end,
      v_actor,'promotion',v_promotion.id::text,p_correlation_id,
      jsonb_build_object('reason',p_reason,'before',v_before,'after',v_after));
  insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload)
    values('promotion.changed','promotion',v_promotion.id::text,
      jsonb_build_object('promotion_id',v_promotion.id,'revision',v_promotion.revision,'active',v_promotion.active));
  v_result:=v_after||jsonb_build_object('correlationId',p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'promotion',v_promotion.id::text);
  return v_result;
end;
$$;

-- PROMO-005: largest-remainder split of a combo discount; ties by higher value, then product_id.
create function private.allocate_combo_discount(p_discount bigint,p_shares jsonb)
returns jsonb language sql immutable set search_path='' as $$
  with shares as (
    select (share->>'product_id')::uuid product_id,(share->>'value')::numeric value from jsonb_array_elements(p_shares) share
  ), totals as (select sum(value) total from shares),
  parts as (
    select shares.product_id,shares.value,floor(p_discount::numeric*shares.value/totals.total) floor_part,
      mod(p_discount::numeric*shares.value,totals.total) remainder
    from shares,totals
  ), ranked as (
    select parts.*,row_number() over (order by remainder desc,value desc,product_id) position,
      p_discount-sum(floor_part) over () leftover
    from parts
  )
  select jsonb_object_agg(product_id::text,(floor_part+case when position<=leftover then 1 else 0 end)::bigint) from ranked;
$$;

-- PROMO-004: line rules pick one winner per line; combos then compete for their component lines.
create or replace function private.price_sale_items(
  p_channel public.promotion_channel,p_items jsonb
)
returns jsonb language plpgsql set search_path='' as $$
declare
  v_item record; v_candidate record; v_combo record; v_component jsonb;
  v_lines jsonb:='{}'::jsonb; v_order uuid[]:='{}'; v_combos jsonb:='{}'::jsonb;
  v_quoted_at timestamptz; v_found boolean; v_result jsonb; v_line jsonb; v_product uuid;
  v_amount bigint; v_best_id uuid; v_best_priority integer; v_best_total bigint; v_best_result jsonb;
  v_count bigint; v_discount bigint; v_with bigint; v_without bigint; v_line_priority integer; v_line_min_id uuid;
  v_shares jsonb; v_allocation jsonb; v_share bigint; v_wins boolean;
  v_original_total bigint:=0; v_discount_total bigint:=0; v_total bigint:=0; v_rounded boolean:=false;
  v_output jsonb:='[]'::jsonb; v_snapshot jsonb; v_line_discount bigint; v_effective bigint;
begin
  for v_item in select item.product_id,item.quantity
    from jsonb_to_recordset(p_items) item(product_id uuid,quantity bigint) order by item.product_id
  loop
    v_found:=false; v_best_id:=null; v_best_priority:=null; v_best_total:=null; v_best_result:=null;
    for v_candidate in select * from public.get_pricing_quote_inputs_v4(p_channel,array[v_item.product_id]) loop
      if not v_found then
        v_found:=true; v_amount:=v_candidate.amount_cents;
        v_line:=jsonb_build_object('product_id',v_item.product_id,'quantity',v_item.quantity,
          'amount',v_candidate.amount_cents,'name',v_candidate.product_name);
        if v_quoted_at is null then v_quoted_at:=v_candidate.quoted_at;
        elsif v_quoted_at<>v_candidate.quoted_at then raise exception using errcode='P0001',message='PRICING_INSTANT_MISMATCH'; end if;
      end if;
      continue when v_candidate.promotion_id is null;
      if v_candidate.rule->>'type'='COMBO_MIX' then
        v_combos:=v_combos||jsonb_build_object(v_candidate.promotion_id::text,
          jsonb_build_object('priority',v_candidate.priority,'rule',v_candidate.rule));
        continue;
      end if;
      -- Same fail-closed contract as the domain: a configured promotion must never charge more than the base price.
      if v_candidate.rule->>'type'='QUANTIDADE_PRECO'
        and (v_candidate.rule->>'groupPriceCents')::bigint>=v_amount*(v_candidate.rule->>'groupQuantity')::bigint then
        raise exception using errcode='P0001',message='INVALID_PROMOTION_GROUP_PRICE'; end if;
      if v_candidate.rule->>'type'='VALOR_FIXO_UNITARIO'
        and (v_candidate.rule->>'fixedUnitPriceCents')::bigint>=v_amount then
        raise exception using errcode='P0001',message='INVALID_PROMOTION_FIXED_PRICE'; end if;
      v_result:=private.apply_promotion_rule(v_amount,v_item.quantity,v_candidate.rule);
      continue when v_result is null;
      if v_best_id is null or v_candidate.priority>v_best_priority
        or (v_candidate.priority=v_best_priority and (v_result->>'total')::bigint<v_best_total)
        or (v_candidate.priority=v_best_priority and (v_result->>'total')::bigint=v_best_total and v_candidate.promotion_id<v_best_id) then
        v_best_id:=v_candidate.promotion_id; v_best_priority:=v_candidate.priority;
        v_best_total:=(v_result->>'total')::bigint; v_best_result:=v_result||jsonb_build_object('type',v_candidate.rule->>'type');
      end if;
    end loop;
    if not v_found then raise exception using errcode='P0001',message='PRODUCT_UNAVAILABLE'; end if;
    v_line:=v_line||jsonb_build_object('sku',(select sku from public.products where id=v_item.product_id),
      'subtotal',v_amount*v_item.quantity,
      'best_id',v_best_id,'best_priority',v_best_priority,
      'total',coalesce(v_best_total,v_amount*v_item.quantity),'result',v_best_result);
    v_lines:=v_lines||jsonb_build_object(v_item.product_id::text,v_line);
    v_order:=v_order||v_item.product_id;
  end loop;

  -- Combos by priority, larger saving per combo, then promotion_id.
  for v_combo in
    select candidate.id,candidate.priority,candidate.rule,candidate.present,candidate.full_value
    from (
      select entry.key::uuid id,(entry.value->>'priority')::integer priority,entry.value->'rule' rule,
        (select bool_and(v_lines ? (component->>'productId')) from jsonb_array_elements(entry.value->'rule'->'components') component) present,
        (select sum(((v_lines->(component->>'productId'))->>'amount')::bigint*(component->>'quantity')::bigint)
          from jsonb_array_elements(entry.value->'rule'->'components') component) full_value
      from jsonb_each(v_combos) entry
    ) candidate
    where candidate.present
    order by candidate.priority desc,candidate.full_value-(candidate.rule->>'comboPriceCents')::bigint desc,candidate.id
  loop
    if (v_combo.rule->>'comboPriceCents')::bigint>=v_combo.full_value then
      raise exception using errcode='P0001',message='INVALID_PROMOTION_COMBO_PRICE'; end if;
    continue when exists(select 1 from jsonb_array_elements(v_combo.rule->'components') component
      where (v_lines->(component->>'productId'))->>'combo' is not null);
    select min(((v_lines->(component->>'productId'))->>'quantity')::bigint/(component->>'quantity')::bigint) into v_count
    from jsonb_array_elements(v_combo.rule->'components') component;
    v_count:=least(v_count,coalesce((v_combo.rule->>'maxCombosPerCart')::bigint,v_count));
    continue when v_count=0;
    v_discount:=(v_combo.full_value-(v_combo.rule->>'comboPriceCents')::bigint)*v_count;
    select sum(((v_lines->(component->>'productId'))->>'subtotal')::bigint)-v_discount,
      sum(((v_lines->(component->>'productId'))->>'total')::bigint),
      max(((v_lines->(component->>'productId'))->>'best_priority')::integer)
    into v_with,v_without,v_line_priority
    from jsonb_array_elements(v_combo.rule->'components') component;
    -- uuid has no min(); the ordered subquery keeps the byte-wise order used by the domain.
    select ((v_lines->(component->>'productId'))->>'best_id')::uuid into v_line_min_id
    from jsonb_array_elements(v_combo.rule->'components') component
    where (v_lines->(component->>'productId'))->>'best_id' is not null
    order by 1 limit 1;
    v_wins:=v_line_priority is null or v_combo.priority>v_line_priority
      or (v_combo.priority=v_line_priority and (v_with<v_without or (v_with=v_without and v_combo.id<v_line_min_id)));
    continue when not v_wins;
    select jsonb_agg(jsonb_build_object('product_id',component->>'productId',
      'value',((v_lines->(component->>'productId'))->>'amount')::bigint*(component->>'quantity')::bigint*v_count))
    into v_shares from jsonb_array_elements(v_combo.rule->'components') component;
    v_allocation:=private.allocate_combo_discount(v_discount,v_shares);
    for v_component in select value from jsonb_array_elements(v_combo.rule->'components') loop
      v_share:=(v_allocation->>(v_component->>'productId'))::bigint;
      v_lines:=jsonb_set(v_lines,array[v_component->>'productId'],(v_lines->(v_component->>'productId'))||jsonb_build_object(
        'combo',jsonb_build_object('promotion_id',v_combo.id,'type','COMBO_MIX','priority',v_combo.priority,
          'combo_price_cents',(v_combo.rule->>'comboPriceCents')::bigint,'combos',v_count,
          'component_quantity',(v_component->>'quantity')::bigint*v_count,'savings_cents',v_share)));
    end loop;
  end loop;

  foreach v_product in array v_order loop
    v_line:=v_lines->(v_product::text);
    if v_line ? 'combo' then
      v_line_discount:=(v_line->'combo'->>'savings_cents')::bigint;
      v_effective:=(v_line->>'subtotal')::bigint-v_line_discount; v_snapshot:=v_line->'combo';
    elsif v_line->>'best_id' is not null then
      v_effective:=(v_line->>'total')::bigint; v_line_discount:=(v_line->>'subtotal')::bigint-v_effective;
      v_rounded:=v_rounded or (v_line->'result'->>'rounded')::boolean;
      v_snapshot:=jsonb_build_object('promotion_id',(v_line->>'best_id')::uuid,'type',v_line->'result'->>'type',
        'priority',(v_line->>'best_priority')::integer)||(v_line->'result'->'detail')||jsonb_build_object('savings_cents',v_line_discount);
    else
      v_effective:=(v_line->>'subtotal')::bigint; v_line_discount:=0; v_snapshot:=null;
    end if;
    if (v_line->>'subtotal')::bigint>9007199254740991 or v_effective>9007199254740991 then
      raise exception using errcode='22003',message='MONEY_OVERFLOW'; end if;
    v_original_total:=v_original_total+(v_line->>'subtotal')::bigint;
    v_discount_total:=v_discount_total+v_line_discount; v_total:=v_total+v_effective;
    if v_original_total>9007199254740991 or v_total>9007199254740991 then
      raise exception using errcode='22003',message='MONEY_OVERFLOW'; end if;
    v_output:=v_output||jsonb_build_array(jsonb_build_object(
      'product_id',v_product,'product_sku',v_line->>'sku','product_name',v_line->>'name',
      'quantity',(v_line->>'quantity')::bigint,'unit_price_cents',(v_line->>'amount')::bigint,
      'original_subtotal_cents',(v_line->>'subtotal')::bigint,'discount_cents',v_line_discount,
      'total_cents',v_effective,'promotion_id',(v_snapshot->>'promotion_id')::uuid,
      'promotion_snapshot',v_snapshot));
  end loop;
  return jsonb_build_object('quoted_at',v_quoted_at,'currency','BRL',
    'rounding',case when v_rounded then 'FLOOR_PER_UNIT' else 'NONE' end,
    'lines',v_output,'original_total_cents',v_original_total,
    'discount_total_cents',v_discount_total,'total_cents',v_total);
end;
$$;

revoke all on function private.allocate_combo_discount(bigint,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.clear_promotion_rule(uuid) from public,anon,authenticated,service_role;
revoke all on function private.write_promotion_rule(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.promotion_rule_document(uuid) from public,anon,authenticated,service_role;
revoke all on function private.normalize_promotion_rule(jsonb) from public,anon,authenticated,service_role;
revoke all on function private.assert_single_promotion_rule() from public,anon,authenticated,service_role;

comment on table public.promotion_combo_rules is 'COMBO_MIX rules: a set of distinct products sold together for combo_price_cents.';
comment on function private.allocate_combo_discount(bigint,jsonb) is 'PROMO-005: proportional split with largest remainder, ties by value then product_id.';
