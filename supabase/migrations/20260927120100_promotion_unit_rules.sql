-- PROMO-001: percentage and fixed unit-price rules with server-authoritative pricing.
-- PERCENTUAL floors the discounted unit price to the cent (customer-favorable rounding).

-- The enum now has more members; keep the quantity table restricted to its own type.
alter table public.promotion_quantity_price_rules
  add constraint promotion_quantity_price_rules_type_check check (rule_type = 'QUANTIDADE_PRECO');

create table public.promotion_percentage_rules (
  promotion_id uuid primary key references public.promotions(id) on delete restrict,
  rule_type public.promotion_rule_type not null default 'PERCENTUAL'
    check (rule_type = 'PERCENTUAL'),
  percentage_basis_points integer not null check (percentage_basis_points between 1 and 9999),
  created_at timestamptz not null default now()
);

create table public.promotion_fixed_unit_price_rules (
  promotion_id uuid primary key references public.promotions(id) on delete restrict,
  rule_type public.promotion_rule_type not null default 'VALOR_FIXO_UNITARIO'
    check (rule_type = 'VALOR_FIXO_UNITARIO'),
  fixed_unit_price_cents bigint not null
    check (fixed_unit_price_cents between 0 and 9007199254740991),
  created_at timestamptz not null default now()
);

create function private.assert_single_promotion_rule()
returns trigger language plpgsql set search_path='' as $$
begin
  if (tg_table_name <> 'promotion_quantity_price_rules'
      and exists(select 1 from public.promotion_quantity_price_rules where promotion_id=new.promotion_id))
    or (tg_table_name <> 'promotion_percentage_rules'
      and exists(select 1 from public.promotion_percentage_rules where promotion_id=new.promotion_id))
    or (tg_table_name <> 'promotion_fixed_unit_price_rules'
      and exists(select 1 from public.promotion_fixed_unit_price_rules where promotion_id=new.promotion_id)) then
    raise exception using errcode='P0001',message='PROMOTION_RULE_TYPE_CONFLICT';
  end if;
  return new;
end;
$$;

create trigger promotion_quantity_rule_single before insert on public.promotion_quantity_price_rules
for each row execute function private.assert_single_promotion_rule();
create trigger promotion_percentage_rule_single before insert on public.promotion_percentage_rules
for each row execute function private.assert_single_promotion_rule();
create trigger promotion_fixed_unit_rule_single before insert on public.promotion_fixed_unit_price_rules
for each row execute function private.assert_single_promotion_rule();
create trigger promotion_percentage_rules_prevent_hard_delete before delete on public.promotion_percentage_rules
for each row execute function private.prevent_promotion_hard_delete();
create trigger promotion_fixed_unit_rules_prevent_hard_delete before delete on public.promotion_fixed_unit_price_rules
for each row execute function private.prevent_promotion_hard_delete();

alter table public.promotion_percentage_rules enable row level security;
alter table public.promotion_fixed_unit_price_rules enable row level security;
revoke all on public.promotion_percentage_rules from public,anon,authenticated,service_role;
revoke all on public.promotion_fixed_unit_price_rules from public,anon,authenticated,service_role;
grant select on public.promotion_percentage_rules to anon,authenticated;
grant select on public.promotion_fixed_unit_price_rules to anon,authenticated;

create policy promotion_percentage_rules_public_current_read on public.promotion_percentage_rules
for select to anon,authenticated using (exists(
  select 1 from public.promotions where promotions.id=promotion_percentage_rules.promotion_id
    and promotions.active and promotions.publicable and not promotions.cumulative
    and promotions.valid_from<=now() and (promotions.valid_to is null or promotions.valid_to>now())
));
create policy promotion_percentage_rules_manager_read on public.promotion_percentage_rules
for select to authenticated using ((select public.has_permission('catalog.manage')));
create policy promotion_fixed_unit_rules_public_current_read on public.promotion_fixed_unit_price_rules
for select to anon,authenticated using (exists(
  select 1 from public.promotions where promotions.id=promotion_fixed_unit_price_rules.promotion_id
    and promotions.active and promotions.publicable and not promotions.cumulative
    and promotions.valid_from<=now() and (promotions.valid_to is null or promotions.valid_to>now())
));
create policy promotion_fixed_unit_rules_manager_read on public.promotion_fixed_unit_price_rules
for select to authenticated using ((select public.has_permission('catalog.manage')));

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
    'rule', coalesce(
      (select jsonb_build_object('type',rule.rule_type,'groupQuantity',rule.group_quantity,
        'groupPriceCents',rule.group_price_cents,'maxGroupsPerLine',rule.max_groups_per_line)
        from public.promotion_quantity_price_rules rule where rule.promotion_id=promotion.id),
      (select jsonb_build_object('type',rule.rule_type,'percentageBasisPoints',rule.percentage_basis_points)
        from public.promotion_percentage_rules rule where rule.promotion_id=promotion.id),
      (select jsonb_build_object('type',rule.rule_type,'fixedUnitPriceCents',rule.fixed_unit_price_cents)
        from public.promotion_fixed_unit_price_rules rule where rule.promotion_id=promotion.id)
    )
  ) from public.promotions promotion where promotion.id=p_promotion_id;
$$;

create function public.get_pricing_quote_inputs_v2(
  p_channel public.promotion_channel,p_product_ids uuid[]
)
returns table(
  quoted_at timestamptz,product_id uuid,product_name text,amount_cents bigint,
  promotion_id uuid,priority integer,rule_type public.promotion_rule_type,
  group_quantity integer,group_price_cents bigint,max_groups_per_line integer,
  percentage_basis_points integer,fixed_unit_price_cents bigint
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
  select v_quoted_at,product.id,product.name,price.amount_cents,promo.id,promo.priority,
    promo.rule_type,promo.group_quantity,promo.group_price_cents,promo.max_groups_per_line,
    promo.percentage_basis_points,promo.fixed_unit_price_cents
  from public.products product
  join public.categories category on category.id=product.category_id and category.active
  join lateral(
    select candidate.amount_cents from public.product_prices candidate
    where candidate.product_id=product.id and candidate.valid_from<=v_quoted_at
      and (candidate.valid_to is null or candidate.valid_to>v_quoted_at)
    order by candidate.valid_from desc limit 1
  ) price on true
  left join lateral(
    select candidate.id,candidate.priority,
      coalesce(quantity_rule.rule_type,percentage_rule.rule_type,fixed_rule.rule_type) rule_type,
      quantity_rule.group_quantity,quantity_rule.group_price_cents,quantity_rule.max_groups_per_line,
      percentage_rule.percentage_basis_points,fixed_rule.fixed_unit_price_cents
    from public.promotion_products scope
    join public.promotions candidate on candidate.id=scope.promotion_id
    left join public.promotion_quantity_price_rules quantity_rule on quantity_rule.promotion_id=candidate.id
    left join public.promotion_percentage_rules percentage_rule on percentage_rule.promotion_id=candidate.id
    left join public.promotion_fixed_unit_price_rules fixed_rule on fixed_rule.promotion_id=candidate.id
    where scope.product_id=product.id and candidate.active and candidate.publicable
      and not candidate.cumulative
      and candidate.valid_from<=v_quoted_at and (candidate.valid_to is null or candidate.valid_to>v_quoted_at)
      and candidate.global_redemption_limit is null and candidate.per_user_redemption_limit is null
      and exists(select 1 from public.promotion_channels channel_scope
        where channel_scope.promotion_id=candidate.id and channel_scope.channel=p_channel)
      and coalesce(quantity_rule.rule_type,percentage_rule.rule_type,fixed_rule.rule_type) is not null
  ) promo on true
  where product.id=any(p_product_ids) and product.active
    and case p_channel when 'PORTAL' then product.published when 'PDV' then product.sellable_pdv else false end
  order by product.id,promo.priority desc nulls last,promo.id;
end;
$$;

revoke all on function public.get_pricing_quote_inputs_v2(public.promotion_channel,uuid[])
from public,anon,authenticated,service_role;
grant execute on function public.get_pricing_quote_inputs_v2(public.promotion_channel,uuid[])
to anon,authenticated;

create or replace function private.price_sale_items(
  p_channel public.promotion_channel,p_items jsonb
)
returns jsonb language plpgsql set search_path='' as $$
declare
  v_item record; v_price record; v_product_sku text; v_quoted_at timestamptz;
  v_available_groups bigint; v_groups bigint; v_effective_unit bigint;
  v_original_subtotal bigint; v_effective_subtotal bigint; v_discount bigint;
  v_original_total bigint:=0; v_discount_total bigint:=0; v_total bigint:=0;
  v_promotion_snapshot jsonb; v_lines jsonb:='[]'::jsonb; v_rounded boolean:=false;
begin
  for v_item in select item.product_id,item.quantity
    from jsonb_to_recordset(p_items) item(product_id uuid,quantity bigint) order by item.product_id
  loop
    -- Same fail-closed contract as the domain: a configured promotion must never charge more than the base price.
    if exists(
      select 1 from public.get_pricing_quote_inputs_v2(p_channel,array[v_item.product_id]) candidate
      where candidate.rule_type='QUANTIDADE_PRECO'
        and candidate.group_price_cents>=candidate.amount_cents*candidate.group_quantity
    ) then raise exception using errcode='P0001',message='INVALID_PROMOTION_GROUP_PRICE'; end if;
    if exists(
      select 1 from public.get_pricing_quote_inputs_v2(p_channel,array[v_item.product_id]) candidate
      where candidate.rule_type='VALOR_FIXO_UNITARIO'
        and candidate.fixed_unit_price_cents>=candidate.amount_cents
    ) then raise exception using errcode='P0001',message='INVALID_PROMOTION_FIXED_PRICE'; end if;

    select candidate.* into v_price
    from public.get_pricing_quote_inputs_v2(p_channel,array[v_item.product_id]) candidate
    order by
      case when candidate.promotion_id is null then 1
        when candidate.rule_type='QUANTIDADE_PRECO'
          and floor(v_item.quantity::numeric/candidate.group_quantity)::bigint=0 then 1
        else 0 end,
      candidate.priority desc nulls last,
      case candidate.rule_type
        when 'QUANTIDADE_PRECO' then
          candidate.group_price_cents*least(floor(v_item.quantity::numeric/candidate.group_quantity)::bigint,
            coalesce(candidate.max_groups_per_line::bigint,9007199254740991))
          +candidate.amount_cents*(v_item.quantity-candidate.group_quantity*least(
            floor(v_item.quantity::numeric/candidate.group_quantity)::bigint,
            coalesce(candidate.max_groups_per_line::bigint,9007199254740991)))
        when 'PERCENTUAL' then
          floor((candidate.amount_cents*(10000-candidate.percentage_basis_points))::numeric/10000)::bigint*v_item.quantity
        when 'VALOR_FIXO_UNITARIO' then candidate.fixed_unit_price_cents*v_item.quantity
        else candidate.amount_cents*v_item.quantity end,
      candidate.promotion_id
    limit 1;
    if not found then raise exception using errcode='P0001',message='PRODUCT_UNAVAILABLE'; end if;
    select sku into v_product_sku from public.products where id=v_item.product_id;
    if v_quoted_at is null then v_quoted_at:=v_price.quoted_at;
    elsif v_quoted_at<>v_price.quoted_at then raise exception using errcode='P0001',message='PRICING_INSTANT_MISMATCH'; end if;

    v_original_subtotal:=v_price.amount_cents*v_item.quantity;
    v_promotion_snapshot:=null;
    if v_price.rule_type='QUANTIDADE_PRECO' then
      v_available_groups:=floor(v_item.quantity::numeric/v_price.group_quantity)::bigint;
      v_groups:=least(v_available_groups,coalesce(v_price.max_groups_per_line::bigint,v_available_groups));
      if v_groups>0 then
        v_effective_subtotal:=v_price.group_price_cents*v_groups
          +v_price.amount_cents*(v_item.quantity-v_groups*v_price.group_quantity);
        v_discount:=v_original_subtotal-v_effective_subtotal;
        v_promotion_snapshot:=jsonb_build_object(
          'promotion_id',v_price.promotion_id,'type',v_price.rule_type,'priority',v_price.priority,
          'group_quantity',v_price.group_quantity,'group_price_cents',v_price.group_price_cents,
          'max_groups_per_line',v_price.max_groups_per_line,'groups',v_groups,
          'promoted_quantity',v_groups*v_price.group_quantity,
          'remainder_quantity',v_item.quantity-v_groups*v_price.group_quantity,'savings_cents',v_discount);
      else v_effective_subtotal:=v_original_subtotal; v_discount:=0; end if;
    elsif v_price.rule_type='PERCENTUAL' then
      v_effective_unit:=floor((v_price.amount_cents*(10000-v_price.percentage_basis_points))::numeric/10000)::bigint;
      v_effective_subtotal:=v_effective_unit*v_item.quantity;
      v_discount:=v_original_subtotal-v_effective_subtotal;
      if v_discount>0 then
        v_rounded:=true;
        v_promotion_snapshot:=jsonb_build_object(
          'promotion_id',v_price.promotion_id,'type',v_price.rule_type,'priority',v_price.priority,
          'percentage_basis_points',v_price.percentage_basis_points,
          'discounted_unit_price_cents',v_effective_unit,'savings_cents',v_discount);
      end if;
    elsif v_price.rule_type='VALOR_FIXO_UNITARIO' then
      v_effective_subtotal:=v_price.fixed_unit_price_cents*v_item.quantity;
      v_discount:=v_original_subtotal-v_effective_subtotal;
      v_promotion_snapshot:=jsonb_build_object(
        'promotion_id',v_price.promotion_id,'type',v_price.rule_type,'priority',v_price.priority,
        'fixed_unit_price_cents',v_price.fixed_unit_price_cents,'savings_cents',v_discount);
    else v_effective_subtotal:=v_original_subtotal; v_discount:=0; end if;

    if v_original_subtotal>9007199254740991 or v_effective_subtotal>9007199254740991 then
      raise exception using errcode='22003',message='MONEY_OVERFLOW'; end if;
    v_original_total:=v_original_total+v_original_subtotal;
    v_discount_total:=v_discount_total+v_discount; v_total:=v_total+v_effective_subtotal;
    if v_original_total>9007199254740991 or v_total>9007199254740991 then
      raise exception using errcode='22003',message='MONEY_OVERFLOW'; end if;
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object(
      'product_id',v_item.product_id,'product_sku',v_product_sku,'product_name',v_price.product_name,
      'quantity',v_item.quantity,'unit_price_cents',v_price.amount_cents,
      'original_subtotal_cents',v_original_subtotal,'discount_cents',v_discount,
      'total_cents',v_effective_subtotal,
      'promotion_id',case when v_promotion_snapshot is null then null else v_price.promotion_id end,
      'promotion_snapshot',v_promotion_snapshot));
  end loop;
  return jsonb_build_object('quoted_at',v_quoted_at,'currency','BRL',
    'rounding',case when v_rounded then 'FLOOR_PER_UNIT' else 'NONE' end,
    'lines',v_lines,'original_total_cents',v_original_total,
    'discount_total_cents',v_discount_total,'total_cents',v_total);
end;
$$;

create function public.save_unit_promotion(
  p_promotion_id uuid,p_expected_revision integer,p_code text,p_name text,p_description text,
  p_active boolean,p_publicable boolean,p_priority integer,p_cumulative boolean,
  p_valid_from timestamptz,p_valid_to timestamptz,p_global_redemption_limit bigint,
  p_per_user_redemption_limit integer,p_product_ids uuid[],p_channels public.promotion_channel[],
  p_rule_type public.promotion_rule_type,p_percentage_basis_points integer,p_fixed_unit_price_cents bigint,
  p_reason text,p_idempotency_key text,p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid(); v_claim record; v_promotion public.promotions%rowtype;
  v_before jsonb; v_after jsonb; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('catalog.manage') then raise exception using errcode='42501',message='PROMOTION_MANAGE_FORBIDDEN'; end if;
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
    or p_rule_type not in ('PERCENTUAL','VALOR_FIXO_UNITARIO')
    or (p_rule_type='PERCENTUAL' and (p_percentage_basis_points not between 1 and 9999 or p_fixed_unit_price_cents is not null))
    or (p_rule_type='VALOR_FIXO_UNITARIO' and (p_fixed_unit_price_cents is null or p_fixed_unit_price_cents not between 0 and 9007199254740991 or p_percentage_basis_points is not null))
    or p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason<>btrim(p_reason)
    or p_correlation_id is null
    or (p_promotion_id is null and p_expected_revision is not null)
    or (p_promotion_id is not null and (p_expected_revision is null or p_expected_revision<1)) then
    raise exception using errcode='22023',message='INVALID_PROMOTION';
  end if;
  if (select count(*) from public.products where id=any(p_product_ids))<>cardinality(p_product_ids) then
    raise exception using errcode='P0002',message='PROMOTION_PRODUCT_NOT_FOUND'; end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('promotion','unit_save',v_actor),p_idempotency_key,
    jsonb_build_object('id',p_promotion_id,'revision',p_expected_revision,'code',p_code,'name',p_name,
      'description',p_description,'active',p_active,'publicable',p_publicable,'priority',p_priority,
      'cumulative',p_cumulative,'valid_from',p_valid_from,'valid_to',p_valid_to,
      'products',p_product_ids,'channels',p_channels,'rule_type',p_rule_type,
      'percentage_basis_points',p_percentage_basis_points,'fixed_unit_price_cents',p_fixed_unit_price_cents,
      'reason',p_reason));
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
    if exists(select 1 from public.promotion_quantity_price_rules where promotion_id=p_promotion_id) then
      raise exception using errcode='P0001',message='PROMOTION_RULE_TYPE_IMMUTABLE'; end if;
    v_before:=private.promotion_snapshot(p_promotion_id);
    update public.promotions set code=p_code,name=p_name,description=p_description,active=p_active,
      publicable=p_publicable,priority=p_priority,cumulative=p_cumulative,valid_from=p_valid_from,
      valid_to=p_valid_to,global_redemption_limit=p_global_redemption_limit,
      per_user_redemption_limit=p_per_user_redemption_limit,revision=revision+1
    where id=p_promotion_id returning * into v_promotion;
    perform set_config('app.promotion_command','on',true);
    delete from public.promotion_products where promotion_id=p_promotion_id;
    delete from public.promotion_channels where promotion_id=p_promotion_id;
    delete from public.promotion_percentage_rules where promotion_id=p_promotion_id;
    delete from public.promotion_fixed_unit_price_rules where promotion_id=p_promotion_id;
  end if;
  insert into public.promotion_products(promotion_id,product_id)
    select v_promotion.id,item from unnest(p_product_ids) item;
  insert into public.promotion_channels(promotion_id,channel)
    select v_promotion.id,item from unnest(p_channels) item;
  if p_rule_type='PERCENTUAL' then
    insert into public.promotion_percentage_rules(promotion_id,percentage_basis_points)
      values(v_promotion.id,p_percentage_basis_points);
  else
    insert into public.promotion_fixed_unit_price_rules(promotion_id,fixed_unit_price_cents)
      values(v_promotion.id,p_fixed_unit_price_cents);
  end if;
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

revoke all on function private.assert_single_promotion_rule() from public,anon,authenticated,service_role;
revoke all on function private.promotion_snapshot(uuid) from public,anon,authenticated,service_role;
revoke all on function public.save_unit_promotion(uuid,integer,text,text,text,boolean,boolean,integer,boolean,timestamptz,timestamptz,bigint,integer,uuid[],public.promotion_channel[],public.promotion_rule_type,integer,bigint,text,text,uuid)
from public,anon,authenticated,service_role;
grant execute on function public.save_unit_promotion(uuid,integer,text,text,text,boolean,boolean,integer,boolean,timestamptz,timestamptz,bigint,integer,uuid[],public.promotion_channel[],public.promotion_rule_type,integer,bigint,text,text,uuid)
to authenticated;

comment on table public.promotion_percentage_rules is 'Percentage discounts stored as integer basis points.';
comment on table public.promotion_fixed_unit_price_rules is 'Promotional unit prices stored in integer cents.';
comment on function public.get_pricing_quote_inputs_v2(public.promotion_channel,uuid[]) is 'Resolves unlimited, non-cumulative quantity, percentage and fixed unit-price candidates at one database instant.';
comment on function public.save_unit_promotion(uuid,integer,text,text,text,boolean,boolean,integer,boolean,timestamptz,timestamptz,bigint,integer,uuid[],public.promotion_channel[],public.promotion_rule_type,integer,bigint,text,text,uuid) is 'Audited and revisioned administration for percentage and fixed unit-price promotions.';
