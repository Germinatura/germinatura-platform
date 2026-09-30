-- Spec 6.15 and 15.5 (RAF-004): raffle numbers sold at the PDV through the same sale and payment infrastructure.
begin;
select plan(20);

select ok(not has_table_privilege('authenticated', 'public.raffle_sale_buyers', 'SELECT'), 'buyer contacts are not readable directly');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table pdv_campaign as select public.create_raffle_campaign('Rifa do PDV', '33f00000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', 20, now() - interval '1 minute', now() + interval '1 day', 'pdv-raffle-create', gen_random_uuid()) result;
grant select on pdv_campaign to authenticated;
select public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from pdv_campaign), 'PUBLISH', 'pdv-raffle-publish', gen_random_uuid());

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select is((select count(*)::integer from jsonb_array_elements(public.list_raffles_for_seller()) item where item ->> 'campaign_id' = (select result ->> 'campaign_id' from pdv_campaign)), 1, 'the seller lists the open raffle');
select is(public.find_raffle_buyer('consumidor.teste') ->> 'profile_id', '10000000-0000-4000-8000-000000000003', 'a registered buyer is found by username');
select is(public.find_raffle_buyer('ninguem@exemplo.com'), null, 'an unknown identifier finds nobody');
select throws_ok($$select public.reserve_raffle_numbers_pdv((select (result ->> 'campaign_id')::uuid from pdv_campaign), '50000000-0000-4000-8000-000000000002', array[1], null, null, null, 'pdv-raffle-nobody', gen_random_uuid())$$,
  '22023', 'RAFFLE_BUYER_REQUIRED', 'the buyer must be identified');
select throws_ok($$select public.reserve_raffle_numbers_pdv((select (result ->> 'campaign_id')::uuid from pdv_campaign), '50000000-0000-4000-8000-000000000002', array[1], null, 'Maria', 'não informado', 'pdv-raffle-bad-contact', gen_random_uuid())$$,
  '22023', 'INVALID_RAFFLE_BUYER', 'the contact must be an email or a phone');
create temp table walk_in as select public.reserve_raffle_numbers_pdv((select (result ->> 'campaign_id')::uuid from pdv_campaign), '50000000-0000-4000-8000-000000000002',
  array[2,1], null, 'Maria Souza', '(11) 98888-7777', 'pdv-raffle-walk-in', gen_random_uuid()) result;
create temp table registered as select public.reserve_raffle_numbers_pdv((select (result ->> 'campaign_id')::uuid from pdv_campaign), '50000000-0000-4000-8000-000000000002',
  array[3], '10000000-0000-4000-8000-000000000003', null, null, 'pdv-raffle-registered', gen_random_uuid()) result;
create temp table dropped as select public.reserve_raffle_numbers_pdv((select (result ->> 'campaign_id')::uuid from pdv_campaign), '50000000-0000-4000-8000-000000000002',
  array[4], null, 'João Lima', 'joao@exemplo.com', 'pdv-raffle-dropped', gen_random_uuid()) result;
grant select on walk_in, registered, dropped to authenticated;
select is((select result -> 'numbers' from walk_in), '[1, 2]'::jsonb, 'the seller reserves the chosen numbers');
select is(public.reserve_raffle_numbers_pdv((select (result ->> 'campaign_id')::uuid from pdv_campaign), '50000000-0000-4000-8000-000000000002',
  array[2,1], null, 'Maria Souza', '(11) 98888-7777', 'pdv-raffle-walk-in', gen_random_uuid()), (select result from walk_in), 'a double tap reserves once');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.reserve_raffle_numbers((select (result ->> 'campaign_id')::uuid from pdv_campaign), array[2], 'pdv-raffle-online-clash', gen_random_uuid())$$,
  'P0001', 'RAFFLE_NUMBER_CONFLICT', 'a number held at the PDV cannot be reserved online');
select throws_ok($$select public.reserve_raffle_numbers_pdv((select (result ->> 'campaign_id')::uuid from pdv_campaign), '50000000-0000-4000-8000-000000000002', array[5], null, 'Ana', 'ana@exemplo.com', 'pdv-raffle-consumer', gen_random_uuid())$$,
  '42501', 'RAFFLE_SELL_FORBIDDEN', 'consumers cannot sell at the PDV');
select throws_ok($$select public.cancel_raffle_reservation((select (result ->> 'sale_id')::uuid from dropped), 'pdv-raffle-cancel-foreign', gen_random_uuid())$$,
  'P0001', 'RAFFLE_RESERVATION_NOT_FOUND', 'nobody else cancels a sale without a customer');
select is((select count(*)::integer from jsonb_array_elements(public.list_my_raffle_tickets()) item where item ->> 'sale_id' = (select result ->> 'sale_id' from registered)), 1, 'the registered buyer sees the PDV tickets');

-- The seller takes Área Pix for the walk-in buyer and cash for the registered one.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table pix as select public.confirm_manual_payment((select (result ->> 'sale_id')::uuid from walk_in), 'PIX_AREA', 'PIX-RIFA-0001', null, null, 'pdv-raffle-pix', gen_random_uuid()) result;
select is((select result -> 'stock' ->> 'status' from pix), 'RAFFLE_TICKETS', 'raffle tickets move no stock');
select lives_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000002', 5000, 'pdv-raffle-shift', gen_random_uuid())$$, 'the seller opens the drawer');
create temp table cash as select public.confirm_cash_payment((select (result ->> 'sale_id')::uuid from registered), 5000, 'pdv-raffle-cash', gen_random_uuid()) result;
select is((select result ->> 'sale_status' from cash), 'CONFIRMED', 'cash confirms the raffle sale');
select is(public.cancel_raffle_reservation((select (result ->> 'sale_id')::uuid from dropped), 'pdv-raffle-cancel', gen_random_uuid()) ->> 'status', 'CANCELLED', 'the seller releases an unpaid sale');
reset role;

select is((select string_agg(number || ':' || status, ',' order by number) from public.raffle_numbers where campaign_id = (select (result ->> 'campaign_id')::uuid from pdv_campaign) and number <= 4),
  '1:PAID,2:PAID,3:PAID,4:AVAILABLE', 'paid numbers are held and the released one is free');
select is((select count(*)::integer from public.financial_ledger_entries where sale_id in ((select (result ->> 'sale_id')::uuid from walk_in), (select (result ->> 'sale_id')::uuid from registered))
  and entry_type in ('RECEIVABLE_PICPAY', 'CASH_RECEIPT')), 2, 'each raffle sale enters finance once');
select is((select buyer_contact from public.raffle_sale_buyers where sale_id = (select (result ->> 'sale_id')::uuid from walk_in)), '11988887777', 'the phone is stored normalized');
select ok(not exists (select 1 from public.audit_logs where metadata::text like '%98888%'), 'the audit trail never stores the contact');

select * from finish();
rollback;
