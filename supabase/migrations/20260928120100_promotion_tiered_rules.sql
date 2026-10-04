-- PROMO-001/PROMO-003/PROMO-004: ESCALONADA ("3+ unidades = 8%") plus one rule document and one
-- pricing function shared by every product rule, so each new type does not add quote columns.

create table public.promotion_tiered_rules (
  promotion_id uuid primary key references public.promotions(id) on delete restrict,
  rule_type public.promotion_rule_type not null default 'ESCALONADA' check (rule_type = 'ESCALONADA'),
  created_at timestamptz not null default now()
);

create table public.promotion_tiered_rule_tiers (
  promotion_id uuid not null references public.promotion_tiered_rules(promotion_id) on delete restrict,
  min_quantity integer not null check (min_quantity between 2 and 1000000),
  percentage_basis_points integer not null check (percentage_basis_points between 1 and 9999),
  primary key (promotion_id, min_quantity)
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
      and exists(select 1 from public.promotion_tiered_rules where promotion_id=new.promotion_id)) then
    raise exception using errcode='P0001',message='PROMOTION_RULE_TYPE_CONFLICT';
  end if;
  return new;
end;
$$;

create trigger promotion_tiered_rule_single before insert on public.promotion_tiered_rules
for each row execute function private.assert_single_promotion_rule();
create trigger promotion_tiered_rules_prevent_hard_delete before delete on public.promotion_tiered_rules
for each row execute function private.prevent_promotion_hard_delete();
create trigger promotion_tiered_rule_tiers_prevent_hard_delete before delete on public.promotion_tiered_rule_tiers
for each row execute function private.prevent_promotion_hard_delete();

alter table public.promotion_tiered_rules enable row level security;
alter table public.promotion_tiered_rule_tiers enable row level security;
revoke all on public.promotion_tiered_rules from public,anon,authenticated,service_role;
revoke all on public.promotion_tiered_rule_tiers from public,anon,authenticated,service_role;
grant select on public.promotion_tiered_rules to anon,authenticated;
grant select on public.promotion_tiered_rule_tiers to anon,authenticated;
create policy promotion_tiered_rules_public_current_read on public.promotion_tiered_rules
for select to anon,authenticated using (exists(
  select 1 from public.promotions where promotions.id=promotion_tiered_rules.promotion_id
    and promotions.active and promotions.publicable and not promotions.cumulative
    and promotions.valid_from<=now() and (promotions.valid_to is null or promotions.valid_to>now())
));
create policy promotion_tiered_rules_manager_read on public.promotion_tiered_rules
for select to authenticated using ((select public.has_permission('catalog.manage')));
create policy promotion_tiered_rule_tiers_public_current_read on public.promotion_tiered_rule_tiers
for select to anon,authenticated using (exists(
  select 1 from public.promotions where promotions.id=promotion_tiered_rule_tiers.promotion_id
    and promotions.active and promotions.publicable and not promotions.cumulative
    and promotions.valid_from<=now() and (promotions.valid_to is null or promotions.valid_to>now())
));
create policy promotion_tiered_rule_tiers_manager_read on public.promotion_tiered_rule_tiers
for select to authenticated using ((select public.has_permission('catalog.manage')));

-- Canonical rule document of a promotion (same shape as the administration contract).
create function private.promotion_rule_document(p_promotion_id uuid)
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
      from public.promotion_tiered_rules rule where rule.promotion_id=p_promotion_id)
  );
$$;

create or replace function private.promotion_snapshot(p_promotion_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'id', promotion.id, 'revision', promotion.revision, 'code', promotion.code,
    'name', promotion.name, 'description', promotion.description, 'active', promotion.active,
    'publicable', promotion.publicable, 'priority', promotion.priority,
    'cumulative', promotion.cumulative, 'validFrom', promotion.valid_from,
    'validTo', promotion.valid_to, 'globalRedemptionLimit', promotion.global_redemption_limit,
    'perUserRedemptionLimit', promotion.per_user_redemption_limit,
    'productIds', coalesce((select jsonb_agg(scope.product_id order by scope.product_id)
      from public.promotion_products scope where scope.promotion_id=promotion.id),'[]'::jsonb),
    'channels', coalesce((select jsonb_agg(scope.channel order by scope.channel)
      from public.promotion_channels scope where scope.promotion_id=promotion.id),'[]'::jsonb),
    'rule', private.promotion_rule_document(promotion.id)
  ) from public.promotions promotion where promotion.id=p_promotion_id;
$$;

-- v4 returns the canonical rule document instead of one column per rule field.
create function public.get_pricing_quote_inputs_v4(
  p_channel public.promotion_channel,p_product_ids uuid[]
)
returns table(
  quoted_at timestamptz,product_id uuid,product_name text,amount_cents bigint,
  promotion_id uuid,priority integer,rule jsonb
)
language plpgsql security definer set search_path='' as $$
declare v_quoted_at timestamptz:=statement_timestamp();
begin
  if p_channel not in ('PORTAL','PDV') then raise exception using errcode='22023',message='PRICING_CHANNEL_UNSUPPORTED'; end if;
  if p_product_ids is null or cardinality(p_product_ids) not between 1 and 100
    or array_position(p_product_ids,null) is not null
    or cardinality(p_product_ids)<>(select count(distinct value) from unnest(p_product_ids) value) then
    raise exception using errcode='22023',message='PRICING_PRODUCTS_INVALID';
  end if;
  if p_channel='PDV' and (auth.uid() is null or not public.has_permission('sales.create')) then
    raise exception using errcode='42501',message='PRICING_PDV_FORBIDDEN';
  end if;
  return query
  select v_quoted_at,product.id,product.name,price.amount_cents,promo.id,promo.priority,promo.rule
  from public.products product
  join public.categories category on category.id=product.category_id and category.active
  join lateral(
    select candidate.amount_cents from public.product_prices candidate
    where candidate.product_id=product.id and candidate.valid_from<=v_quoted_at
      and (candidate.valid_to is null or candidate.valid_to>v_quoted_at)
    order by candidate.valid_from desc limit 1
  ) price on true
  left join lateral(
    select candidate.id,candidate.priority,private.promotion_rule_document(candidate.id) rule
    from public.promotion_products scope
    join public.promotions candidate on candidate.id=scope.promotion_id
    where scope.product_id=product.id and candidate.active and candidate.publicable
      and not candidate.cumulative
      and candidate.valid_from<=v_quoted_at and (candidate.valid_to is null or candidate.valid_to>v_quoted_at)
      and candidate.global_redemption_limit is null and candidate.per_user_redemption_limit is null
      and exists(select 1 from public.promotion_channels channel_scope
        where channel_scope.promotion_id=candidate.id and channel_scope.channel=p_channel)
      and private.promotion_rule_document(candidate.id) is not null
  ) promo on true
  where product.id=any(p_product_ids) and product.active
    and case p_channel when 'PORTAL' then product.published when 'PDV' then product.sellable_pdv else false end
  order by product.id,promo.priority desc nulls last,promo.id;
end;
$$;

revoke all on function public.get_pricing_quote_inputs_v4(public.promotion_channel,uuid[])
from public,anon,authenticated,service_role;
grant execute on function public.get_pricing_quote_inputs_v4(public.promotion_channel,uuid[])
to anon,authenticated;

-- Prices one line with one rule. Returns null when the rule yields no saving (not applied), mirroring the domain.
-- Result: {total, rounded, detail} where detail is the rule-specific part of the stored snapshot.
create function private.apply_promotion_rule(p_amount bigint,p_quantity bigint,p_rule jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare
  v_type text:=p_rule->>'type'; v_group bigint; v_pay bigint; v_max bigint; v_groups bigint;
  v_bps bigint; v_unit bigint; v_total bigint; v_rounded boolean:=false; v_detail jsonb; v_tier jsonb;
begin
  if v_type='QUANTIDADE_PRECO' then
    v_group:=(p_rule->>'groupQuantity')::bigint; v_max:=(p_rule->>'maxGroupsPerLine')::bigint;
    v_groups:=least(p_quantity/v_group,coalesce(v_max,p_quantity/v_group));
    if v_groups=0 then return null; end if;
    v_total:=(p_rule->>'groupPriceCents')::bigint*v_groups+p_amount*(p_quantity-v_groups*v_group);
    v_detail:=jsonb_build_object('group_quantity',v_group,'group_price_cents',(p_rule->>'groupPriceCents')::bigint,
      'max_groups_per_line',v_max,'groups',v_groups,'promoted_quantity',v_groups*v_group,
      'remainder_quantity',p_quantity-v_groups*v_group);
  elsif v_type='LEVE_PAGUE' then
    v_group:=(p_rule->>'buyQuantity')::bigint; v_pay:=(p_rule->>'payQuantity')::bigint;
    v_max:=(p_rule->>'maxGroupsPerLine')::bigint;
    v_groups:=least(p_quantity/v_group,coalesce(v_max,p_quantity/v_group));
    v_total:=p_amount*(p_quantity-v_groups*(v_group-v_pay));
    v_detail:=jsonb_build_object('buy_quantity',v_group,'pay_quantity',v_pay,'max_groups_per_line',v_max,
      'groups',v_groups,'free_quantity',v_groups*(v_group-v_pay));
  elsif v_type='PERCENTUAL' then
    v_bps:=(p_rule->>'percentageBasisPoints')::bigint;
    v_unit:=floor((p_amount*(10000-v_bps))::numeric/10000)::bigint; v_total:=v_unit*p_quantity; v_rounded:=true;
    v_detail:=jsonb_build_object('percentage_basis_points',v_bps,'discounted_unit_price_cents',v_unit);
  elsif v_type='VALOR_FIXO_UNITARIO' then
    v_unit:=(p_rule->>'fixedUnitPriceCents')::bigint; v_total:=v_unit*p_quantity;
    v_detail:=jsonb_build_object('fixed_unit_price_cents',v_unit);
  elsif v_type='ESCALONADA' then
    select tier into v_tier from jsonb_array_elements(p_rule->'tiers') tier
    where (tier->>'minQuantity')::bigint<=p_quantity order by (tier->>'minQuantity')::bigint desc limit 1;
    if v_tier is null then return null; end if;
    v_bps:=(v_tier->>'percentageBasisPoints')::bigint;
    v_unit:=floor((p_amount*(10000-v_bps))::numeric/10000)::bigint; v_total:=v_unit*p_quantity; v_rounded:=true;
    v_detail:=jsonb_build_object('min_quantity',(v_tier->>'minQuantity')::bigint,'percentage_basis_points',v_bps,
      'discounted_unit_price_cents',v_unit);
  else
    raise exception using errcode='P0001',message='PROMOTION_RULE_UNSUPPORTED';
  end if;
  if v_total>=p_amount*p_quantity then return null; end if;
  return jsonb_build_object('total',v_total,'rounded',v_rounded,'detail',v_detail);
end;
$$;

-- PROMO-004: one winning rule per line by priority, lowest customer total, then promotion_id.
create or replace function private.price_sale_items(
  p_channel public.promotion_channel,p_items jsonb
)
returns jsonb language plpgsql set search_path='' as $$
declare
  v_item record; v_candidate record; v_product_sku text; v_product_name text; v_amount bigint;
  v_quoted_at timestamptz; v_found boolean; v_result jsonb;
  v_best_id uuid; v_best_priority integer; v_best_total bigint; v_best_result jsonb;
  v_original_subtotal bigint; v_effective_subtotal bigint; v_discount bigint;
  v_original_total bigint:=0; v_discount_total bigint:=0; v_total bigint:=0;
  v_promotion_snapshot jsonb; v_lines jsonb:='[]'::jsonb; v_rounded boolean:=false;
begin
  for v_item in select item.product_id,item.quantity
    from jsonb_to_recordset(p_items) item(product_id uuid,quantity bigint) order by item.product_id
  loop
    v_found:=false; v_best_id:=null; v_best_priority:=null; v_best_total:=null; v_best_result:=null;
    for v_candidate in select * from public.get_pricing_quote_inputs_v4(p_channel,array[v_item.product_id]) loop
      if not v_found then
        v_found:=true; v_amount:=v_candidate.amount_cents; v_product_name:=v_candidate.product_name;
        if v_quoted_at is null then v_quoted_at:=v_candidate.quoted_at;
        elsif v_quoted_at<>v_candidate.quoted_at then raise exception using errcode='P0001',message='PRICING_INSTANT_MISMATCH'; end if;
      end if;
      continue when v_candidate.promotion_id is null;
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
    select sku into v_product_sku from public.products where id=v_item.product_id;

    v_original_subtotal:=v_amount*v_item.quantity;
    if v_best_id is null then
      v_effective_subtotal:=v_original_subtotal; v_discount:=0; v_promotion_snapshot:=null;
    else
      v_effective_subtotal:=v_best_total; v_discount:=v_original_subtotal-v_effective_subtotal;
      v_rounded:=v_rounded or (v_best_result->>'rounded')::boolean;
      v_promotion_snapshot:=jsonb_build_object('promotion_id',v_best_id,'type',v_best_result->>'type',
        'priority',v_best_priority)||(v_best_result->'detail')||jsonb_build_object('savings_cents',v_discount);
    end if;

    if v_original_subtotal>9007199254740991 or v_effective_subtotal>9007199254740991 then
      raise exception using errcode='22003',message='MONEY_OVERFLOW'; end if;
    v_original_total:=v_original_total+v_original_subtotal;
    v_discount_total:=v_discount_total+v_discount; v_total:=v_total+v_effective_subtotal;
    if v_original_total>9007199254740991 or v_total>9007199254740991 then
      raise exception using errcode='22003',message='MONEY_OVERFLOW'; end if;
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object(
      'product_id',v_item.product_id,'product_sku',v_product_sku,'product_name',v_product_name,
      'quantity',v_item.quantity,'unit_price_cents',v_amount,
      'original_subtotal_cents',v_original_subtotal,'discount_cents',v_discount,
      'total_cents',v_effective_subtotal,'promotion_id',v_best_id,
      'promotion_snapshot',v_promotion_snapshot));
  end loop;
  return jsonb_build_object('quoted_at',v_quoted_at,'currency','BRL',
    'rounding',case when v_rounded then 'FLOOR_PER_UNIT' else 'NONE' end,
    'lines',v_lines,'original_total_cents',v_original_total,
    'discount_total_cents',v_discount_total,'total_cents',v_total);
end;
$$;

-- Returns the canonical rule document or raises INVALID_PROMOTION; unknown keys are rejected.
create or replace function private.normalize_promotion_rule(p_rule jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_type text; v_keys text[]; v_buy bigint; v_tier jsonb; v_min bigint; v_bps bigint;
  v_previous_min bigint; v_previous_bps bigint; v_tiers jsonb:='[]'::jsonb;
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
    v_tiers:=v_tiers||jsonb_build_array(jsonb_build_object('minQuantity',v_min,'percentageBasisPoints',v_bps));
  end loop;
  return jsonb_build_object('type',v_type,'tiers',v_tiers);
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
    delete from public.promotion_quantity_price_rules where promotion_id=p_promotion_id;
    delete from public.promotion_percentage_rules where promotion_id=p_promotion_id;
    delete from public.promotion_fixed_unit_price_rules where promotion_id=p_promotion_id;
    delete from public.promotion_buy_pay_rules where promotion_id=p_promotion_id;
    delete from public.promotion_tiered_rule_tiers where promotion_id=p_promotion_id;
  end if;
  insert into public.promotion_products(promotion_id,product_id)
    select v_promotion.id,item from unnest(p_product_ids) item;
  insert into public.promotion_channels(promotion_id,channel)
    select v_promotion.id,item from unnest(p_channels) item;
  case v_rule->>'type'
    when 'QUANTIDADE_PRECO' then
      insert into public.promotion_quantity_price_rules(promotion_id,group_quantity,group_price_cents,max_groups_per_line)
        values(v_promotion.id,(v_rule->>'groupQuantity')::integer,(v_rule->>'groupPriceCents')::bigint,(v_rule->>'maxGroupsPerLine')::integer);
    when 'PERCENTUAL' then
      insert into public.promotion_percentage_rules(promotion_id,percentage_basis_points)
        values(v_promotion.id,(v_rule->>'percentageBasisPoints')::integer);
    when 'VALOR_FIXO_UNITARIO' then
      insert into public.promotion_fixed_unit_price_rules(promotion_id,fixed_unit_price_cents)
        values(v_promotion.id,(v_rule->>'fixedUnitPriceCents')::bigint);
    when 'LEVE_PAGUE' then
      insert into public.promotion_buy_pay_rules(promotion_id,buy_quantity,pay_quantity,max_groups_per_line)
        values(v_promotion.id,(v_rule->>'buyQuantity')::integer,(v_rule->>'payQuantity')::integer,(v_rule->>'maxGroupsPerLine')::integer);
    else
      -- The tier parent row is kept across revisions; only its tiers are replaced.
      insert into public.promotion_tiered_rules(promotion_id) values(v_promotion.id) on conflict (promotion_id) do nothing;
      insert into public.promotion_tiered_rule_tiers(promotion_id,min_quantity,percentage_basis_points)
        select v_promotion.id,(tier->>'minQuantity')::integer,(tier->>'percentageBasisPoints')::integer
        from jsonb_array_elements(v_rule->'tiers') tier;
  end case;
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

revoke all on function private.promotion_rule_document(uuid) from public,anon,authenticated,service_role;
revoke all on function private.apply_promotion_rule(bigint,bigint,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.normalize_promotion_rule(jsonb) from public,anon,authenticated,service_role;
revoke all on function private.assert_single_promotion_rule() from public,anon,authenticated,service_role;
revoke all on function private.promotion_snapshot(uuid) from public,anon,authenticated,service_role;

comment on table public.promotion_tiered_rules is 'ESCALONADA rules; the highest reached tier applies its percentage to every unit (floored per unit).';
comment on function public.get_pricing_quote_inputs_v4(public.promotion_channel,uuid[]) is 'Resolves unlimited, non-cumulative product promotion candidates at one database instant with canonical rule documents.';
comment on function private.apply_promotion_rule(bigint,bigint,jsonb) is 'Prices one line with one rule; null when the rule yields no saving.';
