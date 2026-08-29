begin;
select plan(51);

select has_table('public', 'promotions', 'promotions table exists');
select has_table('public', 'promotion_products', 'promotion product scopes table exists');
select has_table('public', 'promotion_channels', 'promotion channels table exists');
select has_table('public', 'promotion_quantity_price_rules', 'quantity price rules table exists');
select has_view('public', 'current_quantity_price_promotions', 'current quantity promotion view exists');
select col_type_is('public', 'promotions', 'global_redemption_limit', 'bigint', 'global limit uses bigint');
select col_type_is('public', 'promotion_quantity_price_rules', 'group_price_cents', 'bigint', 'group price uses bigint cents');
select col_type_is('public', 'promotion_quantity_price_rules', 'rule_type', 'promotion_rule_type', 'rule type is constrained by enum');
select col_type_is('public', 'promotion_channels', 'channel', 'promotion_channel', 'channel is constrained by enum');
select results_eq(
  $$select count(*)::bigint from pg_enum join pg_type on pg_type.oid = enumtypid where typname = 'promotion_rule_type' and enumlabel::text = 'QUANTIDADE_PRECO'$$,
  array[1::bigint],
  'only QUANTIDADE_PRECO is represented as executable'
);
select results_eq(
  $$select count(*)::bigint from pg_enum join pg_type on pg_type.oid = enumtypid where typname = 'promotion_channel' and enumlabel::text in ('PORTAL', 'PDV', 'RESERVA')$$,
  array[3::bigint],
  'promotion channels are explicit'
);
select results_eq(
  $$select coalesce(reloptions @> array['security_invoker=true'], false) from pg_class where oid = 'public.current_quantity_price_promotions'::regclass$$,
  array[true],
  'current promotion view invokes underlying RLS'
);
select results_eq(
  $$select count(*)::bigint from pg_class where oid in ('public.promotions'::regclass, 'public.promotion_products'::regclass, 'public.promotion_channels'::regclass, 'public.promotion_quantity_price_rules'::regclass) and relrowsecurity$$,
  array[4::bigint],
  'all promotion tables have RLS enabled'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename in ('promotions', 'promotion_products', 'promotion_channels', 'promotion_quantity_price_rules') and cmd in ('INSERT', 'UPDATE', 'DELETE')$$,
  array[0::bigint],
  'promotion tables have no direct write policies'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name in ('promotions', 'promotion_products', 'promotion_channels', 'promotion_quantity_price_rules', 'current_quantity_price_promotions') and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint],
  'Data API roles receive no promotion write grants'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name in ('promotions', 'promotion_products', 'promotion_channels', 'promotion_quantity_price_rules', 'current_quantity_price_promotions') and grantee = 'service_role'$$,
  array[0::bigint],
  'service role receives no direct promotion grants'
);
select has_index('public', 'promotions', 'promotions_current_lookup_idx', 'current promotion lookup is indexed');
select has_index('public', 'promotion_products', 'promotion_products_product_idx', 'product scope lookup is indexed');
select has_index('public', 'promotion_channels', 'promotion_channels_channel_idx', 'channel lookup is indexed');

select throws_ok(
  $$insert into public.promotions (code, name, valid_from) values ('invalid-code', 'Inválida', now())$$,
  '23514', null, 'promotion code must be canonical'
);
select throws_ok(
  $$insert into public.promotions (code, name, valid_from, valid_to) values ('INVALID-DATES', 'Inválida', now(), now())$$,
  '23514', null, 'empty validity interval is rejected'
);
select throws_ok(
  $$insert into public.promotions (code, name, priority, valid_from) values ('INVALID-PRIORITY', 'Inválida', 1001, now())$$,
  '23514', null, 'priority outside the supported range is rejected'
);
select throws_ok(
  $$insert into public.promotions (code, name, global_redemption_limit, valid_from) values ('INVALID-GLOBAL', 'Inválida', 0, now())$$,
  '23514', null, 'non-positive global limit is rejected'
);
select throws_ok(
  $$insert into public.promotions (code, name, per_user_redemption_limit, valid_from) values ('INVALID-USER', 'Inválida', 0, now())$$,
  '23514', null, 'non-positive per-user limit is rejected'
);

insert into public.categories (id, name, slug, active, sort_order) values
  ('24000000-0000-4000-8000-000000000001', 'Promoções', 'promocoes', true, 20);
insert into public.products (
  id, category_id, sku, slug, name, active, published, sellable_pdv, reservable
) values
  ('34000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 'PROMO-ITEM', 'promo-item', 'Produto promocional', true, true, true, true),
  ('34000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000001', 'PROMO-HIDDEN', 'promo-hidden', 'Produto interno', true, false, true, false);

insert into public.promotions (
  id, code, name, active, publicable, priority, cumulative, valid_from, valid_to,
  global_redemption_limit, per_user_redemption_limit
) values (
  '60000000-0000-4000-8000-000000000001', 'QTY-A', 'Duas por dez', true, true, 100, false,
  now() - interval '1 day', now() + interval '1 day', 100, 2
);
insert into public.promotion_products (promotion_id, product_id) values
  ('60000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000001');
insert into public.promotion_channels (promotion_id, channel) values
  ('60000000-0000-4000-8000-000000000001', 'PORTAL'),
  ('60000000-0000-4000-8000-000000000001', 'PDV'),
  ('60000000-0000-4000-8000-000000000001', 'RESERVA');
insert into public.promotion_quantity_price_rules (
  promotion_id, group_quantity, group_price_cents, max_groups_per_line
) values ('60000000-0000-4000-8000-000000000001', 2, 1000, 2);

select throws_ok(
  $$insert into public.promotion_quantity_price_rules (promotion_id, group_quantity, group_price_cents) values ('60000000-0000-4000-8000-000000000001', 1, 1000)$$,
  '23514', null, 'group quantity below two is rejected'
);
select throws_ok(
  $$update public.promotion_quantity_price_rules set group_price_cents = -1 where promotion_id = '60000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'negative group price is rejected'
);
select throws_ok(
  $$update public.promotion_quantity_price_rules set group_price_cents = 9007199254740992 where promotion_id = '60000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'group price above the TypeScript safe integer is rejected'
);
select throws_ok(
  $$update public.promotion_quantity_price_rules set max_groups_per_line = 0 where promotion_id = '60000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'non-positive group limit is rejected'
);
select throws_ok(
  $$insert into public.promotion_channels (promotion_id, channel) values ('60000000-0000-4000-8000-000000000001', 'LOJA')$$,
  '22P02', null, 'unknown channel is rejected'
);
select throws_ok(
  $$insert into public.promotion_quantity_price_rules (promotion_id, rule_type, group_quantity, group_price_cents) values ('60000000-0000-4000-8000-000000000001', 'PERCENTUAL', 2, 1000)$$,
  '22P02', null, 'unimplemented promotion type is rejected'
);
select throws_ok(
  $$insert into public.promotion_products (promotion_id, product_id) values ('60000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000001')$$,
  '23505', null, 'duplicate product scope is rejected'
);

select lives_ok($$
  insert into public.promotions (
    id, code, name, active, publicable, priority, valid_from, valid_to
  ) values (
    '60000000-0000-4000-8000-000000000002', 'QTY-B', 'Concorrente prioritária', true, true, 200,
    now() - interval '12 hours', now() + interval '12 hours'
  );
  insert into public.promotion_products (promotion_id, product_id) values
    ('60000000-0000-4000-8000-000000000002', '34000000-0000-4000-8000-000000000001');
  insert into public.promotion_channels (promotion_id, channel) values
    ('60000000-0000-4000-8000-000000000002', 'PDV');
  insert into public.promotion_quantity_price_rules (promotion_id, group_quantity, group_price_cents) values
    ('60000000-0000-4000-8000-000000000002', 3, 1200);
$$, 'overlapping product/channel promotions are allowed for priority resolution');

insert into public.promotions (
  id, code, name, active, publicable, priority, valid_from, valid_to
) values
  ('60000000-0000-4000-8000-000000000003', 'QTY-EXPIRED', 'Expirada', true, true, 10, now() - interval '2 days', now() - interval '1 day'),
  ('60000000-0000-4000-8000-000000000004', 'QTY-FUTURE', 'Futura', true, true, 10, now() + interval '1 day', now() + interval '2 days'),
  ('60000000-0000-4000-8000-000000000005', 'QTY-INACTIVE', 'Inativa', false, true, 10, now() - interval '1 day', now() + interval '1 day'),
  ('60000000-0000-4000-8000-000000000006', 'QTY-PRIVATE', 'Privada', true, false, 10, now() - interval '1 day', now() + interval '1 day'),
  ('60000000-0000-4000-8000-000000000007', 'QTY-HIDDEN', 'Produto interno', true, true, 50, now() - interval '1 day', now() + interval '1 day');
insert into public.promotion_products (promotion_id, product_id)
select id, case when code = 'QTY-HIDDEN'
  then '34000000-0000-4000-8000-000000000002'::uuid
  else '34000000-0000-4000-8000-000000000001'::uuid end
from public.promotions where id between '60000000-0000-4000-8000-000000000003' and '60000000-0000-4000-8000-000000000007';
insert into public.promotion_channels (promotion_id, channel)
select id, case when code = 'QTY-HIDDEN' then 'PDV'::public.promotion_channel else 'PORTAL'::public.promotion_channel end
from public.promotions where id between '60000000-0000-4000-8000-000000000003' and '60000000-0000-4000-8000-000000000007';
insert into public.promotion_quantity_price_rules (promotion_id, group_quantity, group_price_cents)
select id, 2, 900 from public.promotions
where id between '60000000-0000-4000-8000-000000000003' and '60000000-0000-4000-8000-000000000007';

select results_eq(
  $$select count(*)::bigint from public.current_quantity_price_promotions$$,
  array[5::bigint],
  'current view includes overlapping and internal channel-compatible rules for the manager context'
);
select results_eq(
  $$select count(*)::bigint from public.current_quantity_price_promotions where code = 'QTY-EXPIRED'$$,
  array[0::bigint],
  'expired promotions are absent from the current view'
);
select results_eq(
  $$select count(*)::bigint from public.current_quantity_price_promotions where code = 'QTY-FUTURE'$$,
  array[0::bigint],
  'future promotions are absent from the current view'
);
select results_eq(
  $$select count(*)::bigint from public.current_quantity_price_promotions where code in ('QTY-INACTIVE', 'QTY-PRIVATE')$$,
  array[0::bigint],
  'inactive and non-publicable promotions are absent from the current view'
);

set local role anon;
select results_eq($$select count(*)::bigint from public.promotions$$, array[3::bigint], 'anonymous users see only current active publicable promotions');
select results_eq($$select count(*)::bigint from public.promotion_products$$, array[2::bigint], 'anonymous product scopes include only public catalog products');
select results_eq(
  $$select channel::text, count(*)::bigint from public.current_quantity_price_promotions group by channel order by channel::text$$,
  $$values ('PDV'::text, 2::bigint), ('PORTAL'::text, 1::bigint), ('RESERVA'::text, 1::bigint)$$,
  'anonymous current view preserves channel scope without exposing internal products'
);
select throws_ok(
  $$insert into public.promotions (code, name, valid_from) values ('DIRECT-ANON', 'Direta', now())$$,
  '42501', null, 'anonymous promotion writes are denied'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select results_eq($$select count(*)::bigint from public.promotions$$, array[3::bigint], 'consumer sees only current active publicable promotions');
select results_eq($$select count(*)::bigint from public.current_quantity_price_promotions$$, array[4::bigint], 'consumer current view matches the public read model');
select throws_ok(
  $$update public.promotions set priority = 999 where code = 'QTY-A'$$,
  '42501', null, 'consumer direct updates are denied'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq($$select count(*)::bigint from public.promotions$$, array[7::bigint], 'catalog manager reads complete promotion history');
select results_eq($$select count(*)::bigint from public.current_quantity_price_promotions$$, array[5::bigint], 'catalog manager current view includes eligible internal PDV products');
select throws_ok(
  $$insert into public.promotions (code, name, valid_from) values ('DIRECT-ADMIN', 'Direta', now())$$,
  '42501', null, 'catalog manager still cannot write tables directly'
);
select results_eq(
  $$select array_agg(code order by priority desc, code) from public.current_quantity_price_promotions where channel = 'PDV'$$,
  $$values (array['QTY-B'::text, 'QTY-A'::text, 'QTY-HIDDEN'::text])$$,
  'overlapping PDV candidates expose deterministic priority order to authoritative pricing'
);
reset role;

select results_eq(
  $$select count(*)::bigint from public.current_quantity_price_promotions where channel = 'PORTAL'$$,
  array[1::bigint],
  'current query filters by channel'
);
select throws_ok(
  $$delete from public.promotion_quantity_price_rules where promotion_id = '60000000-0000-4000-8000-000000000001'$$,
  'P0001', 'PROMOTION_HARD_DELETE_FORBIDDEN', 'promotion rules cannot be hard deleted'
);
select throws_ok(
  $$delete from public.promotions where id = '60000000-0000-4000-8000-000000000001'$$,
  'P0001', 'PROMOTION_HARD_DELETE_FORBIDDEN', 'promotions cannot be hard deleted'
);
update public.promotions set name = 'Duas por dez atualizada' where id = '60000000-0000-4000-8000-000000000001';
select ok(
  (select updated_at >= created_at from public.promotions where id = '60000000-0000-4000-8000-000000000001'),
  'promotion updates maintain updated_at'
);

select * from finish();
rollback;
