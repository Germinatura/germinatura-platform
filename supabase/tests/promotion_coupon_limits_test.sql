-- PROMO-006 coupons and PROMO-007 redemption ledger. Coupon prices mirror the domain tests.
begin;
select plan(46);

insert into public.products(id,category_id,sku,slug,name,active,published,sellable_pdv,reservable)
values('35d00000-0000-4000-8000-000000000002','23f00000-0000-4000-8000-000000000001','COUPON-ITEM-B','coupon-item-b','Item cupom B',true,true,true,true);
insert into public.product_prices(product_id,amount_cents,valid_from)
values('35d00000-0000-4000-8000-000000000002',1990,'2026-01-01T00:00:00Z');
insert into public.inventory_balances(location_id,product_id) values
  ('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001')
on conflict (location_id,product_id) do nothing;

select has_table('public','promotion_coupon_rules','coupon rules table exists');
select has_table('public','promotion_redemptions','redemption ledger exists');
select has_function('public','get_pricing_inputs',array['promotion_channel','uuid[]','text'],'single pricing entry point exists');
select ok(not has_table_privilege('authenticated','public.promotion_redemptions','INSERT'),'ledger denies direct insert');

create function pg_temp.save(p_code text,p_rule jsonb,p_key text,p_products uuid[],p_priority integer default 300,
  p_cumulative boolean default false,p_global bigint default null,p_user integer default null)
returns jsonb language sql as $$
  select public.save_promotion(null,null,p_code,p_code,null,true,true,p_priority,p_cumulative,now()-interval '1 hour',null,p_global,p_user,
    p_products,array['PORTAL','PDV']::public.promotion_channel[],p_rule,'Teste cupom',p_key,gen_random_uuid());
$$;
create function pg_temp.price(p_items jsonb,p_code text) returns jsonb language sql as $$
  select private.price_cart('PORTAL',p_items,null,p_code,false);
$$;

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001',20,'Estoque cupom','coupon-stock-a','66000000-0000-4000-8000-000000000001')$$,'admin prepares central stock');
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',20,'Estoque cupom vendedor','coupon-stock-seller','66000000-0000-4000-8000-000000000002')$$,'admin prepares seller stock');
select throws_ok($$select pg_temp.save('BAD-CUMULATIVE','{"type":"PERCENTUAL","percentageBasisPoints":1000}','bad-cumulative',array['33f00000-0000-4000-8000-000000000001']::uuid[],300,true)$$,
  '22023','INVALID_PROMOTION','only a coupon may be cumulative');
select throws_ok($$select pg_temp.save('BAD-CODE','{"type":"CUPOM","code":"formando10","discount":{"kind":"PERCENTUAL","percentageBasisPoints":1000}}','bad-code',array['33f00000-0000-4000-8000-000000000001']::uuid[])$$,
  '22023','INVALID_PROMOTION','coupon code must be canonical');
select lives_ok($$select pg_temp.save('CUPOM-FORMANDO10','{"type":"CUPOM","code":"FORMANDO10","discount":{"kind":"PERCENTUAL","percentageBasisPoints":1000}}','coupon-10',array['33f00000-0000-4000-8000-000000000001']::uuid[])$$,
  'manager creates a non-cumulative percentage coupon');
select throws_ok($$select pg_temp.save('CUPOM-DUP','{"type":"CUPOM","code":"FORMANDO10","discount":{"kind":"VALOR_FIXO","amountCents":100}}','coupon-dup',array['33f00000-0000-4000-8000-000000000001']::uuid[])$$,
  '23505','PROMOTION_COUPON_CODE_CONFLICT','coupon codes are unique');
reset role;

select ok(not has_table_privilege('anon','public.promotion_coupon_rules','SELECT'),'anonymous cannot read coupon codes');
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select is((select count(*)::integer from public.promotion_coupon_rules),0,'consumer cannot enumerate coupon codes');
select is((select count(*)::integer from public.promotion_redemptions),0,'consumer cannot read the ledger');
reset role;

-- A R$ 25,90 x 2 = 5180. The coupon only exists for its code; codes are case-insensitive.
select is((pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]',null)->>'total_cents')::bigint,5180::bigint,'no code, no coupon');
select is((pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]',' formando10 ')->>'total_cents')::bigint,4662::bigint,'10% coupon floors per unit');
select is((pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]','formando10')->>'rounding'),'FLOOR_PER_UNIT','quote declares the rounding');
select is((pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]','formando10')->'coupon'),'{"code":"FORMANDO10","applied":true}'::jsonb,'quote reports the applied coupon');
select is((pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]','NAOEXISTE')->'coupon'->>'applied'),'false','unknown code is reported as not applied');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select pg_temp.save('LINE-20','{"type":"PERCENTUAL","percentageBasisPoints":2000}','line-20',array['33f00000-0000-4000-8000-000000000001']::uuid[]);
select pg_temp.save('CUPOM-CUMUL10','{"type":"CUPOM","code":"CUMUL10","discount":{"kind":"PERCENTUAL","percentageBasisPoints":1000}}','coupon-cumul',array['33f00000-0000-4000-8000-000000000001']::uuid[],300,true);
select pg_temp.save('CUPOM-DEZ','{"type":"CUPOM","code":"DEZREAIS","discount":{"kind":"VALOR_FIXO","amountCents":1000}}','coupon-fixed',
  array['33f00000-0000-4000-8000-000000000001','35d00000-0000-4000-8000-000000000002']::uuid[]);
reset role;

select is((pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]','FORMANDO10')->'lines'->0->'promotion_snapshot'->>'type'),'PERCENTUAL','a non-cumulative coupon loses to a better line rule at equal priority');
-- 20% line rule: 2072 x 3 = 6216; cumulative 10% floors the line -> 5594.
select is((pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":3}]','CUMUL10')->>'total_cents')::bigint,5594::bigint,'cumulative coupon stacks on the winning promotion');
select is((pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":3}]','CUMUL10')->'lines'->0->'coupon_snapshot'->>'savings_cents'),'622','quote explains the stacked coupon');
select is((pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":3}]','CUMUL10')->>'rounding'),'FLOOR_PER_UNIT_AND_LINE','both floors are declared');
-- R$ 10 over A + B (4580) -> 566 / 434; the coupon beats the 20% line rule (3580 < 2072 + 1990).
select is((pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1},{"product_id":"35d00000-0000-4000-8000-000000000002","quantity":1}]','DEZREAIS')->>'total_cents')::bigint,3580::bigint,'fixed coupon over eligible lines');
select is((select jsonb_agg(line->'discount_cents') from jsonb_array_elements(pg_temp.price('[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1},{"product_id":"35d00000-0000-4000-8000-000000000002","quantity":1}]','DEZREAIS')->'lines') line),
  '[566,434]'::jsonb,'fixed coupon follows the PROMO-005 split');

-- Ledger: a coupon usable once overall.
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table limited as select pg_temp.save('CUPOM-UNICO','{"type":"CUPOM","code":"UNICO","discount":{"kind":"VALOR_FIXO","amountCents":500}}','coupon-limited',
  array['33f00000-0000-4000-8000-000000000001']::uuid[],900,false,1,null) result;
reset role;

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table sale_one as select public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'coupon-sale-1','66000000-0000-4000-8000-000000000011','UNICO') result;
create temp table sale_two as select public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'coupon-sale-2','66000000-0000-4000-8000-000000000012','UNICO') result;
reset role;
select is((select result->'quote'->'coupon'->>'applied' from sale_one),'true','first sale uses the limited coupon');
select is((select status::text from public.promotion_redemptions where sale_id=(select (result->>'sale_id')::uuid from sale_one)),'RESERVED','checkout reserves the use');
select is((select result->'quote'->'coupon'->>'applied' from sale_two),'false','the exhausted coupon is not applied to the second sale');
select is((select count(*)::integer from public.promotion_redemptions where sale_id=(select (result->>'sale_id')::uuid from sale_two)
  and promotion_id=(select (result->>'id')::uuid from limited)),0,'no use is recorded without the coupon');
select throws_ok($$insert into public.promotion_redemptions(promotion_id,sale_id) values((select (result->>'id')::uuid from limited),(select (result->>'sale_id')::uuid from sale_one))$$,
  '23505',null,'one use per promotion per sale');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select lives_ok($$select public.cancel_sale((select (result->>'sale_id')::uuid from sale_one),'coupon-cancel-1','66000000-0000-4000-8000-000000000013')$$,'seller cancels the unpaid sale');
reset role;
select is((select status::text from public.promotion_redemptions where sale_id=(select (result->>'sale_id')::uuid from sale_one)),'RELEASED','cancellation before confirmation releases the use');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table sale_three as select public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'coupon-sale-3','66000000-0000-4000-8000-000000000014','UNICO') result;
select public.confirm_manual_payment((select (result->>'sale_id')::uuid from sale_three),'MAQUININHA','NSU-COUPON-0003','coupon-confirm-3','66000000-0000-4000-8000-000000000015');
reset role;
select is((select result->'quote'->'coupon'->>'applied' from sale_three),'true','released capacity can be used again');
select is((select status::text from public.promotion_redemptions where sale_id=(select (result->>'sale_id')::uuid from sale_three)),'CONSUMED','confirmation consumes the use');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.reverse_confirmed_sale((select (result->>'sale_id')::uuid from sale_three),'Cliente solicitou estorno integral','ESTORNO-COUPON-0003','coupon-reverse-3','66000000-0000-4000-8000-000000000016')$$,'finance reverses the confirmed sale');
reset role;
select is((select status::text from public.promotion_redemptions where sale_id=(select (result->>'sale_id')::uuid from sale_three)),'CONSUMED','a consumed use is not released automatically by a reversal');
select throws_ok($$update public.promotion_redemptions set status='RELEASED',released_at=now() where sale_id=(select (result->>'sale_id')::uuid from sale_three)$$,
  'P0001','PROMOTION_REDEMPTION_TRANSITION_INVALID','a consumed use cannot be released');
select throws_ok($$delete from public.promotion_redemptions where sale_id=(select (result->>'sale_id')::uuid from sale_three)$$,'P0001','IMMUTABLE_RECORD','the ledger is not deleted');
select ok(not private.promotion_has_capacity((select (result->>'id')::uuid from limited),null),'the consumed use keeps the global limit exhausted');

-- Per-user limit: never for an anonymous PDV sale; once for an identified Portal buyer.
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table per_user as select pg_temp.save('CUPOM-POR-CLIENTE','{"type":"CUPOM","code":"PORCLIENTE","discount":{"kind":"VALOR_FIXO","amountCents":300}}','coupon-user',
  array['33f00000-0000-4000-8000-000000000001']::uuid[],900,false,null,1) result;
reset role;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table pdv_user as select public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'coupon-pdv-user','66000000-0000-4000-8000-000000000021','PORCLIENTE') result;
reset role;
select is((select result->'quote'->'coupon'->>'applied' from pdv_user),'false','an anonymous PDV sale never gets a per-user limited promotion');
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
create temp table portal_one as select public.checkout_sale('PORTAL','50000000-0000-4000-8000-000000000001','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'coupon-portal-1','66000000-0000-4000-8000-000000000022','PORCLIENTE') result;
create temp table portal_two as select public.checkout_sale('PORTAL','50000000-0000-4000-8000-000000000001','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'coupon-portal-2','66000000-0000-4000-8000-000000000023','PORCLIENTE') result;
reset role;
select is((select result->'quote'->'coupon'->>'applied' from portal_one),'true','the identified buyer uses the coupon once');
select is((select customer_id from public.promotion_redemptions where sale_id=(select (result->>'sale_id')::uuid from portal_one)),'10000000-0000-4000-8000-000000000003'::uuid,'the use belongs to the buyer');
select is((select result->'quote'->'coupon'->>'applied' from portal_two),'false','the same buyer cannot use it twice');

-- Commercial reservations reserve, release and hand the use to the converted sale.
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table reservation_coupon as select pg_temp.save('CUPOM-RESERVA','{"type":"CUPOM","code":"RESERVA5","discount":{"kind":"VALOR_FIXO","amountCents":500}}','coupon-reservation',
  array['33f00000-0000-4000-8000-000000000001']::uuid[],900,false,null,1) result;
reset role;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
create temp table reservation_one as select public.create_commercial_reservation('50000000-0000-4000-8000-000000000001','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'coupon-reservation-1','66000000-0000-4000-8000-000000000031','RESERVA5') result;
select public.cancel_commercial_reservation((select (result->>'reservation_id')::uuid from reservation_one),'coupon-reservation-cancel-1','66000000-0000-4000-8000-000000000032');
create temp table reservation_two as select public.create_commercial_reservation('50000000-0000-4000-8000-000000000001','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'coupon-reservation-2','66000000-0000-4000-8000-000000000033','RESERVA5') result;
create temp table converted as select public.convert_commercial_reservation((select (result->>'reservation_id')::uuid from reservation_two),'coupon-reservation-convert-2','66000000-0000-4000-8000-000000000034') result;
reset role;
select is((select status::text from public.promotion_redemptions where reservation_id=(select (result->>'reservation_id')::uuid from reservation_one)),'RELEASED','a cancelled reservation releases its use');
select is((select result->'quote'->'coupon'->>'applied' from reservation_two),'true','released capacity is available to the next reservation');
select is((select sale_id from public.promotion_redemptions where reservation_id=(select (result->>'reservation_id')::uuid from reservation_two)),(select (result->>'sale_id')::uuid from converted),'conversion hands the use to the sale');
select is((select coupon_promotion_id is null and promotion_id=(select (result->>'id')::uuid from reservation_coupon) from public.sale_items where sale_id=(select (result->>'sale_id')::uuid from converted)),true,'the converted sale keeps the coupon line');

select * from finish();
rollback;
