-- COMBO_MIX and PROMO-005 allocation. Mirrors the domain tests: A R$ 25,90 x 3, B R$ 19,90 x 2, A+B por R$ 35,00.
begin;
select plan(22);

insert into public.products(id,category_id,sku,slug,name,active,published,sellable_pdv,reservable)
values('35c00000-0000-4000-8000-000000000002','23f00000-0000-4000-8000-000000000001','COMBO-ITEM-B','combo-item-b','Item combo B',true,true,true,true);
insert into public.product_prices(product_id,amount_cents,valid_from)
values('35c00000-0000-4000-8000-000000000002',1990,'2026-01-01T00:00:00Z');

select has_table('public','promotion_combo_rules','combo rules table exists');
select has_table('public','promotion_combo_components','combo components table exists');
select ok(not has_table_privilege('authenticated','public.promotion_combo_components','INSERT'),'components deny direct insert');

create function pg_temp.save(p_code text,p_rule jsonb,p_key text,p_products uuid[],p_priority integer default 300,p_id uuid default null,p_revision integer default null)
returns jsonb language sql as $$
  select public.save_promotion(p_id,p_revision,p_code,p_code,null,true,true,p_priority,false,now()-interval '1 hour',null,null,null,
    p_products,array['PORTAL']::public.promotion_channel[],p_rule,'Teste combo',p_key,gen_random_uuid());
$$;
create function pg_temp.quote(p_a integer,p_b integer) returns jsonb language sql as $$
  select private.price_sale_items('PORTAL',jsonb_build_array(
    jsonb_build_object('product_id','33f00000-0000-4000-8000-000000000001','quantity',p_a),
    jsonb_build_object('product_id','35c00000-0000-4000-8000-000000000002','quantity',p_b)));
$$;

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.save('COMBO-ONE','{"type":"COMBO_MIX","components":[{"productId":"33f00000-0000-4000-8000-000000000001","quantity":1}],"comboPriceCents":1000,"maxCombosPerCart":null}','combo-one',array['33f00000-0000-4000-8000-000000000001']::uuid[])$$,'22023','INVALID_PROMOTION','a combo needs at least two products');
select throws_ok($$select pg_temp.save('COMBO-DUP','{"type":"COMBO_MIX","components":[{"productId":"33f00000-0000-4000-8000-000000000001","quantity":1},{"productId":"33f00000-0000-4000-8000-000000000001","quantity":2}],"comboPriceCents":1000,"maxCombosPerCart":null}','combo-dup',array['33f00000-0000-4000-8000-000000000001']::uuid[])$$,'22023','INVALID_PROMOTION','components must be distinct');
select throws_ok($$select pg_temp.save('COMBO-SCOPE','{"type":"COMBO_MIX","components":[{"productId":"33f00000-0000-4000-8000-000000000001","quantity":1},{"productId":"35c00000-0000-4000-8000-000000000002","quantity":1}],"comboPriceCents":3500,"maxCombosPerCart":null}','combo-scope',array['33f00000-0000-4000-8000-000000000001']::uuid[])$$,'22023','INVALID_PROMOTION','product scope must equal the component set');

create temp table combo as select pg_temp.save('COMBO-AB',
  '{"type":"COMBO_MIX","components":[{"productId":"35c00000-0000-4000-8000-000000000002","quantity":1},{"productId":"33f00000-0000-4000-8000-000000000001","quantity":1}],"comboPriceCents":3500,"maxCombosPerCart":null}',
  'combo-create',array['33f00000-0000-4000-8000-000000000001','35c00000-0000-4000-8000-000000000002']::uuid[]) result;
select is((select result->'rule'->'components'->0->>'productId' from combo),'33f00000-0000-4000-8000-000000000001','components are stored in product order');
reset role;

-- 2 combos: discount 2160 split over values 5180 (A) and 3980 (B) -> 1221 / 939 (largest remainder to B).
select is((pg_temp.quote(3,2)->>'total_cents')::bigint,9590::bigint,'combo total');
select is((pg_temp.quote(3,2)->>'discount_total_cents')::bigint,2160::bigint,'combo discount');
select is((pg_temp.quote(3,2)->'lines'->0->>'discount_cents')::bigint,1221::bigint,'line A receives its proportional share');
select is((pg_temp.quote(3,2)->'lines'->1->>'discount_cents')::bigint,939::bigint,'line B receives the spare cent by largest remainder');
select is((pg_temp.quote(3,2)->'lines'->0->'promotion_snapshot'->>'component_quantity'),'2','snapshot explains the units in combos');
select is((pg_temp.quote(3,2)->'lines'->1->'promotion_snapshot'->>'combos'),'2','snapshot explains the number of combos');
select is((pg_temp.quote(1,1)->>'total_cents')::bigint,3500::bigint,'one combo costs exactly the combo price');
select is((private.price_sale_items('PORTAL','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":3}]'::jsonb)->'lines'->0->>'promotion_id'),null,'missing component means no combo');

-- PROMO-004 against line rules on A.
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table percent_a as select pg_temp.save('COMBO-PCT-A','{"type":"PERCENTUAL","percentageBasisPoints":1000}','combo-pct',array['33f00000-0000-4000-8000-000000000001']::uuid[]) result;
reset role;
select is((pg_temp.quote(3,2)->'lines'->0->'promotion_snapshot'->>'type'),'COMBO_MIX','equal priority: the lower cart total wins (combo 9590 vs 10973)');
update public.promotions set priority=400 where id=(select (result->>'id')::uuid from percent_a);
select is((pg_temp.quote(3,2)->'lines'->0->'promotion_snapshot'->>'type'),'PERCENTUAL','a higher line priority keeps the line rule');
select is((pg_temp.quote(3,2)->'lines'->1->>'promotion_id'),null,'the other component stays at full price');
update public.promotions set priority=300 where id=(select (result->>'id')::uuid from percent_a);

-- A line joins at most one combo; a cheaper lower-priority combo does not stack.
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select pg_temp.save('COMBO-AB-LOW','{"type":"COMBO_MIX","components":[{"productId":"33f00000-0000-4000-8000-000000000001","quantity":1},{"productId":"35c00000-0000-4000-8000-000000000002","quantity":1}],"comboPriceCents":3000,"maxCombosPerCart":null}',
  'combo-low',array['33f00000-0000-4000-8000-000000000001','35c00000-0000-4000-8000-000000000002']::uuid[],100);
reset role;
select is((pg_temp.quote(3,2)->'lines'->0->>'promotion_id'),(select result->>'id' from combo),'the higher-priority combo takes the lines');
select is((pg_temp.quote(3,2)->>'discount_total_cents')::bigint,2160::bigint,'combos never stack on the same line');

-- Allocation helper and fail-closed price.
select is(private.allocate_combo_discount(1,'[{"product_id":"00000000-0000-4000-8000-00000000000b","value":100},{"product_id":"00000000-0000-4000-8000-00000000000a","value":100}]'::jsonb),
  '{"00000000-0000-4000-8000-00000000000a":1,"00000000-0000-4000-8000-00000000000b":0}'::jsonb,'equal remainders go to the smaller product_id');
update public.promotion_combo_rules set combo_price_cents=4580 where promotion_id=(select (result->>'id')::uuid from combo);
select throws_ok($$select pg_temp.quote(3,2)$$,'P0001','INVALID_PROMOTION_COMBO_PRICE','a combo that does not save fails closed');

select * from finish();
rollback;
