-- H1: automatic lot codes PREFIX-DDMMYY-NN reserved by the database. Deterministic prefix from the product name, one
-- counter per cohort + prefix + day under a row lock (never the same code twice, above codes typed by hand), permission
-- and cohort enforced, existing lots untouched.
begin;
select plan(20);
create temp table lots_before as select id, lot_code from cohort_data.inventory_lots;

-- Prefix: initial of the first word + two letters of the second; accents and connectives ignored; deterministic.
select results_eq($$select private.purchase_lot_prefix(n) from unnest(array['Brownie Kinder','Brownie Ninho','Brownie Marshmallow',
  'Bolo de pote Ninho','Pão de mel','Coxinha','Pé de moleque','Doce','Ab',' ','Café & Cia 2']) with ordinality as t(n, i) order by i$$,
  $$values ('BKI'),('BNI'),('BMA'),('BPO'),('PME'),('COX'),('PMO'),('DOC'),('ABX'),('LOT'),('CCI')$$,
  'the prefix follows the lots typed by hand (BKI, BNI, BMA, BPO) and is complete for short names');
select is(private.purchase_lot_prefix('Brownie Kinder'), private.purchase_lot_prefix('BROWNIE   kinder!'), 'the prefix ignores case, spacing and punctuation');

-- Privileges: only the definer command reaches the counter.
select ok(not has_table_privilege('authenticated', 'private.purchase_lot_code_counters', 'SELECT')
  and not has_table_privilege('authenticated', 'private.purchase_lot_code_counters', 'INSERT'), 'the counter is not reachable directly');
select ok(not has_function_privilege('anon', 'public.reserve_purchase_lot_code(uuid,date)', 'EXECUTE'), 'anonymous cannot reserve lot codes');

-- An order with two products whose names share a prefix (Item público A / B -> IPU).
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table lot_supplier as select public.save_supplier(null, null, 'Fornecedor de lotes', 'Ana', null, null, null, null, true, 'Preparar lotes', 'lot-code-supplier', gen_random_uuid()) result;
create temp table lot_order as select public.create_purchase_order(
  (select (result ->> 'id')::uuid from lot_supplier), (now() at time zone 'America/Sao_Paulo')::date - 3, null, 0, 0, 'PIX', null, null,
  '[{"productId":"33f00000-0000-4000-8000-000000000001","quantity":5,"unitCostCents":500},{"productId":"33f00000-0000-4000-8000-000000000003","quantity":5,"unitCostCents":500}]'::jsonb,
  'Repor itens', 'lot-code-order', gen_random_uuid()) result;
create temp table lot_items as select item.id, item.product_id from public.purchase_order_items item where item.order_id = (select (result ->> 'id')::uuid from lot_order);
grant select on lot_items, lot_order to authenticated;
create function pg_temp.item(p_product text) returns uuid language sql as $$ select id from lot_items where product_id = p_product::uuid $$;
create function pg_temp.day(p_offset integer) returns date language sql as $$ select (now() at time zone 'America/Sao_Paulo')::date - p_offset $$;
create function pg_temp.dd(p_offset integer) returns text language sql as $$ select to_char(pg_temp.day(p_offset), 'DDMMYY') $$;

select is(public.reserve_purchase_lot_code(pg_temp.item('33f00000-0000-4000-8000-000000000001'), pg_temp.day(0)) ->> 'lot_code',
  'IPU-' || pg_temp.dd(0) || '-01', 'the first code of the day is PREFIX-DDMMYY-01');
select is(public.reserve_purchase_lot_code(pg_temp.item('33f00000-0000-4000-8000-000000000001'), pg_temp.day(0)) ->> 'lot_code',
  'IPU-' || pg_temp.dd(0) || '-02', 'the next reservation never repeats a number');
select is(public.reserve_purchase_lot_code(pg_temp.item('33f00000-0000-4000-8000-000000000003'), pg_temp.day(0)) ->> 'lot_code',
  'IPU-' || pg_temp.dd(0) || '-03', 'another product with the same prefix continues the counter (no collision)');
select is(public.reserve_purchase_lot_code(pg_temp.item('33f00000-0000-4000-8000-000000000001'), pg_temp.day(1)) ->> 'lot_code',
  'IPU-' || pg_temp.dd(1) || '-01', 'each delivery day starts its own sequence');
select is((public.reserve_purchase_lot_code(pg_temp.item('33f00000-0000-4000-8000-000000000001'), pg_temp.day(0)) ->> 'sequence')::integer, 4,
  'the sequence is reported');

-- A code typed by hand in the same pattern is never generated again.
select lives_ok($$select public.receive_purchase_order_item((select (result ->> 'id')::uuid from lot_order), pg_temp.item('33f00000-0000-4000-8000-000000000003'), 1,
  pg_temp.day(2), 'IPU-' || pg_temp.dd(2) || '-07', null, null, 'Lote digitado do fornecedor', 'lot-code-manual', gen_random_uuid())$$, 'a lot typed by hand is received');
select is(public.reserve_purchase_lot_code(pg_temp.item('33f00000-0000-4000-8000-000000000001'), pg_temp.day(2)) ->> 'lot_code',
  'IPU-' || pg_temp.dd(2) || '-08', 'the counter starts above the codes already typed');

-- The reserved code is a normal lot code for the receipt (and can still be edited by the person).
create temp table generated as select public.reserve_purchase_lot_code(pg_temp.item('33f00000-0000-4000-8000-000000000001'), pg_temp.day(0)) ->> 'lot_code' as code;
grant select on generated to authenticated;
select lives_ok($$select public.receive_purchase_order_item((select (result ->> 'id')::uuid from lot_order), pg_temp.item('33f00000-0000-4000-8000-000000000001'), 1,
  pg_temp.day(0), (select code from generated), null, null, 'Entrega sem lote do produtor', 'lot-code-generated', gen_random_uuid())$$, 'the generated code is accepted by the receipt');
select is((select count(*)::integer from public.inventory_lots where lot_code = (select code from generated)), 1, 'the lot keeps the generated code');

-- Rules: date, permission and cohort.
select throws_ok($$select public.reserve_purchase_lot_code(pg_temp.item('33f00000-0000-4000-8000-000000000001'), pg_temp.day(-1))$$,
  '22023', 'INVALID_LOT_CODE_REQUEST', 'a future delivery date is refused');
select throws_ok($$select public.reserve_purchase_lot_code(gen_random_uuid(), pg_temp.day(0))$$,
  'P0001', 'PURCHASE_ORDER_ITEM_NOT_FOUND', 'an unknown order item is refused');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.reserve_purchase_lot_code(pg_temp.item('33f00000-0000-4000-8000-000000000001'), pg_temp.day(0))$$,
  '42501', 'PROCUREMENT_MANAGE_FORBIDDEN', 'a seller cannot reserve lot codes');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
-- Another cohort never sees this cohort's order items.
reset role;
insert into public.cohorts (id, name, year, slug, status, is_default) values ('c0000000-0000-4000-8000-0000000002b0', 'Turma lotes B', 2027, 'turma-lotes-b', 'ACTIVE', false);
set local role authenticated;
set local "request.headers" = '{"x-germinatura-cohort":"c0000000-0000-4000-8000-0000000002b0"}';
select throws_ok($$select public.reserve_purchase_lot_code(pg_temp.item('33f00000-0000-4000-8000-000000000001'), pg_temp.day(0))$$,
  '42501', null, 'another cohort context cannot reserve codes for this order');
set local "request.headers" = '{}';
reset role;

-- Nothing else changed: existing lots keep their codes, CUTOVER-* untouched.
select ok(not exists (select 1 from lots_before before left join cohort_data.inventory_lots lot using (id) where lot.lot_code is distinct from before.lot_code),
  'existing lots (CUTOVER-* included) keep their codes');
select is((select count(*)::integer from private.purchase_lot_code_counters), 3, 'one counter per cohort, prefix and day');
select is((select last_number from private.purchase_lot_code_counters where prefix = 'IPU' and lot_day = pg_temp.day(0)), 5,
  'the counter holds the last number reserved');

select * from finish();
rollback;
