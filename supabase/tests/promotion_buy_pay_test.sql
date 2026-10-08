begin;
select plan(30);

select has_table('cohort_data','promotion_buy_pay_rules','buy-pay rules table exists');
select has_function('public','save_promotion',array['uuid','integer','text','text','text','boolean','boolean','integer','boolean','timestamp with time zone','timestamp with time zone','bigint','integer','uuid[]','promotion_channel[]','jsonb','text','text','uuid'],'generic promotion command exists');
select ok(not has_function_privilege('anon','public.save_promotion(uuid,integer,text,text,text,boolean,boolean,integer,boolean,timestamp with time zone,timestamp with time zone,bigint,integer,uuid[],promotion_channel[],jsonb,text,text,uuid)','EXECUTE'),'anonymous cannot execute generic command');
select ok(not has_table_privilege('authenticated','public.promotion_buy_pay_rules','INSERT'),'buy-pay rules deny direct insert');
select throws_ok($$insert into public.promotion_buy_pay_rules(promotion_id,buy_quantity,pay_quantity) values(gen_random_uuid(),3,3)$$,'23514',null,'pay quantity must stay below buy quantity');

create function pg_temp.save(p_code text,p_rule jsonb,p_key text,p_id uuid default null,p_revision integer default null,p_active boolean default true)
returns jsonb language sql as $$
  select public.save_promotion(p_id,p_revision,p_code,p_code,null,p_active,p_active,300,false,now()-interval '1 hour',null,null,null,
    array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PORTAL']::public.promotion_channel[],p_rule,'Teste leve e pague',p_key,gen_random_uuid());
$$;

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select pg_temp.save('BP-CONSUMER','{"type":"LEVE_PAGUE","buyQuantity":3,"payQuantity":2,"maxGroupsPerLine":null}','bp-consumer')$$,'42501','PROMOTION_MANAGE_FORBIDDEN','consumer cannot manage promotions');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.save('BP-BAD-1','{"type":"LEVE_PAGUE","buyQuantity":3,"payQuantity":3,"maxGroupsPerLine":null}','bp-bad-1')$$,'22023','INVALID_PROMOTION','pay equal to buy is rejected');
select throws_ok($$select pg_temp.save('BP-BAD-2','{"type":"LEVE_PAGUE","buyQuantity":3,"payQuantity":2}','bp-bad-2')$$,'22023','INVALID_PROMOTION','missing nullable key is rejected');
select throws_ok($$select pg_temp.save('BP-BAD-3','{"type":"LEVE_PAGUE","buyQuantity":3,"payQuantity":2,"maxGroupsPerLine":null,"extra":1}','bp-bad-3')$$,'22023','INVALID_PROMOTION','unknown rule key is rejected');
select throws_ok($$select pg_temp.save('BP-BAD-4','{"type":"LEVE_PAGUE","buyQuantity":3.5,"payQuantity":2,"maxGroupsPerLine":null}','bp-bad-4')$$,'22023','INVALID_PROMOTION','fractional quantity is rejected');
select throws_ok($$select pg_temp.save('BP-BAD-5','{"type":"LEVE_PAGUE","buyQuantity":"3","payQuantity":2,"maxGroupsPerLine":null}','bp-bad-5')$$,'22023','INVALID_PROMOTION','string quantity is rejected');
select throws_ok($$select pg_temp.save('BP-BAD-6','{"type":"CUPOM"}','bp-bad-6')$$,'22023','INVALID_PROMOTION','unsupported rule type is rejected');
select throws_ok($$select pg_temp.save('BP-BAD-7','{"type":"PERCENTUAL","percentageBasisPoints":10000}','bp-bad-7')$$,'22023','INVALID_PROMOTION','generic command validates percentages too');

create temp table buy_pay as select pg_temp.save('BP-3X2','{"type":"LEVE_PAGUE","buyQuantity":3,"payQuantity":2,"maxGroupsPerLine":null}','bp-create') result;
select is((select result->'rule' from buy_pay),'{"type":"LEVE_PAGUE","buyQuantity":3,"payQuantity":2,"maxGroupsPerLine":null}'::jsonb,'snapshot keeps the canonical rule');
select is((select pg_temp.save('BP-3X2','{"type":"LEVE_PAGUE","buyQuantity":3,"payQuantity":2,"maxGroupsPerLine":null}','bp-create')->>'id'),(select result->>'id' from buy_pay),'idempotent replay returns the same promotion');
select is((select count(*)::integer from public.promotions where code='BP-3X2'),1,'replay does not duplicate');
select throws_ok($$select pg_temp.save('BP-3X2','{"type":"PERCENTUAL","percentageBasisPoints":1000}','bp-to-pct',(select (result->>'id')::uuid from buy_pay),1)$$,'P0001','PROMOTION_RULE_TYPE_IMMUTABLE','rule type cannot change');

-- The generic command also administers the earlier types.
create temp table quantity as select pg_temp.save('BP-QTY','{"type":"QUANTIDADE_PRECO","groupQuantity":2,"groupPriceCents":4000,"maxGroupsPerLine":null}','bp-qty',null,null,false) result;
select is((select result->'rule'->>'type' from quantity),'QUANTIDADE_PRECO','generic command creates quantity rules');
select is((select (pg_temp.save('BP-QTY','{"type":"QUANTIDADE_PRECO","groupQuantity":2,"groupPriceCents":3900,"maxGroupsPerLine":1}','bp-qty-edit',(select (result->>'id')::uuid from quantity),1,false)->>'revision')::integer),2,'generic command edits with optimistic revision');
select throws_ok($$select pg_temp.save('BP-QTY','{"type":"QUANTIDADE_PRECO","groupQuantity":2,"groupPriceCents":3800,"maxGroupsPerLine":1}','bp-qty-stale',(select (result->>'id')::uuid from quantity),1,false)$$,'P0001','PROMOTION_REVISION_CONFLICT','stale revision is rejected');

reset role;
select is((select count(*)::integer from public.promotion_versions where promotion_id=(select (result->>'id')::uuid from quantity)),2,'each revision keeps an immutable version');
select is((select count(*)::integer from public.audit_logs where entity_type='promotion' and entity_id=(select result->>'id' from buy_pay)),1,'creation is audited');
select is((select count(*)::integer from public.outbox_events where aggregate_type='promotion' and topic <> 'promotions.live' and aggregate_id=(select result->>'id' from buy_pay)),1,'creation emits outbox event');

-- R$ 25,90: 7 units with "leve 3, pague 2" = 2 groups (2 free) + 1 = 5 x 2590 = 12950.
create temp table seven as select private.price_sale_items('PORTAL','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":7}]'::jsonb) quote;
select is((select (quote->>'total_cents')::bigint from seven),12950::bigint,'only paid units are charged');
select is((select (quote->>'discount_total_cents')::bigint from seven),5180::bigint,'free units are the saving');
select is((select quote->'lines'->0->'promotion_snapshot'->>'free_quantity' from seven),'2','snapshot explains free units');
select is((select quote->>'rounding' from seven),'NONE','buy-pay needs no rounding');
select is((select private.price_sale_items('PORTAL','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]'::jsonb)->'lines'->0->>'promotion_id'),null,'no complete group means no promotion');

-- PROMO-004: at equal priority the lower customer total wins, whatever the rule type.
update public.promotions set active=true,publicable=true where id=(select (result->>'id')::uuid from quantity);
-- 3 units: leve/pague = 5180; quantity "2 por 39,00" (max 1 group) = 3900 + 2590 = 6490.
select is((select private.price_sale_items('PORTAL','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":3}]'::jsonb)->'lines'->0->'promotion_snapshot'->>'type'),'LEVE_PAGUE','lowest total wins across rule types');
update public.promotions set priority=400 where id=(select (result->>'id')::uuid from quantity);
select is((select private.price_sale_items('PORTAL','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":3}]'::jsonb)->'lines'->0->'promotion_snapshot'->>'type'),'QUANTIDADE_PRECO','higher priority wins before best price');

select * from finish();
rollback;
