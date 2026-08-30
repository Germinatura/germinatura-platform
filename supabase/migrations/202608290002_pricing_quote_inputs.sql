create or replace function public.get_pricing_quote_inputs(
  p_channel public.promotion_channel,
  p_product_ids uuid[]
)
returns table (
  quoted_at timestamptz,
  product_id uuid,
  product_name text,
  amount_cents bigint,
  promotion_id uuid,
  priority integer,
  rule_type public.promotion_rule_type,
  group_quantity integer,
  group_price_cents bigint,
  max_groups_per_line integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quoted_at timestamptz := statement_timestamp();
begin
  if p_channel not in ('PORTAL', 'PDV') then
    raise exception using errcode = '22023', message = 'PRICING_CHANNEL_UNSUPPORTED';
  end if;
  if p_product_ids is null or cardinality(p_product_ids) not between 1 and 100
    or array_position(p_product_ids, null) is not null
    or cardinality(p_product_ids) <> (select count(distinct value) from unnest(p_product_ids) as value) then
    raise exception using errcode = '22023', message = 'PRICING_PRODUCTS_INVALID';
  end if;
  if p_channel = 'PDV' and (auth.uid() is null or not public.has_permission('sales.create')) then
    raise exception using errcode = '42501', message = 'PRICING_PDV_FORBIDDEN';
  end if;

  return query
  select
    v_quoted_at,
    product.id,
    product.name,
    price.amount_cents,
    promo.id,
    promo.priority,
    rule.rule_type,
    rule.group_quantity,
    rule.group_price_cents,
    rule.max_groups_per_line
  from public.products as product
  join public.categories as category on category.id = product.category_id and category.active
  join lateral (
    select candidate.amount_cents
    from public.product_prices as candidate
    where candidate.product_id = product.id
      and candidate.valid_from <= v_quoted_at
      and (candidate.valid_to is null or candidate.valid_to > v_quoted_at)
    order by candidate.valid_from desc
    limit 1
  ) as price on true
  left join lateral (
    select candidate.id, candidate.priority
    from public.promotion_products as scope
    join public.promotions as candidate on candidate.id = scope.promotion_id
    where scope.product_id = product.id
      and candidate.active and candidate.publicable
      and candidate.valid_from <= v_quoted_at
      and (candidate.valid_to is null or candidate.valid_to > v_quoted_at)
      and candidate.global_redemption_limit is null
      and candidate.per_user_redemption_limit is null
      and exists (
      select 1 from public.promotion_channels as channel_scope
      where channel_scope.promotion_id = candidate.id and channel_scope.channel = p_channel
    )
  ) as promo on true
  left join public.promotion_quantity_price_rules as rule on rule.promotion_id = promo.id
  where product.id = any(p_product_ids)
    and product.active
    and case p_channel
      when 'PORTAL' then product.published
      when 'PDV' then product.sellable_pdv
      else false
    end
  order by product.id, promo.priority desc nulls last, promo.id;
end;
$$;

revoke all on function public.get_pricing_quote_inputs(public.promotion_channel, uuid[])
from public, anon, authenticated, service_role;
grant execute on function public.get_pricing_quote_inputs(public.promotion_channel, uuid[])
to anon, authenticated;

comment on function public.get_pricing_quote_inputs(public.promotion_channel, uuid[]) is
  'Resolves eligible products, current prices and executable unlimited quantity promotions at one database instant. PDV requires sales.create.';
