begin;
select plan(33);

select has_table('public','promotion_percentage_rules','percentage rules table exists');
select has_table('public','promotion_fixed_unit_price_rules','fixed unit price rules table exists');
select col_type_is('public','promotion_percentage_rules','percentage_basis_points','integer','percentage is stored in basis points');
select col_type_is('public','promotion_fixed_unit_price_rules','fixed_unit_price_cents','bigint','fixed price is stored in cents');
select has_function('public','save_unit_promotion',array['uuid','integer','text','text','text','boolean','boolean','integer','boolean','timestamp with time zone','timestamp with time zone','bigint','integer','uuid[]','promotion_channel[]','promotion_rule_type','integer','bigint','text','text','uuid'],'unit promotion command exists');
select ok(not has_function_privilege('anon','public.save_unit_promotion(uuid,integer,text,text,text,boolean,boolean,integer,boolean,timestamp with time zone,timestamp with time zone,bigint,integer,uuid[],promotion_channel[],promotion_rule_type,integer,bigint,text,text,uuid)','EXECUTE'),'anonymous cannot execute unit command');
select ok(not has_table_privilege('authenticated','public.promotion_percentage_rules','INSERT'),'percentage rules deny direct insert');
select ok(not has_table_privilege('authenticated','public.promotion_fixed_unit_price_rules','UPDATE'),'fixed rules deny direct update');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.save_unit_promotion(null,null,'PCT-CONSUMER','Negada',null,true,true,1,false,now(),null,null,null,array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PORTAL']::public.promotion_channel[],'PERCENTUAL',1500,null,'Tentativa indevida','pct-consumer',gen_random_uuid())$$,'42501','PROMOTION_MANAGE_FORBIDDEN','consumer cannot manage unit promotions');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.save_unit_promotion(null,null,'PCT-BAD','Inválida',null,true,true,1,false,now(),null,null,null,array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PORTAL']::public.promotion_channel[],'PERCENTUAL',10000,null,'Percentual inválido','pct-bad',gen_random_uuid())$$,'22023','INVALID_PROMOTION','percentage of 100% is rejected');
select throws_ok($$select public.save_unit_promotion(null,null,'PCT-MIXED','Inválida',null,true,true,1,false,now(),null,null,null,array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PORTAL']::public.promotion_channel[],'PERCENTUAL',1500,100,'Campos misturados','pct-mixed',gen_random_uuid())$$,'22023','INVALID_PROMOTION','percentage cannot carry a fixed price');
select throws_ok($$select public.save_unit_promotion(null,null,'QTY-VIA-UNIT','Inválida',null,true,true,1,false,now(),null,null,null,array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PORTAL']::public.promotion_channel[],'QUANTIDADE_PRECO',null,null,'Tipo errado','pct-qty',gen_random_uuid())$$,'22023','INVALID_PROMOTION','unit command rejects quantity rules');

create temp table percentage_promotion as select public.save_unit_promotion(
  null,null,'PCT-15','Quinze por cento',null,true,true,900,false,now()-interval '1 hour',null,null,null,
  array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PORTAL','PDV']::public.promotion_channel[],
  'PERCENTUAL',1500,null,'Criar percentual','pct-create',gen_random_uuid()) result;
select is((select result->'rule'->>'type' from percentage_promotion),'PERCENTUAL','command returns percentage rule');
select is((select (result->'rule'->>'percentageBasisPoints')::integer from percentage_promotion),1500,'snapshot keeps basis points');
select is((public.save_unit_promotion(
  null,null,'PCT-15','Quinze por cento',null,true,true,900,false,now()-interval '1 hour',null,null,null,
  array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PORTAL','PDV']::public.promotion_channel[],
  'PERCENTUAL',1500,null,'Criar percentual','pct-create',gen_random_uuid())->>'id'),(select result->>'id' from percentage_promotion),'idempotent replay returns the same promotion');
select is((select count(*)::integer from public.promotions where code='PCT-15'),1,'replay does not duplicate');

reset role;
select is((select count(*)::integer from public.audit_logs where entity_type='promotion' and entity_id=(select result->>'id' from percentage_promotion)),1,'creation is audited');
select is((select count(*)::integer from public.outbox_events where aggregate_type='promotion' and topic <> 'promotions.live' and aggregate_id=(select result->>'id' from percentage_promotion)),1,'creation emits outbox event');

-- R$ 25,90 with 15% = R$ 22,015 per unit: floored to R$ 22,01 in favor of the customer.
create temp table percentage_quote as select private.price_sale_items('PORTAL','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]'::jsonb) quote;
select is((select quote->>'rounding' from percentage_quote),'FLOOR_PER_UNIT','percentage quote declares floor rounding');
select is((select (quote->'lines'->0->>'total_cents')::bigint from percentage_quote),4402::bigint,'line total uses the floored unit price');
select is((select (quote->'lines'->0->>'discount_cents')::bigint from percentage_quote),778::bigint,'discount is the exact difference in cents');
select is((select (quote->'lines'->0->'promotion_snapshot'->>'discounted_unit_price_cents')::bigint from percentage_quote),2201::bigint,'snapshot explains the discounted unit price');
select is((select quote->'lines'->0->>'promotion_id' from percentage_quote),(select result->>'id' from percentage_promotion),'line references the applied promotion');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table fixed_promotion as select public.save_unit_promotion(
  (select (result->>'id')::uuid from percentage_promotion),1,'PCT-15','Unidade por dezenove e noventa',null,true,true,900,false,
  now()-interval '1 hour',null,null,null,array['33f00000-0000-4000-8000-000000000001']::uuid[],
  array['PORTAL']::public.promotion_channel[],'VALOR_FIXO_UNITARIO',null,1990,'Trocar para preço fixo','pct-to-fixed',gen_random_uuid()) result;
select is((select (result->>'revision')::integer from fixed_promotion),2,'update increments revision');
select is((select count(*)::integer from public.promotion_percentage_rules where promotion_id=(select (result->>'id')::uuid from fixed_promotion)),0,'previous percentage rule is replaced');
select is((select count(*)::integer from public.promotion_versions where promotion_id=(select (result->>'id')::uuid from fixed_promotion)),2,'both revisions are preserved');
select throws_ok($$select public.save_unit_promotion((select (result->>'id')::uuid from percentage_promotion),1,'PCT-15','Antiga',null,true,true,900,false,now(),null,null,null,array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PORTAL']::public.promotion_channel[],'PERCENTUAL',1000,null,'Revisão antiga','pct-stale',gen_random_uuid())$$,'P0001','PROMOTION_REVISION_CONFLICT','stale revision is rejected');

reset role;
create temp table fixed_quote as select private.price_sale_items('PORTAL','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":3}]'::jsonb) quote;
select is((select quote->>'rounding' from fixed_quote),'NONE','fixed unit price needs no rounding');
select is((select (quote->>'total_cents')::bigint from fixed_quote),5970::bigint,'fixed unit price replaces the base unit price');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table quantity_promotion as select public.save_quantity_price_promotion(
  null,null,'QTY-KEEP','Duas por dez',null,false,false,1,false,now(),null,null,null,
  array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PDV']::public.promotion_channel[],2,1000,null,
  'Criar quantidade','qty-keep',gen_random_uuid()) result;
select throws_ok($$select public.save_unit_promotion((select (result->>'id')::uuid from quantity_promotion),1,'QTY-KEEP','Trocar',null,false,false,1,false,now(),null,null,null,array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PDV']::public.promotion_channel[],'PERCENTUAL',1000,null,'Trocar tipo','qty-to-pct',gen_random_uuid())$$,'P0001','PROMOTION_RULE_TYPE_IMMUTABLE','quantity promotion cannot become a unit rule');
select throws_ok($$select public.save_quantity_price_promotion((select (result->>'id')::uuid from fixed_promotion),2,'PCT-15','Trocar',null,false,false,1,false,now(),null,null,null,array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PDV']::public.promotion_channel[],2,1000,null,'Trocar tipo','fixed-to-qty',gen_random_uuid())$$,'P0001','PROMOTION_RULE_TYPE_CONFLICT','unit promotion cannot gain a quantity rule');

select public.save_unit_promotion(null,null,'FIXED-NO-SAVING','Sem economia',null,true,true,1,false,now()-interval '1 hour',null,null,null,array['33f00000-0000-4000-8000-000000000001']::uuid[],array['PORTAL']::public.promotion_channel[],'VALOR_FIXO_UNITARIO',null,2590,'Preço igual ao base','fixed-no-saving',gen_random_uuid());
reset role;
select throws_ok($$select private.price_sale_items('PORTAL','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb)$$,'P0001','INVALID_PROMOTION_FIXED_PRICE','fixed price not below the base price fails closed');

set local role anon;
select is((select count(*)::integer from public.promotion_percentage_rules),0,'anonymous sees no inactive or replaced percentage rule');

select * from finish();
rollback;
