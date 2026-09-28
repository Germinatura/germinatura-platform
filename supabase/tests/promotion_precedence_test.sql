-- PROMO-004: non-cumulative precedence. Mirrors the domain tests in packages/domain/src/index.test.ts.
begin;
select plan(16);

create temp table precedence_fixture(id uuid, code text, priority integer, cumulative boolean, rule_type text, amount bigint, basis_points integer);
-- Inserted with the larger UUID first to prove the winner does not depend on insertion or read order.
insert into precedence_fixture values
  ('7a000000-0000-4000-8000-000000000002','PREC-FIXED-A',300,false,'VALOR_FIXO_UNITARIO',2000,null),
  ('7a000000-0000-4000-8000-000000000003','PREC-PERCENT',300,false,'PERCENTUAL',null,2000),
  ('7a000000-0000-4000-8000-000000000004','PREC-LOW-PRIORITY',100,false,'VALOR_FIXO_UNITARIO',100,null),
  ('7a000000-0000-4000-8000-000000000005','PREC-CUMULATIVE',1000,true,'VALOR_FIXO_UNITARIO',50,null);

create function pg_temp.add_promotion(p_id uuid) returns void language plpgsql as $$
declare v record;
begin
  select * into v from precedence_fixture where id=p_id;
  insert into public.promotions(id,code,name,active,publicable,priority,cumulative,valid_from)
    values(v.id,v.code,v.code,true,true,v.priority,v.cumulative,now()-interval '1 hour');
  insert into public.promotion_products(promotion_id,product_id) values(v.id,'33f00000-0000-4000-8000-000000000001');
  insert into public.promotion_channels(promotion_id,channel) values(v.id,'PORTAL');
  if v.rule_type='PERCENTUAL' then
    insert into public.promotion_percentage_rules(promotion_id,percentage_basis_points) values(v.id,v.basis_points);
  else
    insert into public.promotion_fixed_unit_price_rules(promotion_id,fixed_unit_price_cents) values(v.id,v.amount);
  end if;
end;
$$;

select pg_temp.add_promotion(id) from precedence_fixture order by id desc;

create function pg_temp.quote(p_quantity integer) returns jsonb language sql as $$
  select private.price_sale_items('PORTAL',jsonb_build_array(jsonb_build_object(
    'product_id','33f00000-0000-4000-8000-000000000001','quantity',p_quantity)));
$$;

-- R$ 25,90 x 2 = 5180. Fixed A (4000) beats the 20% rule (2072 x 2 = 4144) at equal priority;
-- the cheaper low-priority rule and the cumulative rule do not win.
select is((pg_temp.quote(2)->'lines'->0->>'promotion_id'),'7a000000-0000-4000-8000-000000000002','higher priority, then lowest customer total wins');
select is((pg_temp.quote(2)->>'total_cents')::bigint,4000::bigint,'total reflects only the winning rule');
select is((pg_temp.quote(2)->>'discount_total_cents')::bigint,1180::bigint,'discount is not composed with other promotions');
select is((pg_temp.quote(2)->'lines'->0->'promotion_snapshot'->>'savings_cents')::bigint,1180::bigint,'quote explains the applied rule and its saving');
select isnt((pg_temp.quote(2)->'lines'->0->>'promotion_id'),'7a000000-0000-4000-8000-000000000005','cumulative promotion is not composed into product pricing');
select is(pg_temp.quote(2),pg_temp.quote(2),'repeated quotes are identical');

-- An exact tie on priority and total is broken by the smallest promotion_id, not by insertion order.
insert into precedence_fixture values('7a000000-0000-4000-8000-000000000001','PREC-FIXED-B',300,false,'VALOR_FIXO_UNITARIO',2000,null);
select pg_temp.add_promotion('7a000000-0000-4000-8000-000000000001');
select is((pg_temp.quote(2)->'lines'->0->>'promotion_id'),'7a000000-0000-4000-8000-000000000001','exact tie resolves to the stable smallest promotion_id');

-- A quantity rule that yields a lower total wins at equal priority, but is skipped when it does not apply.
insert into public.promotions(id,code,name,active,publicable,priority,cumulative,valid_from)
  values('7a000000-0000-4000-8000-000000000006','PREC-QUANTITY','PREC-QUANTITY',true,true,300,false,now()-interval '1 hour');
insert into public.promotion_products(promotion_id,product_id) values('7a000000-0000-4000-8000-000000000006','33f00000-0000-4000-8000-000000000001');
insert into public.promotion_channels(promotion_id,channel) values('7a000000-0000-4000-8000-000000000006','PORTAL');
insert into public.promotion_quantity_price_rules(promotion_id,group_quantity,group_price_cents) values('7a000000-0000-4000-8000-000000000006',2,3000);
select is((pg_temp.quote(2)->'lines'->0->>'promotion_id'),'7a000000-0000-4000-8000-000000000006','lower-total quantity rule wins at equal priority');
select is((pg_temp.quote(2)->>'total_cents')::bigint,3000::bigint,'only the quantity rule is applied');
select is((pg_temp.quote(1)->'lines'->0->>'promotion_id'),'7a000000-0000-4000-8000-000000000001','non-applying quantity rule does not block the next candidate');
select is((pg_temp.quote(1)->>'total_cents')::bigint,2000::bigint,'single unit uses the fixed price');

-- Invariants: one line, no negative total, no price increase, discount equals the difference.
select is(jsonb_array_length(pg_temp.quote(3)->'lines'),1,'one priced line per product');
select ok((pg_temp.quote(3)->>'total_cents')::bigint between 0 and (pg_temp.quote(3)->>'original_total_cents')::bigint,'total is never negative nor above the original');
select is((pg_temp.quote(3)->>'discount_total_cents')::bigint,
  (pg_temp.quote(3)->>'original_total_cents')::bigint-(pg_temp.quote(3)->>'total_cents')::bigint,'discount equals original minus total');

-- The same candidates through the quote input RPC: cumulative and limited promotions are not candidates.
select is((select count(*)::integer from public.get_pricing_inputs('PORTAL',array['33f00000-0000-4000-8000-000000000001']::uuid[],null)
  where promotion_id='7a000000-0000-4000-8000-000000000005'),0,'cumulative promotion is not offered as a product candidate');
update public.promotions set global_redemption_limit=10 where id='7a000000-0000-4000-8000-000000000001';
select is((select count(*)::integer from public.get_pricing_inputs('PORTAL',array['33f00000-0000-4000-8000-000000000001']::uuid[],null)
  where promotion_id='7a000000-0000-4000-8000-000000000001'),1,'a limited promotion with capacity is offered (PROMO-007)');

select * from finish();
rollback;
