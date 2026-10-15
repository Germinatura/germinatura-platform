-- Spec 6.7: card-present payments record the card method and the internal Maquininha, never card data.
begin;
select plan(26);

select has_table('private','payment_terminals','terminal registry exists');
select ok(not has_function_privilege('anon','public.save_payment_terminal(uuid,text,text,boolean,text,uuid)','EXECUTE'),'anonymous cannot register terminals');
select ok(not has_table_privilege('authenticated','public.payment_terminals','INSERT'),'terminals deny direct writes');

insert into public.inventory_balances(location_id,product_id)
values('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001')
on conflict (location_id,product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',6,'Estoque maquininha','card-stock','6a000000-0000-4000-8000-000000000001')$$,'admin prepares seller stock');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
create temp table card_sales(label text primary key, sale_id uuid);
insert into card_sales select label, (public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'card-sale-'||label,gen_random_uuid())->>'sale_id')::uuid
from unnest(array['a','b','c','d']) label;
select throws_ok($$select public.confirm_manual_payment((select sale_id from card_sales where label='a'),'MAQUININHA','NSU-CARD-0001',null,null,'card-no-method',gen_random_uuid())$$,'22023','CARD_METHOD_REQUIRED','the Maquininha needs the card method');
select throws_ok($$select public.confirm_manual_payment((select sale_id from card_sales where label='a'),'MAQUININHA','NSU-CARD-0001','card-legacy',gen_random_uuid())$$,'22023','CARD_METHOD_REQUIRED','the legacy signature cannot skip the card method');
select throws_ok($$select public.confirm_manual_payment((select sale_id from card_sales where label='a'),'PIX_AREA','PIX-CARD-0001','DEBITO',null,'card-pix-method',gen_random_uuid())$$,'22023','CARD_DETAILS_NOT_ALLOWED','Área Pix has no card method');
select throws_ok($$select public.confirm_manual_payment((select sale_id from card_sales where label='a'),'MAQUININHA','NSU-CARD-0001','VOUCHER_REFEICAO',null,'card-voucher',gen_random_uuid())$$,'P0001','FEATURE_DISABLED','meal vouchers wait for accreditation');
select is((public.confirm_manual_payment((select sale_id from card_sales where label='a'),'MAQUININHA','NSU-CARD-0001','DEBITO',null,'card-a',gen_random_uuid())->'payment_attempt'->>'card_method'),'DEBITO','without registered terminals the method alone is enough');
select throws_ok($$select public.save_payment_terminal(null,'MAQ-01','Maquininha do caixa','true','card-terminal-seller',gen_random_uuid())$$,'42501','FINANCE_MANAGE_REQUIRED','a seller cannot register terminals');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table terminal as select public.save_payment_terminal(null,'maq-01','Maquininha do caixa',true,'card-terminal-1','6a000000-0000-4000-8000-000000000002') result;
select is((select result->>'code' from terminal),'MAQ-01','terminal code is normalized');
select is(public.save_payment_terminal(null,'maq-01','Maquininha do caixa',true,'card-terminal-1','6a000000-0000-4000-8000-000000000002'),(select result from terminal),'terminal registration replay is idempotent');
select throws_ok($$select public.save_payment_terminal(null,'MAQ-01','Outra maquininha',true,'card-terminal-dup',gen_random_uuid())$$,'P0001','PAYMENT_TERMINAL_CODE_TAKEN','terminal codes are unique');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select is((public.list_payment_terminals()->0->>'code'),'MAQ-01','seller lists the active terminal');
select throws_ok($$select public.list_payment_terminals(true)$$,'42501','FINANCE_MANAGE_REQUIRED','only finance lists inactive terminals');
select throws_ok($$select public.confirm_manual_payment((select sale_id from card_sales where label='b'),'MAQUININHA','NSU-CARD-0002','CREDITO',null,'card-b-no-terminal',gen_random_uuid())$$,'P0001','PAYMENT_TERMINAL_REQUIRED','registered terminals make the terminal mandatory');
create temp table card_b as select public.confirm_manual_payment((select sale_id from card_sales where label='b'),'MAQUININHA','NSU-CARD-0002','CREDITO',(select (result->>'id')::uuid from terminal),'card-b',gen_random_uuid()) result;
select is((select result->'payment_attempt'->'terminal'->>'code' from card_b),'MAQ-01','confirmation names the terminal');
select lives_ok($$select public.confirm_manual_payment((select sale_id from card_sales where label='d'),'PIX_AREA','PIX-CARD-0004',null,null,'card-d',gen_random_uuid())$$,'Área Pix never needs a terminal');
select is((select item->'payment'->>'terminal_code' from jsonb_array_elements(public.list_my_sales(null,null,50)->'items') item where item->>'sale_id'=(select sale_id::text from card_sales where label='b')),'MAQ-01','"Minhas vendas" shows the terminal');
select is((select item->'payment'->>'card_method' from jsonb_array_elements(public.list_my_sales(null,null,50)->'items') item where item->>'sale_id'=(select sale_id::text from card_sales where label='b')),'CREDITO','"Minhas vendas" shows the card method');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.save_payment_terminal((select (result->>'id')::uuid from terminal),'MAQ-01','Maquininha do caixa',false,'card-terminal-off',gen_random_uuid())$$,'finance deactivates the terminal');
select is(jsonb_array_length(public.list_payment_terminals(true)),1,'finance still sees the inactive terminal');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.confirm_manual_payment((select sale_id from card_sales where label='c'),'MAQUININHA','NSU-CARD-0003','CREDITO',(select (result->>'id')::uuid from terminal),'card-c',gen_random_uuid())$$,'P0001','PAYMENT_TERMINAL_UNAVAILABLE','an inactive terminal cannot take payments');
select is(public.list_payment_terminals(),'[]'::jsonb,'seller no longer lists the inactive terminal');
reset role;

select is((select card_method::text||':'||(terminal_id is not null)::text from public.payment_attempts where sale_id=(select sale_id from card_sales where label='b')),'CREDITO:true','attempt stores method and terminal');
select throws_ok($$delete from public.payment_terminals$$,'P0001','IMMUTABLE_RECORD','terminals are never deleted');

select * from finish();
rollback;
