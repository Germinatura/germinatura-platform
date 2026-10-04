-- PROMO-006/PROMO-007: coupons, a redemption ledger (RESERVED/CONSUMED/RELEASED) with concurrent
-- global and per-user limits, and one pricing entry point shared by quote, checkout and reservations.

-- Coupons -------------------------------------------------------------------------------------------

create table public.promotion_coupon_rules (
  promotion_id uuid primary key references public.promotions(id) on delete restrict,
  rule_type public.promotion_rule_type not null default 'CUPOM' check (rule_type = 'CUPOM'),
  code text not null unique check (char_length(code) between 3 and 40 and code ~ '^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$'),
  discount_kind text not null check (discount_kind in ('PERCENTUAL','VALOR_FIXO')),
  percentage_basis_points integer check (percentage_basis_points between 1 and 9999),
  amount_cents bigint check (amount_cents between 1 and 9007199254740991),
  created_at timestamptz not null default now(),
  check ((discount_kind='PERCENTUAL' and percentage_basis_points is not null and amount_cents is null)
    or (discount_kind='VALOR_FIXO' and amount_cents is not null and percentage_basis_points is null))
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
      and exists(select 1 from public.promotion_combo_rules where promotion_id=new.promotion_id))
    or (tg_table_name <> 'promotion_coupon_rules'
      and exists(select 1 from public.promotion_coupon_rules where promotion_id=new.promotion_id)) then
    raise exception using errcode='P0001',message='PROMOTION_RULE_TYPE_CONFLICT';
  end if;
  return new;
end;
$$;

create trigger promotion_coupon_rule_single before insert on public.promotion_coupon_rules
for each row execute function private.assert_single_promotion_rule();
create trigger promotion_coupon_rules_prevent_hard_delete before delete on public.promotion_coupon_rules
for each row execute function private.prevent_promotion_hard_delete();

-- Coupon codes are not publicly readable; pricing reads them through security definer functions.
alter table public.promotion_coupon_rules enable row level security;
revoke all on public.promotion_coupon_rules from public,anon,authenticated,service_role;
grant select on public.promotion_coupon_rules to authenticated;
create policy promotion_coupon_rules_manager_read on public.promotion_coupon_rules
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
      from public.promotion_combo_rules rule where rule.promotion_id=p_promotion_id),
    (select jsonb_build_object('type',rule.rule_type,'code',rule.code,'discount',case rule.discount_kind
        when 'PERCENTUAL' then jsonb_build_object('kind','PERCENTUAL','percentageBasisPoints',rule.percentage_basis_points)
        else jsonb_build_object('kind','VALOR_FIXO','amountCents',rule.amount_cents) end)
      from public.promotion_coupon_rules rule where rule.promotion_id=p_promotion_id)
  );
$$;

-- Adds CUPOM to the canonical rule validation and delegates the other types to the previous rules.
create function private.normalize_coupon_rule(p_rule jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_discount jsonb:=p_rule->'discount'; v_code text:=p_rule->>'code';
begin
  if array['code','discount','type']<>(select array_agg(key order by key) from jsonb_object_keys(p_rule) key)
    or jsonb_typeof(p_rule->'code') is distinct from 'string'
    or char_length(v_code) not between 3 and 40 or v_code !~ '^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$'
    or jsonb_typeof(v_discount) is distinct from 'object' then
    raise exception using errcode='22023',message='INVALID_PROMOTION';
  end if;
  if v_discount->>'kind'='PERCENTUAL'
    and array['kind','percentageBasisPoints']=(select array_agg(key order by key) from jsonb_object_keys(v_discount) key) then
    return jsonb_build_object('type','CUPOM','code',v_code,'discount',jsonb_build_object('kind','PERCENTUAL',
      'percentageBasisPoints',private.promotion_rule_integer(v_discount,'percentageBasisPoints',1,9999,false)));
  elsif v_discount->>'kind'='VALOR_FIXO'
    and array['amountCents','kind']=(select array_agg(key order by key) from jsonb_object_keys(v_discount) key) then
    return jsonb_build_object('type','CUPOM','code',v_code,'discount',jsonb_build_object('kind','VALOR_FIXO',
      'amountCents',private.promotion_rule_integer(v_discount,'amountCents',1,9007199254740991,false)));
  end if;
  raise exception using errcode='22023',message='INVALID_PROMOTION';
end;
$$;

create or replace function private.clear_promotion_rule(p_promotion_id uuid)
returns void language plpgsql set search_path='' as $$
begin
  delete from public.promotion_quantity_price_rules where promotion_id=p_promotion_id;
  delete from public.promotion_percentage_rules where promotion_id=p_promotion_id;
  delete from public.promotion_fixed_unit_price_rules where promotion_id=p_promotion_id;
  delete from public.promotion_buy_pay_rules where promotion_id=p_promotion_id;
  delete from public.promotion_tiered_rule_tiers where promotion_id=p_promotion_id;
  delete from public.promotion_combo_components where promotion_id=p_promotion_id;
  delete from public.promotion_coupon_rules where promotion_id=p_promotion_id;
end;
$$;

create or replace function private.write_promotion_rule(p_promotion_id uuid,p_rule jsonb)
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
    when 'CUPOM' then
      insert into public.promotion_coupon_rules(promotion_id,code,discount_kind,percentage_basis_points,amount_cents)
        values(p_promotion_id,p_rule->>'code',p_rule->'discount'->>'kind',
          (p_rule->'discount'->>'percentageBasisPoints')::integer,(p_rule->'discount'->>'amountCents')::bigint);
  end case;
end;
$$;

-- Redemption ledger -----------------------------------------------------------------------------------

create type public.promotion_redemption_status as enum ('RESERVED','CONSUMED','RELEASED');

-- One use per promotion per sale (or per commercial reservation before conversion).
create table public.promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  reservation_id uuid references public.commercial_reservations(id) on delete restrict,
  customer_id uuid references public.profiles(id) on delete restrict,
  status public.promotion_redemption_status not null default 'RESERVED',
  reserved_at timestamptz not null default now(),
  consumed_at timestamptz,
  released_at timestamptz,
  check (sale_id is not null or reservation_id is not null),
  check ((status='CONSUMED')=(consumed_at is not null) and (status='RELEASED')=(released_at is not null)),
  unique (promotion_id, sale_id),
  unique (promotion_id, reservation_id)
);
create index promotion_redemptions_active_idx on public.promotion_redemptions(promotion_id,status);
create index promotion_redemptions_customer_idx on public.promotion_redemptions(promotion_id,customer_id,status);

-- Uses only move RESERVED -> CONSUMED or RESERVED -> RELEASED; nothing is deleted or rewritten.
create function private.guard_promotion_redemption_change()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception using errcode='P0001',message='IMMUTABLE_RECORD'; end if;
  if new.promotion_id<>old.promotion_id or new.customer_id is distinct from old.customer_id
    or new.reservation_id is distinct from old.reservation_id or new.reserved_at<>old.reserved_at
    or (new.sale_id is distinct from old.sale_id and (old.sale_id is not null or old.status<>'RESERVED'))
    or (new.status<>old.status and not (old.status='RESERVED' and new.status in ('CONSUMED','RELEASED'))) then
    raise exception using errcode='P0001',message='PROMOTION_REDEMPTION_TRANSITION_INVALID';
  end if;
  return new;
end;
$$;
create trigger promotion_redemptions_guard before update or delete on public.promotion_redemptions
for each row execute function private.guard_promotion_redemption_change();

alter table public.promotion_redemptions enable row level security;
revoke all on public.promotion_redemptions from public,anon,authenticated,service_role;
grant select on public.promotion_redemptions to authenticated;
create policy promotion_redemptions_manager_read on public.promotion_redemptions
for select to authenticated using ((select public.has_permission('catalog.manage')));

-- PROMO-007: capacity counts RESERVED and CONSUMED uses. A per-user limit needs an identified buyer,
-- so an anonymous PDV sale is never eligible for it.
create function private.promotion_has_capacity(p_promotion_id uuid,p_customer_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select (promotion.per_user_redemption_limit is null or (p_customer_id is not null and (
      select count(*) from public.promotion_redemptions redemption
      where redemption.promotion_id=promotion.id and redemption.customer_id=p_customer_id
        and redemption.status in ('RESERVED','CONSUMED')) < promotion.per_user_redemption_limit))
    and (promotion.global_redemption_limit is null or (
      select count(*) from public.promotion_redemptions redemption
      where redemption.promotion_id=promotion.id and redemption.status in ('RESERVED','CONSUMED'))
      < promotion.global_redemption_limit)
  from public.promotions promotion where promotion.id=p_promotion_id;
$$;

-- Sale lifecycle: confirmation consumes; cancellation or expiry before confirmation releases.
-- A use that was already CONSUMED is never released automatically (e.g. a reversed confirmed sale).
create function private.sync_sale_promotion_redemptions()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='CONFIRMED' then
    update public.promotion_redemptions set status='CONSUMED',consumed_at=clock_timestamp()
    where sale_id=new.id and status='RESERVED';
  elsif new.status='CANCELLED' then
    update public.promotion_redemptions set status='RELEASED',released_at=clock_timestamp()
    where sale_id=new.id and status='RESERVED';
  end if;
  return new;
end;
$$;
create trigger sales_promotion_redemptions after update of status on public.sales
for each row when (new.status is distinct from old.status)
execute function private.sync_sale_promotion_redemptions();

-- Commercial reservations: conversion hands the reserved uses to the sale; cancel/expiry releases them.
create function private.sync_reservation_promotion_redemptions()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='CONVERTED' then
    update public.promotion_redemptions set sale_id=new.converted_sale_id
    where reservation_id=new.id and status='RESERVED' and sale_id is null;
  elsif new.status in ('CANCELLED','EXPIRED') then
    update public.promotion_redemptions set status='RELEASED',released_at=clock_timestamp()
    where reservation_id=new.id and status='RESERVED';
  end if;
  return new;
end;
$$;
create trigger commercial_reservations_promotion_redemptions after update of status on public.commercial_reservations
for each row when (new.status is distinct from old.status)
execute function private.sync_reservation_promotion_redemptions();

-- Promotion administration: limits and coupon cumulativity are now supported ---------------------------

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
  if p_code is null or char_length(p_code) not between 1 and 80 or p_code<>btrim(p_code)
    or p_code!~'^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$'
    or p_name is null or char_length(p_name) not between 1 and 160 or p_name<>btrim(p_name)
    or (p_description is not null and (char_length(p_description) not between 1 and 2000 or p_description<>btrim(p_description)))
    or p_active is null or p_publicable is null or p_cumulative is null
    or p_priority is null or p_priority not between 0 and 1000 or p_valid_from is null
    or (p_valid_to is not null and p_valid_to<=p_valid_from)
    or (p_global_redemption_limit is not null and p_global_redemption_limit<1)
    or (p_per_user_redemption_limit is not null and p_per_user_redemption_limit<1)
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
  v_rule:=case when p_rule->>'type'='CUPOM' then private.normalize_coupon_rule(p_rule) else private.normalize_promotion_rule(p_rule) end;
  -- PROMO-004: only a coupon may be cumulative; product promotions never compose.
  if p_cumulative and v_rule->>'type'<>'CUPOM' then
    raise exception using errcode='22023',message='INVALID_PROMOTION';
  end if;
  if v_rule->>'type'='COMBO_MIX' and (select array_agg(item order by item) from unnest(p_product_ids) item)
    <>(select array_agg((component->>'productId')::uuid order by (component->>'productId')::uuid)
      from jsonb_array_elements(v_rule->'components') component) then
    raise exception using errcode='22023',message='INVALID_PROMOTION';
  end if;
  if (select count(*) from public.products where id=any(p_product_ids))<>cardinality(p_product_ids) then
    raise exception using errcode='P0002',message='PROMOTION_PRODUCT_NOT_FOUND'; end if;
  if v_rule->>'type'='CUPOM' and exists(select 1 from public.promotion_coupon_rules
    where code=v_rule->>'code' and promotion_id is distinct from p_promotion_id) then
    raise exception using errcode='23505',message='PROMOTION_COUPON_CODE_CONFLICT';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('promotion','save',v_actor),p_idempotency_key,
    jsonb_build_object('id',p_promotion_id,'revision',p_expected_revision,'code',p_code,'name',p_name,
      'description',p_description,'active',p_active,'publicable',p_publicable,'priority',p_priority,
      'cumulative',p_cumulative,'valid_from',p_valid_from,'valid_to',p_valid_to,
      'global_limit',p_global_redemption_limit,'user_limit',p_per_user_redemption_limit,
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

-- Pricing inputs ---------------------------------------------------------------------------------------

-- Candidates for a cart at one instant. A coupon is offered only for its code; limited promotions only
-- when p_include_limited and they still have capacity for p_customer_id.
create function private.pricing_candidates(
  p_channel public.promotion_channel,p_product_ids uuid[],p_customer_id uuid,p_coupon_code text,p_include_limited boolean
)
returns table(
  quoted_at timestamptz,product_id uuid,product_name text,amount_cents bigint,
  promotion_id uuid,priority integer,cumulative boolean,rule jsonb
)
language plpgsql stable security definer set search_path='' as $$
declare v_quoted_at timestamptz:=statement_timestamp(); v_code text:=upper(btrim(p_coupon_code));
begin
  if p_channel not in ('PORTAL','PDV') then raise exception using errcode='22023',message='PRICING_CHANNEL_UNSUPPORTED'; end if;
  if p_product_ids is null or cardinality(p_product_ids) not between 1 and 100
    or array_position(p_product_ids,null) is not null
    or cardinality(p_product_ids)<>(select count(distinct value) from unnest(p_product_ids) value) then
    raise exception using errcode='22023',message='PRICING_PRODUCTS_INVALID';
  end if;
  return query
  select v_quoted_at,product.id,product.name,price.amount_cents,promo.id,promo.priority,promo.cumulative,promo.rule
  from public.products product
  join public.categories category on category.id=product.category_id and category.active
  join lateral(
    select candidate.amount_cents from public.product_prices candidate
    where candidate.product_id=product.id and candidate.valid_from<=v_quoted_at
      and (candidate.valid_to is null or candidate.valid_to>v_quoted_at)
    order by candidate.valid_from desc limit 1
  ) price on true
  left join lateral(
    select candidate.id,candidate.priority,candidate.cumulative,document.rule
    from public.promotion_products scope
    join public.promotions candidate on candidate.id=scope.promotion_id
    cross join lateral (select private.promotion_rule_document(candidate.id) rule) document
    where scope.product_id=product.id and candidate.active and candidate.publicable
      and candidate.valid_from<=v_quoted_at and (candidate.valid_to is null or candidate.valid_to>v_quoted_at)
      and exists(select 1 from public.promotion_channels channel_scope
        where channel_scope.promotion_id=candidate.id and channel_scope.channel=p_channel)
      and document.rule is not null
      and (document.rule->>'type'<>'CUPOM' or document.rule->>'code'=v_code)
      -- PROMO-004: only a coupon may be cumulative; a cumulative product promotion is a legacy misconfiguration.
      and (not candidate.cumulative or document.rule->>'type'='CUPOM')
      and ((candidate.global_redemption_limit is null and candidate.per_user_redemption_limit is null)
        or (p_include_limited and private.promotion_has_capacity(candidate.id,p_customer_id)))
  ) promo on true
  where product.id=any(p_product_ids) and product.active
    and case p_channel when 'PORTAL' then product.published when 'PDV' then product.sellable_pdv else false end
  order by product.id,promo.priority desc nulls last,promo.id;
end;
$$;

-- The single public entry point for quotes. Per-user limits use the authenticated Portal buyer when present.
create function public.get_pricing_inputs(
  p_channel public.promotion_channel,p_product_ids uuid[],p_coupon_code text default null
)
returns table(
  quoted_at timestamptz,product_id uuid,product_name text,amount_cents bigint,
  promotion_id uuid,priority integer,cumulative boolean,rule jsonb
)
language plpgsql stable security definer set search_path='' as $$
begin
  if p_channel='PDV' and (auth.uid() is null or not public.has_permission('sales.create')) then
    raise exception using errcode='42501',message='PRICING_PDV_FORBIDDEN';
  end if;
  if p_coupon_code is not null and char_length(p_coupon_code) > 40 then
    raise exception using errcode='22023',message='PRICING_COUPON_INVALID';
  end if;
  return query select * from private.pricing_candidates(p_channel,p_product_ids,
    case when p_channel='PORTAL' then auth.uid() end,p_coupon_code,true);
end;
$$;

revoke all on function private.pricing_candidates(public.promotion_channel,uuid[],uuid,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.get_pricing_inputs(public.promotion_channel,uuid[],text) from public,anon,authenticated,service_role;
grant execute on function public.get_pricing_inputs(public.promotion_channel,uuid[],text) to anon,authenticated;

-- Cart pricing -----------------------------------------------------------------------------------------

-- Coupon discount for one line value. Non-cumulative percentage floors per unit; cumulative floors the line.
create function private.coupon_line_discount(p_rule jsonb,p_amount bigint,p_quantity bigint,p_value bigint,p_per_unit boolean)
returns bigint language sql immutable set search_path='' as $$
  select case when p_per_unit then
      p_value-floor((p_amount*(10000-(p_rule->'discount'->>'percentageBasisPoints')::bigint))::numeric/10000)::bigint*p_quantity
    else p_value-floor((p_value*(10000-(p_rule->'discount'->>'percentageBasisPoints')::bigint))::numeric/10000)::bigint end;
$$;

create function private.coupon_snapshot(p_id uuid,p_priority integer,p_cumulative boolean,p_rule jsonb,p_savings bigint)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('promotion_id',p_id,'type','CUPOM','priority',p_priority,'code',p_rule->>'code',
    'discount_kind',p_rule->'discount'->>'kind',
    'percentage_basis_points',(p_rule->'discount'->>'percentageBasisPoints')::bigint,
    'amount_cents',(p_rule->'discount'->>'amountCents')::bigint,'cumulative',p_cumulative,'savings_cents',p_savings);
$$;

-- PROMO-004/005/006/007. With p_reserve, limited promotions touching the cart are locked in id order and
-- are candidates only while they have capacity; without it they are excluded.
create function private.price_cart(
  p_channel public.promotion_channel,p_items jsonb,p_customer_id uuid,p_coupon_code text,p_reserve boolean
)
returns jsonb language plpgsql set search_path='' as $$
declare
  v_item record; v_candidate record; v_set record; v_component jsonb; v_product uuid;
  v_lines jsonb:='{}'::jsonb; v_order uuid[]:='{}'; v_combos jsonb:='{}'::jsonb; v_sets jsonb:='[]'::jsonb;
  v_coupon jsonb; v_coupon_products uuid[]:='{}'; v_eligible uuid[];
  v_quoted_at timestamptz; v_found boolean; v_result jsonb; v_line jsonb;
  v_amount bigint; v_best_id uuid; v_best_priority integer; v_best_total bigint; v_best_result jsonb;
  v_count bigint; v_discount bigint; v_with bigint; v_without bigint; v_line_priority integer; v_line_min_id uuid;
  v_shares jsonb; v_share bigint; v_wins boolean; v_full bigint;
  v_discounts jsonb; v_saving bigint; v_set_snapshot jsonb; v_total_value bigint;
  v_original_total bigint:=0; v_discount_total bigint:=0; v_total bigint:=0;
  v_per_unit boolean:=false; v_per_line boolean:=false; v_coupon_applied boolean:=false;
  v_output jsonb:='[]'::jsonb; v_snapshot jsonb; v_coupon_snapshot jsonb; v_line_discount bigint; v_effective bigint;
  v_ids uuid[];
begin
  select array_agg(item.product_id order by item.product_id) into v_ids
  from jsonb_to_recordset(p_items) item(product_id uuid,quantity bigint);
  if p_reserve then
    perform 1 from public.promotions promotion
    where promotion.id in (select scope.promotion_id from public.promotion_products scope where scope.product_id=any(v_ids))
      and (promotion.global_redemption_limit is not null or promotion.per_user_redemption_limit is not null)
    order by promotion.id for update;
  end if;

  for v_item in select item.product_id,item.quantity
    from jsonb_to_recordset(p_items) item(product_id uuid,quantity bigint) order by item.product_id
  loop
    v_found:=false; v_best_id:=null; v_best_priority:=null; v_best_total:=null; v_best_result:=null;
    for v_candidate in select * from private.pricing_candidates(p_channel,array[v_item.product_id],p_customer_id,p_coupon_code,p_reserve) loop
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
      if v_candidate.rule->>'type'='CUPOM' then
        v_coupon:=jsonb_build_object('id',v_candidate.promotion_id,'priority',v_candidate.priority,
          'cumulative',v_candidate.cumulative,'rule',v_candidate.rule);
        v_coupon_products:=v_coupon_products||v_item.product_id;
        continue;
      end if;
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
      'subtotal',v_amount*v_item.quantity,'best_id',v_best_id,'best_priority',v_best_priority,
      'total',coalesce(v_best_total,v_amount*v_item.quantity),'result',v_best_result);
    v_lines:=v_lines||jsonb_build_object(v_item.product_id::text,v_line);
    v_order:=v_order||v_item.product_id;
  end loop;

  -- Set candidates: combos with every component present, and a non-cumulative coupon.
  for v_set in
    select entry.key::uuid id,(entry.value->>'priority')::integer priority,entry.value->'rule' rule,
      (select sum(((v_lines->(component->>'productId'))->>'amount')::bigint*(component->>'quantity')::bigint)
        from jsonb_array_elements(entry.value->'rule'->'components') component) full_value
    from jsonb_each(v_combos) entry
    where (select bool_and(v_lines ? (component->>'productId')) from jsonb_array_elements(entry.value->'rule'->'components') component)
  loop
    if (v_set.rule->>'comboPriceCents')::bigint>=v_set.full_value then
      raise exception using errcode='P0001',message='INVALID_PROMOTION_COMBO_PRICE'; end if;
    v_sets:=v_sets||jsonb_build_array(jsonb_build_object('kind','COMBO','id',v_set.id,'priority',v_set.priority,
      'rule',v_set.rule,'saving',v_set.full_value-(v_set.rule->>'comboPriceCents')::bigint));
  end loop;
  if v_coupon is not null and not (v_coupon->>'cumulative')::boolean then
    select coalesce(sum(case when v_coupon->'rule'->'discount'->>'kind'='PERCENTUAL' then
        private.coupon_line_discount(v_coupon->'rule',((v_lines->(product::text))->>'amount')::bigint,
          ((v_lines->(product::text))->>'quantity')::bigint,((v_lines->(product::text))->>'subtotal')::bigint,true)
        else 0 end),0),
      coalesce(sum(((v_lines->(product::text))->>'subtotal')::bigint),0)
    into v_saving,v_total_value from unnest(v_coupon_products) product;
    if v_coupon->'rule'->'discount'->>'kind'='VALOR_FIXO' then
      v_saving:=least((v_coupon->'rule'->'discount'->>'amountCents')::bigint,v_total_value);
    end if;
    v_sets:=v_sets||jsonb_build_array(jsonb_build_object('kind','COUPON','id',v_coupon->>'id',
      'priority',(v_coupon->>'priority')::integer,'rule',v_coupon->'rule','saving',v_saving));
  end if;

  for v_set in
    select (value->>'kind') kind,(value->>'id')::uuid id,(value->>'priority')::integer priority,value->'rule' rule
    from jsonb_array_elements(v_sets)
    order by (value->>'priority')::integer desc,(value->>'saving')::bigint desc,(value->>'id')::uuid
  loop
    if v_set.kind='COMBO' then
      continue when exists(select 1 from jsonb_array_elements(v_set.rule->'components') component
        where (v_lines->(component->>'productId')) ? 'set');
      select min(((v_lines->(component->>'productId'))->>'quantity')::bigint/(component->>'quantity')::bigint) into v_count
      from jsonb_array_elements(v_set.rule->'components') component;
      v_count:=least(v_count,coalesce((v_set.rule->>'maxCombosPerCart')::bigint,v_count));
      continue when v_count=0;
      select jsonb_agg(jsonb_build_object('product_id',component->>'productId',
        'value',((v_lines->(component->>'productId'))->>'amount')::bigint*(component->>'quantity')::bigint*v_count)),
        sum(((v_lines->(component->>'productId'))->>'amount')::bigint*(component->>'quantity')::bigint)
      into v_shares,v_full from jsonb_array_elements(v_set.rule->'components') component;
      v_discounts:=private.allocate_combo_discount((v_full-(v_set.rule->>'comboPriceCents')::bigint)*v_count,v_shares);
    else
      select array_agg(product order by product) into v_eligible from unnest(v_coupon_products) product
      where not ((v_lines->(product::text)) ? 'set');
      continue when v_eligible is null;
      if v_set.rule->'discount'->>'kind'='PERCENTUAL' then
        select jsonb_object_agg(product::text,private.coupon_line_discount(v_set.rule,((v_lines->(product::text))->>'amount')::bigint,
          ((v_lines->(product::text))->>'quantity')::bigint,((v_lines->(product::text))->>'subtotal')::bigint,true))
        into v_discounts from unnest(v_eligible) product;
      else
        select jsonb_agg(jsonb_build_object('product_id',product,'value',((v_lines->(product::text))->>'subtotal')::bigint)),
          sum(((v_lines->(product::text))->>'subtotal')::bigint)
        into v_shares,v_total_value from unnest(v_eligible) product;
        continue when v_total_value=0;
        v_discounts:=private.allocate_combo_discount(least((v_set.rule->'discount'->>'amountCents')::bigint,v_total_value),v_shares);
      end if;
      continue when not exists(select 1 from jsonb_each_text(v_discounts) entry where entry.value::bigint>0);
    end if;
    select sum(((v_lines->entry.key)->>'subtotal')::bigint-entry.value::bigint),
      sum(((v_lines->entry.key)->>'total')::bigint),
      max(((v_lines->entry.key)->>'best_priority')::integer)
    into v_with,v_without,v_line_priority from jsonb_each_text(v_discounts) entry;
    -- uuid has no min(); the ordered subquery keeps the byte-wise order used by the domain.
    select ((v_lines->entry.key)->>'best_id')::uuid into v_line_min_id from jsonb_each_text(v_discounts) entry
    where (v_lines->entry.key)->>'best_id' is not null order by 1 limit 1;
    v_wins:=v_line_priority is null or v_set.priority>v_line_priority
      or (v_set.priority=v_line_priority and (v_with<v_without or (v_with=v_without and v_set.id<v_line_min_id)));
    continue when not v_wins;
    for v_component in select jsonb_build_object('product',entry.key,'discount',entry.value::bigint) from jsonb_each_text(v_discounts) entry loop
      v_share:=(v_component->>'discount')::bigint;
      if v_set.kind='COMBO' then
        v_set_snapshot:=jsonb_build_object('promotion_id',v_set.id,'type','COMBO_MIX','priority',v_set.priority,
          'combo_price_cents',(v_set.rule->>'comboPriceCents')::bigint,'combos',v_count,
          'component_quantity',(select (component->>'quantity')::bigint*v_count from jsonb_array_elements(v_set.rule->'components') component
            where component->>'productId'=v_component->>'product'),'savings_cents',v_share);
      else
        v_set_snapshot:=private.coupon_snapshot(v_set.id,v_set.priority,false,v_set.rule,v_share)
          ||jsonb_build_object('per_unit',v_set.rule->'discount'->>'kind'='PERCENTUAL');
      end if;
      v_lines:=jsonb_set(v_lines,array[v_component->>'product'],(v_lines->(v_component->>'product'))||jsonb_build_object('set',v_set_snapshot));
    end loop;
  end loop;

  -- A cumulative coupon applies on top of the resulting line totals (PROMO-004 #4).
  if v_coupon is not null and (v_coupon->>'cumulative')::boolean then
    select jsonb_agg(jsonb_build_object('product_id',product,'value',
        case when (v_lines->(product::text)) ? 'set' then ((v_lines->(product::text))->>'subtotal')::bigint-((v_lines->(product::text))->'set'->>'savings_cents')::bigint
        else ((v_lines->(product::text))->>'total')::bigint end))
    into v_shares from unnest(v_coupon_products) product;
    select coalesce(sum((share->>'value')::bigint),0) into v_total_value from jsonb_array_elements(coalesce(v_shares,'[]'::jsonb)) share;
    if v_total_value>0 then
      if v_coupon->'rule'->'discount'->>'kind'='PERCENTUAL' then
        select jsonb_object_agg(share->>'product_id',private.coupon_line_discount(v_coupon->'rule',0,0,(share->>'value')::bigint,false))
        into v_discounts from jsonb_array_elements(v_shares) share;
      else
        v_discounts:=private.allocate_combo_discount(least((v_coupon->'rule'->'discount'->>'amountCents')::bigint,v_total_value),v_shares);
      end if;
      for v_component in select jsonb_build_object('product',entry.key,'discount',entry.value::bigint) from jsonb_each_text(v_discounts) entry loop
        continue when (v_component->>'discount')::bigint=0;
        v_lines:=jsonb_set(v_lines,array[v_component->>'product'],(v_lines->(v_component->>'product'))||jsonb_build_object('coupon',
          private.coupon_snapshot((v_coupon->>'id')::uuid,(v_coupon->>'priority')::integer,true,v_coupon->'rule',(v_component->>'discount')::bigint)));
      end loop;
    end if;
  end if;

  foreach v_product in array v_order loop
    v_line:=v_lines->(v_product::text);
    if v_line ? 'set' then
      v_effective:=(v_line->>'subtotal')::bigint-(v_line->'set'->>'savings_cents')::bigint;
      v_snapshot:=(v_line->'set')-'per_unit'::text;
      v_per_unit:=v_per_unit or coalesce((v_line->'set'->>'per_unit')::boolean,false);
    elsif v_line->>'best_id' is not null then
      v_effective:=(v_line->>'total')::bigint;
      v_per_unit:=v_per_unit or (v_line->'result'->>'rounded')::boolean;
      v_snapshot:=jsonb_build_object('promotion_id',(v_line->>'best_id')::uuid,'type',v_line->'result'->>'type',
        'priority',(v_line->>'best_priority')::integer)||(v_line->'result'->'detail')
        ||jsonb_build_object('savings_cents',(v_line->>'subtotal')::bigint-v_effective);
    else
      v_effective:=(v_line->>'subtotal')::bigint; v_snapshot:=null;
    end if;
    v_coupon_snapshot:=v_line->'coupon';
    if v_coupon_snapshot is not null then
      v_effective:=v_effective-(v_coupon_snapshot->>'savings_cents')::bigint;
      v_per_line:=v_per_line or v_coupon_snapshot->>'discount_kind'='PERCENTUAL';
    end if;
    v_coupon_applied:=v_coupon_applied or v_coupon_snapshot is not null or coalesce(v_snapshot->>'type'='CUPOM',false);
    v_line_discount:=(v_line->>'subtotal')::bigint-v_effective;
    if (v_line->>'subtotal')::bigint>9007199254740991 or v_effective<0 then
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
      'promotion_snapshot',v_snapshot,'coupon_promotion_id',(v_coupon_snapshot->>'promotion_id')::uuid,
      'coupon_snapshot',v_coupon_snapshot));
  end loop;
  return jsonb_build_object('quoted_at',v_quoted_at,'currency','BRL',
    'rounding',case when v_per_unit and v_per_line then 'FLOOR_PER_UNIT_AND_LINE' when v_per_unit then 'FLOOR_PER_UNIT'
      when v_per_line then 'FLOOR_PER_LINE' else 'NONE' end,
    'lines',v_output,'original_total_cents',v_original_total,
    'discount_total_cents',v_discount_total,'total_cents',v_total,
    'coupon',case when p_coupon_code is null then null
      else jsonb_build_object('code',upper(btrim(p_coupon_code)),'applied',v_coupon_applied) end,
    'promotion_ids',coalesce((select jsonb_agg(distinct id order by id) from (
      select (line->>'promotion_id')::uuid id from jsonb_array_elements(v_output) line where line->>'promotion_id' is not null
      union select (line->>'coupon_promotion_id')::uuid from jsonb_array_elements(v_output) line where line->>'coupon_promotion_id' is not null
    ) applied),'[]'::jsonb));
end;
$$;

-- Legacy entry point (raffles and existing callers): no customer, no coupon, limited promotions excluded.
create or replace function private.price_sale_items(p_channel public.promotion_channel,p_items jsonb)
returns jsonb language sql set search_path='' as $$
  select private.price_cart(p_channel,p_items,null,null,false);
$$;

-- One RESERVED use per applied promotion. The unique keys reject a second use of a promotion in a sale.
create function private.reserve_promotion_redemptions(p_quote jsonb,p_sale_id uuid,p_reservation_id uuid,p_customer_id uuid)
returns void language plpgsql set search_path='' as $$
begin
  insert into public.promotion_redemptions(promotion_id,sale_id,reservation_id,customer_id)
  select (id#>>'{}')::uuid,p_sale_id,p_reservation_id,p_customer_id
  from jsonb_array_elements(coalesce(p_quote->'promotion_ids','[]'::jsonb)) id;
end;
$$;

revoke all on function private.coupon_line_discount(jsonb,bigint,bigint,bigint,boolean) from public,anon,authenticated,service_role;
revoke all on function private.coupon_snapshot(uuid,integer,boolean,jsonb,bigint) from public,anon,authenticated,service_role;
revoke all on function private.price_cart(public.promotion_channel,jsonb,uuid,text,boolean) from public,anon,authenticated,service_role;
revoke all on function private.price_sale_items(public.promotion_channel,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.reserve_promotion_redemptions(jsonb,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function private.promotion_has_capacity(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function private.normalize_coupon_rule(jsonb) from public,anon,authenticated,service_role;
revoke all on function private.guard_promotion_redemption_change() from public,anon,authenticated,service_role;
revoke all on function private.sync_sale_promotion_redemptions() from public,anon,authenticated,service_role;
revoke all on function private.sync_reservation_promotion_redemptions() from public,anon,authenticated,service_role;
revoke all on function private.clear_promotion_rule(uuid) from public,anon,authenticated,service_role;
revoke all on function private.write_promotion_rule(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.promotion_rule_document(uuid) from public,anon,authenticated,service_role;
revoke all on function private.assert_single_promotion_rule() from public,anon,authenticated,service_role;

-- Sales and reservations keep the cumulative coupon of each line ---------------------------------------

alter table public.sale_items
  add column coupon_promotion_id uuid references public.promotions(id) on delete restrict,
  add column coupon_snapshot jsonb,
  add constraint sale_items_coupon_pair_valid check (
    (coupon_promotion_id is null and coupon_snapshot is null)
    or (coupon_promotion_id is not null and coupon_snapshot is not null and jsonb_typeof(coupon_snapshot)='object'));

drop function public.checkout_sale(public.promotion_channel,uuid,jsonb,text,uuid);
create function public.checkout_sale(
  p_channel public.promotion_channel,
  p_location_id uuid,
  p_items jsonb,
  p_idempotency_key text,
  p_correlation_id uuid,
  p_coupon_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_customer_id uuid;
  v_items jsonb;
  v_item_count integer;
  v_distinct_count integer;
  v_invalid_count integer;
  v_scope text;
  v_claim record;
  v_quote jsonb;
  v_sale_id uuid := gen_random_uuid();
  v_attempt_id uuid := gen_random_uuid();
  v_reservation jsonb;
  v_result jsonb;
  v_coupon text := nullif(upper(btrim(p_coupon_code)), '');
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;
  if p_channel not in ('PORTAL', 'PDV') then
    raise exception using errcode = '22023', message = 'SALE_CHANNEL_UNSUPPORTED';
  end if;
  if v_coupon is not null and char_length(v_coupon) > 40 then
    raise exception using errcode = '22023', message = 'INVALID_SALE_COUPON';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_SALE_ITEMS';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) element
    where jsonb_typeof(element) <> 'object'
      or element - 'product_id' - 'quantity' <> '{}'::jsonb
      or not (element ? 'product_id' and element ? 'quantity')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_SALE_ITEMS';
  end if;

  select
    jsonb_agg(jsonb_build_object('product_id', item.product_id, 'quantity', item.quantity) order by item.product_id),
    count(*), count(distinct item.product_id),
    count(*) filter (where item.product_id is null or item.quantity not between 1 and 9007199254740991)
  into v_items, v_item_count, v_distinct_count, v_invalid_count
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint);
  if v_invalid_count > 0 or v_item_count <> v_distinct_count then
    raise exception using errcode = '22023', message = 'INVALID_SALE_ITEMS';
  end if;

  if p_channel = 'PDV' then
    if not public.has_permission('sales.create') or not exists (
      select 1 from public.stock_locations location
      where location.id = p_location_id and location.active
        and (
          public.has_permission('inventory.manage')
          or (location.location_type = 'SELLER' and location.seller_id = v_actor_id)
        )
    ) then
      raise exception using errcode = '42501', message = 'SALE_LOCATION_FORBIDDEN';
    end if;
  elsif not public.has_permission('portal.access') or not exists (
    select 1 from public.stock_locations location
    where location.id = p_location_id and location.active and location.location_type = 'CENTRAL'
  ) then
    raise exception using errcode = '42501', message = 'SALE_LOCATION_FORBIDDEN';
  end if;
  -- The PDV sale has no identified buyer; per-user limits never apply to it (PROMO-007).
  v_customer_id := case when p_channel = 'PORTAL' then v_actor_id else null end;

  v_scope := private.build_idempotency_scope('sales', 'checkout', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object('channel', p_channel, 'location_id', p_location_id, 'items', v_items)
      || case when v_coupon is null then '{}'::jsonb else jsonb_build_object('coupon', v_coupon) end
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  v_quote := private.price_cart(p_channel, v_items, v_customer_id, v_coupon, true);
  insert into public.sales (
    id, channel, location_id, created_by, customer_id,
    original_total_cents, discount_total_cents, total_cents,
    quoted_at, correlation_id
  ) values (
    v_sale_id, p_channel, p_location_id, v_actor_id, v_customer_id,
    (v_quote ->> 'original_total_cents')::bigint,
    (v_quote ->> 'discount_total_cents')::bigint,
    (v_quote ->> 'total_cents')::bigint,
    (v_quote ->> 'quoted_at')::timestamptz,
    p_correlation_id
  );

  insert into public.sale_items (
    sale_id, product_id, product_sku, product_name, quantity,
    unit_price_cents, original_subtotal_cents, discount_cents, total_cents,
    promotion_id, promotion_snapshot, coupon_promotion_id, coupon_snapshot
  )
  select
    v_sale_id, line.product_id, line.product_sku, line.product_name, line.quantity,
    line.unit_price_cents, line.original_subtotal_cents, line.discount_cents, line.total_cents,
    line.promotion_id, line.promotion_snapshot, line.coupon_promotion_id, line.coupon_snapshot
  from jsonb_to_recordset(v_quote -> 'lines') as line(
    product_id uuid, product_sku text, product_name text, quantity bigint,
    unit_price_cents bigint, original_subtotal_cents bigint, discount_cents bigint,
    total_cents bigint, promotion_id uuid, promotion_snapshot jsonb,
    coupon_promotion_id uuid, coupon_snapshot jsonb
  );
  perform private.assert_sale_totals(v_sale_id);
  perform private.reserve_promotion_redemptions(v_quote, v_sale_id, null, v_customer_id);

  v_reservation := private.reserve_stock_for_sale(
    v_sale_id, p_location_id, v_items, v_actor_id, p_correlation_id
  );

  insert into public.payment_attempts (
    id, sale_id, amount_cents, operator_id, idempotency_key, correlation_id
  ) values (
    v_attempt_id, v_sale_id, (v_quote ->> 'total_cents')::bigint,
    v_actor_id, p_idempotency_key, p_correlation_id
  );
  perform private.transition_sale_state(
    v_sale_id, 'AWAITING_PAYMENT', v_actor_id, p_correlation_id, null
  );

  v_result := jsonb_build_object(
    'sale_id', v_sale_id,
    'status', 'AWAITING_PAYMENT',
    'channel', p_channel,
    'location_id', p_location_id,
    'quote', v_quote,
    'reservation', v_reservation,
    'payment_attempt', jsonb_build_object(
      'attempt_id', v_attempt_id,
      'status', 'CREATED',
      'amount_cents', (v_quote ->> 'total_cents')::bigint,
      'integration_channel', null,
      'confirmation_source', null
    ),
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale_id::text
  );
  return v_result;
end;
$$;

revoke all on function public.checkout_sale(public.promotion_channel,uuid,jsonb,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.checkout_sale(public.promotion_channel,uuid,jsonb,text,uuid,text) to authenticated;

drop function public.create_commercial_reservation(uuid,jsonb,text,uuid);
create function public.create_commercial_reservation(
  p_location_id uuid,
  p_items jsonb,
  p_idempotency_key text,
  p_correlation_id uuid,
  p_coupon_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_items jsonb;
  v_item_count integer;
  v_distinct_count integer;
  v_invalid_count integer;
  v_scope text;
  v_claim record;
  v_quote jsonb;
  v_reservation_id uuid := gen_random_uuid();
  v_stock jsonb;
  v_result jsonb;
  v_coupon text := nullif(upper(btrim(p_coupon_code)), '');
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.has_permission('reservations.manage.own') or p_correlation_id is null then
    raise exception using errcode = '42501', message = 'COMMERCIAL_RESERVATION_FORBIDDEN';
  end if;
  if v_coupon is not null and char_length(v_coupon) > 40 then
    raise exception using errcode = '22023', message = 'INVALID_COMMERCIAL_RESERVATION_COUPON';
  end if;
  if not exists (
    select 1 from public.stock_locations
    where id = p_location_id and active and location_type = 'CENTRAL'
  ) then
    raise exception using errcode = '42501', message = 'COMMERCIAL_RESERVATION_LOCATION_FORBIDDEN';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 100
    or exists (
      select 1 from jsonb_array_elements(p_items) element
      where jsonb_typeof(element) <> 'object'
        or element - 'product_id' - 'quantity' <> '{}'::jsonb
        or not (element ? 'product_id' and element ? 'quantity')
    ) then
    raise exception using errcode = '22023', message = 'INVALID_COMMERCIAL_RESERVATION_ITEMS';
  end if;

  select
    jsonb_agg(jsonb_build_object('product_id', item.product_id, 'quantity', item.quantity) order by item.product_id),
    count(*), count(distinct item.product_id),
    count(*) filter (where item.product_id is null or item.quantity not between 1 and 9007199254740991)
  into v_items, v_item_count, v_distinct_count, v_invalid_count
  from jsonb_to_recordset(p_items) as item(product_id uuid, quantity bigint);
  if v_invalid_count > 0 or v_item_count <> v_distinct_count then
    raise exception using errcode = '22023', message = 'INVALID_COMMERCIAL_RESERVATION_ITEMS';
  end if;

  v_scope := private.build_idempotency_scope('reservations', 'create', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object('location_id', p_location_id, 'items', v_items)
      || case when v_coupon is null then '{}'::jsonb else jsonb_build_object('coupon', v_coupon) end
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  v_quote := private.price_cart('PORTAL', v_items, v_actor_id, v_coupon, true);
  v_stock := private.reserve_stock_for_commercial_reservation(
    v_reservation_id, p_location_id, v_items, v_actor_id, p_correlation_id
  );
  insert into public.commercial_reservations (
    id, customer_id, location_id, stock_reservation_id, quote_snapshot,
    original_total_cents, discount_total_cents, total_cents,
    correlation_id, expires_at
  ) values (
    v_reservation_id, v_actor_id, p_location_id,
    (v_stock ->> 'reservation_id')::uuid, v_quote,
    (v_quote ->> 'original_total_cents')::bigint,
    (v_quote ->> 'discount_total_cents')::bigint,
    (v_quote ->> 'total_cents')::bigint,
    p_correlation_id, (v_stock ->> 'expires_at')::timestamptz
  );
  perform private.reserve_promotion_redemptions(v_quote, null, v_reservation_id, v_actor_id);

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('reservations.created', v_actor_id, 'commercial_reservation', v_reservation_id::text,
    p_correlation_id, jsonb_build_object('total_cents', v_quote -> 'total_cents'));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('reservations.created', 'commercial_reservation', v_reservation_id::text,
    jsonb_build_object('reservation_id', v_reservation_id, 'expires_at', v_stock -> 'expires_at'));

  v_result := jsonb_build_object(
    'reservation_id', v_reservation_id,
    'status', 'ACTIVE',
    'location_id', p_location_id,
    'quote', v_quote,
    'stock_reservation', v_stock,
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation_id::text
  );
  return v_result;
end;
$$;

revoke all on function public.create_commercial_reservation(uuid,jsonb,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.create_commercial_reservation(uuid,jsonb,text,uuid,text) to authenticated;

create or replace function public.convert_commercial_reservation(
  p_reservation_id uuid,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_reservation public.commercial_reservations%rowtype;
  v_scope text;
  v_claim record;
  v_sale_id uuid := gen_random_uuid();
  v_attempt_id uuid := gen_random_uuid();
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  select * into v_reservation from public.commercial_reservations
  where id = p_reservation_id for update;
  if not found or v_reservation.customer_id <> v_actor_id then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_FOUND';
  end if;
  v_scope := private.build_idempotency_scope('reservations', 'convert', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key, jsonb_build_object('reservation_id', p_reservation_id)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if v_reservation.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_ACTIVE';
  end if;
  if v_reservation.expires_at <= clock_timestamp() then
    perform private.finalize_stock_reservation(
      v_reservation.stock_reservation_id, 'EXPIRED', v_actor_id, p_correlation_id
    );
    update public.commercial_reservations set status = 'EXPIRED', expired_at = now()
    where id = v_reservation.id;
    v_result := jsonb_build_object(
      'reservation_id', v_reservation.id, 'status', 'EXPIRED',
      'sale_id', null, 'payment_attempt_id', null, 'correlation_id', p_correlation_id
    );
    perform private.complete_idempotency(
      v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation.id::text
    );
    return v_result;
  end if;

  insert into public.sales (
    id, channel, location_id, created_by, customer_id,
    original_total_cents, discount_total_cents, total_cents, quoted_at, correlation_id
  ) values (
    v_sale_id, 'PORTAL', v_reservation.location_id, v_actor_id, v_actor_id,
    v_reservation.original_total_cents, v_reservation.discount_total_cents,
    v_reservation.total_cents,
    (v_reservation.quote_snapshot ->> 'quoted_at')::timestamptz, p_correlation_id
  );
  insert into public.sale_items (
    sale_id, product_id, product_sku, product_name, quantity,
    unit_price_cents, original_subtotal_cents, discount_cents, total_cents,
    promotion_id, promotion_snapshot, coupon_promotion_id, coupon_snapshot
  )
  select v_sale_id, line.product_id, line.product_sku, line.product_name, line.quantity,
    line.unit_price_cents, line.original_subtotal_cents, line.discount_cents, line.total_cents,
    line.promotion_id, line.promotion_snapshot, line.coupon_promotion_id, line.coupon_snapshot
  from jsonb_to_recordset(v_reservation.quote_snapshot -> 'lines') as line(
    product_id uuid, product_sku text, product_name text, quantity bigint,
    unit_price_cents bigint, original_subtotal_cents bigint, discount_cents bigint,
    total_cents bigint, promotion_id uuid, promotion_snapshot jsonb,
    coupon_promotion_id uuid, coupon_snapshot jsonb
  );
  perform private.assert_sale_totals(v_sale_id);
  update public.stock_reservations
  set origin_type = 'sale', origin_id = v_sale_id::text
  where id = v_reservation.stock_reservation_id and status = 'ACTIVE';
  if not found then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_STOCK_NOT_ACTIVE';
  end if;
  insert into public.payment_attempts (
    id, sale_id, amount_cents, operator_id, idempotency_key, correlation_id
  ) values (
    v_attempt_id, v_sale_id, v_reservation.total_cents,
    v_actor_id, p_idempotency_key, p_correlation_id
  );
  perform private.transition_sale_state(
    v_sale_id, 'AWAITING_PAYMENT', v_actor_id, p_correlation_id, null
  );
  update public.commercial_reservations
  set status = 'CONVERTED', converted_sale_id = v_sale_id, converted_at = now()
  where id = v_reservation.id;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('reservations.converted', v_actor_id, 'commercial_reservation', v_reservation.id::text,
    p_correlation_id, jsonb_build_object('sale_id', v_sale_id, 'attempt_id', v_attempt_id));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('reservations.converted', 'commercial_reservation', v_reservation.id::text,
    jsonb_build_object('reservation_id', v_reservation.id, 'sale_id', v_sale_id));

  v_result := jsonb_build_object(
    'reservation_id', v_reservation.id, 'status', 'CONVERTED',
    'sale_id', v_sale_id, 'sale_status', 'AWAITING_PAYMENT',
    'payment_attempt_id', v_attempt_id,
    'stock_reservation_id', v_reservation.stock_reservation_id,
    'total_cents', v_reservation.total_cents,
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation.id::text
  );
  return v_result;
end;
$$;

comment on table public.promotion_redemptions is 'PROMO-007 ledger: one use per promotion per sale; RESERVED at checkout, CONSUMED on confirmation, RELEASED on cancel/expiry before confirmation.';
comment on table public.promotion_coupon_rules is 'CUPOM rules; codes are readable only by promotion managers.';
comment on function public.get_pricing_inputs(public.promotion_channel,uuid[],text) is 'Single public entry point for quote inputs, including coupons and limited promotions with capacity.';
comment on function private.price_cart(public.promotion_channel,jsonb,uuid,text,boolean) is 'Authoritative cart pricing shared by quote parity tests, checkout and reservations.';
