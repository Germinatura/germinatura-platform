begin;
select plan(10);

select has_function(
  'public', 'get_pricing_quote_inputs', array['promotion_channel', 'uuid[]'],
  'authoritative pricing input resolver exists'
);
select function_privs_are(
  'public', 'get_pricing_quote_inputs', array['promotion_channel', 'uuid[]'], 'anon', array['EXECUTE'],
  'anonymous clients may resolve public quote inputs'
);

insert into public.categories (id, name, slug) values
  ('25000000-0000-4000-8000-000000000001', 'Cotação', 'cotacao');
insert into public.products (
  id, category_id, sku, slug, name, active, published, sellable_pdv
) values
  ('35000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000001', 'QUOTE-PUBLIC', 'quote-public', 'Produto cotável', true, true, true),
  ('35000000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000001', 'QUOTE-PDV', 'quote-pdv', 'Produto apenas PDV', true, false, true),
  ('35000000-0000-4000-8000-000000000003', '25000000-0000-4000-8000-000000000001', 'QUOTE-NOPRICE', 'quote-noprice', 'Produto sem preço', true, true, true);
insert into public.product_prices (product_id, amount_cents, valid_from, valid_to) values
  ('35000000-0000-4000-8000-000000000001', 1500, now() - interval '1 day', now() + interval '1 day'),
  ('35000000-0000-4000-8000-000000000002', 1700, now() - interval '1 day', now() + interval '1 day'),
  ('35000000-0000-4000-8000-000000000003', 900, now() - interval '2 days', now() - interval '1 day');

insert into public.promotions (
  id, code, name, active, publicable, priority, valid_from, valid_to,
  global_redemption_limit
) values
  ('61000000-0000-4000-8000-000000000001', 'QUOTE-QTY', 'Duas por dez', true, true, 100, now() - interval '1 day', now() + interval '1 day', null),
  ('61000000-0000-4000-8000-000000000002', 'QUOTE-EXPIRED', 'Expirada', true, true, 999, now() - interval '2 days', now() - interval '1 day', null),
  ('61000000-0000-4000-8000-000000000003', 'QUOTE-LIMITED', 'Limitada', true, true, 999, now() - interval '1 day', now() + interval '1 day', 1);
insert into public.promotion_products (promotion_id, product_id)
select id, '35000000-0000-4000-8000-000000000001' from public.promotions
where id between '61000000-0000-4000-8000-000000000001' and '61000000-0000-4000-8000-000000000003';
insert into public.promotion_channels (promotion_id, channel)
select id, 'PORTAL' from public.promotions
where id between '61000000-0000-4000-8000-000000000001' and '61000000-0000-4000-8000-000000000003';
insert into public.promotion_quantity_price_rules (promotion_id, group_quantity, group_price_cents)
select id, 2, case when code = 'QUOTE-QTY' then 1000 else 500 end from public.promotions
where id between '61000000-0000-4000-8000-000000000001' and '61000000-0000-4000-8000-000000000003';

set local role anon;
select results_eq(
  $$select product_id, amount_cents, promotion_id from public.get_pricing_quote_inputs('PORTAL', array['35000000-0000-4000-8000-000000000001'::uuid])$$,
  $$values ('35000000-0000-4000-8000-000000000001'::uuid, 1500::bigint, '61000000-0000-4000-8000-000000000001'::uuid)$$,
  'public quote resolves the current price and executable promotion only'
);
select is(
  (select count(distinct quoted_at) from public.get_pricing_quote_inputs('PORTAL', array['35000000-0000-4000-8000-000000000001'::uuid])),
  1::bigint,
  'all quote inputs share one database instant'
);
select is_empty(
  $$select * from public.get_pricing_quote_inputs('PORTAL', array['35000000-0000-4000-8000-000000000002'::uuid])$$,
  'public channel hides unpublished products'
);
select is_empty(
  $$select * from public.get_pricing_quote_inputs('PORTAL', array['35000000-0000-4000-8000-000000000003'::uuid])$$,
  'products without a current price are unavailable'
);
select throws_ok(
  $$select * from public.get_pricing_quote_inputs('RESERVA', array['35000000-0000-4000-8000-000000000001'::uuid])$$,
  '22023', 'PRICING_CHANNEL_UNSUPPORTED', 'unsupported quote channel fails closed'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select * from public.get_pricing_quote_inputs('PDV', array['35000000-0000-4000-8000-000000000002'::uuid])$$,
  '42501', 'PRICING_PDV_FORBIDDEN', 'consumer cannot resolve PDV pricing'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select product_id, amount_cents from public.get_pricing_quote_inputs('PDV', array['35000000-0000-4000-8000-000000000002'::uuid])$$,
  $$values ('35000000-0000-4000-8000-000000000002'::uuid, 1700::bigint)$$,
  'seller with sales.create resolves internal PDV pricing'
);
select throws_ok(
  $$select * from public.get_pricing_quote_inputs('PDV', array['35000000-0000-4000-8000-000000000002'::uuid, '35000000-0000-4000-8000-000000000002'::uuid])$$,
  '22023', 'PRICING_PRODUCTS_INVALID', 'duplicate products are rejected at the database boundary'
);
reset role;

select * from finish();
rollback;
