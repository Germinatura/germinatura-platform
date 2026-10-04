-- ESCALONADA and the shared rule document/pricing function. Mirrors the domain tests.
begin;
select plan(24);

select has_table('public','promotion_tiered_rules','tiered rules table exists');
select has_table('public','promotion_tiered_rule_tiers','tiers table exists');
select has_function('public','get_pricing_inputs',array['promotion_channel','uuid[]','text'],'single pricing inputs exist');
select ok(not has_table_privilege('authenticated','public.promotion_tiered_rule_tiers','INSERT'),'tiers deny direct insert');
select ok(not has_function_privilege('authenticated','private.apply_promotion_rule(bigint,bigint,jsonb)','EXECUTE'),'pricing helper is private');

create function pg_temp.save(p_code text,p_rule jsonb,p_key text,p_id uuid default null,p_revision integer default null)
returns jsonb language sql as $$
  select public.save_promotion(p_id,p_revision,p_code,p_code,null,true,true,300,false,now()-interval '1 hour',null,null,null,
    array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PORTAL']::public.promotion_channel[],p_rule,'Teste escalonada',p_key,gen_random_uuid());
$$;
create function pg_temp.quote(p_quantity integer) returns jsonb language sql as $$
  select private.price_sale_items('PORTAL',jsonb_build_array(jsonb_build_object(
    'product_id','33f00000-0000-4000-8000-000000000001','quantity',p_quantity)));
$$;

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.save('TIER-EMPTY','{"type":"ESCALONADA","tiers":[]}','tier-empty')$$,'22023','INVALID_PROMOTION','at least one tier is required');
select throws_ok($$select pg_temp.save('TIER-DOWN','{"type":"ESCALONADA","tiers":[{"minQuantity":6,"percentageBasisPoints":800},{"minQuantity":3,"percentageBasisPoints":900}]}','tier-down')$$,'22023','INVALID_PROMOTION','tiers must grow in quantity');
select throws_ok($$select pg_temp.save('TIER-FLAT','{"type":"ESCALONADA","tiers":[{"minQuantity":3,"percentageBasisPoints":800},{"minQuantity":6,"percentageBasisPoints":800}]}','tier-flat')$$,'22023','INVALID_PROMOTION','tiers must grow in discount');
select throws_ok($$select pg_temp.save('TIER-KEY','{"type":"ESCALONADA","tiers":[{"minQuantity":3,"percentageBasisPoints":800,"x":1}]}','tier-key')$$,'22023','INVALID_PROMOTION','unknown tier key is rejected');
select throws_ok($$select pg_temp.save('TIER-ONE','{"type":"ESCALONADA","tiers":[{"minQuantity":1,"percentageBasisPoints":800}]}','tier-one')$$,'22023','INVALID_PROMOTION','tier starts at two units');
select throws_ok($$select pg_temp.save('TIER-MANY',jsonb_build_object('type','ESCALONADA','tiers',(select jsonb_agg(jsonb_build_object('minQuantity',n+1,'percentageBasisPoints',n*10)) from generate_series(1,11) n)),'tier-many')$$,'22023','INVALID_PROMOTION','at most ten tiers');

create temp table tiered as select pg_temp.save('TIER-5-8','{"type":"ESCALONADA","tiers":[{"minQuantity":3,"percentageBasisPoints":500},{"minQuantity":6,"percentageBasisPoints":800}]}','tier-create') result;
select is((select result->'rule' from tiered),'{"type":"ESCALONADA","tiers":[{"minQuantity":3,"percentageBasisPoints":500},{"minQuantity":6,"percentageBasisPoints":800}]}'::jsonb,'snapshot keeps ordered tiers');
reset role;

-- R$ 25,90: 3+ = 5% -> R$ 24,605 -> R$ 24,60; 6+ = 8% -> R$ 23,828 -> R$ 23,82.
select is((pg_temp.quote(2)->'lines'->0->>'promotion_id'),null,'below the first tier nothing applies');
select is((pg_temp.quote(3)->>'total_cents')::bigint,7380::bigint,'first tier floors the unit price');
select is((pg_temp.quote(3)->>'rounding'),'FLOOR_PER_UNIT','quote declares floor rounding');
select is((pg_temp.quote(6)->>'total_cents')::bigint,14292::bigint,'highest reached tier applies to every unit');
select is((pg_temp.quote(6)->'lines'->0->'promotion_snapshot'->>'min_quantity'),'6','snapshot explains the reached tier');
select is((pg_temp.quote(6)->'lines'->0->'promotion_snapshot'->>'discounted_unit_price_cents'),'2382','snapshot explains the unit price');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select is((pg_temp.save('TIER-5-8','{"type":"ESCALONADA","tiers":[{"minQuantity":4,"percentageBasisPoints":1000}]}','tier-edit',(select (result->>'id')::uuid from tiered),1)->'rule'),
  '{"type":"ESCALONADA","tiers":[{"minQuantity":4,"percentageBasisPoints":1000}]}'::jsonb,'edit replaces the tiers');
reset role;
select is((select count(*)::integer from public.promotion_tiered_rule_tiers where promotion_id=(select (result->>'id')::uuid from tiered)),1,'old tiers are replaced, not accumulated');
select is((select count(*)::integer from public.promotion_versions where promotion_id=(select (result->>'id')::uuid from tiered)),2,'both revisions are preserved');

-- The v4 inputs expose the same canonical document used by administration.
select is((select rule from public.get_pricing_inputs('PORTAL',array['33f00000-0000-4000-8000-000000000001']::uuid[],null)
  where promotion_id=(select (result->>'id')::uuid from tiered)),
  '{"type":"ESCALONADA","tiers":[{"minQuantity":4,"percentageBasisPoints":1000}]}'::jsonb,'pricing inputs return the canonical rule document');

-- A rule without saving is not applied, exactly as in the domain.
select is(private.apply_promotion_rule(0,3,'{"type":"PERCENTUAL","percentageBasisPoints":5000}'::jsonb),null,'zero-price line has no saving and no promotion');
select is((private.apply_promotion_rule(1500,7,'{"type":"LEVE_PAGUE","buyQuantity":3,"payQuantity":2,"maxGroupsPerLine":null}'::jsonb)->>'total')::bigint,7500::bigint,'shared helper prices buy-pay like the domain');

select * from finish();
rollback;
