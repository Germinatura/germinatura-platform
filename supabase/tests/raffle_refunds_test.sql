-- Spec 4.4 and 5.11 (RAF-005): paid raffle sales are refunded under the RAF-002 rule, before and after the draw.
begin;
select plan(24);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table campaigns as
select label, public.create_raffle_campaign('Rifa ' || label, '33f00000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 10,
  now() - interval '1 minute', now() + interval '1 day', 'refund-create-' || label, gen_random_uuid()) ->> 'campaign_id' campaign_id
from unnest(array['open', 'closed', 'drawn']) label;
grant select on campaigns to authenticated;
select public.transition_raffle_campaign(campaign_id::uuid, 'PUBLISH', 'refund-publish-' || label, gen_random_uuid()) from campaigns;

-- The seller sells at the PDV: walk-in and registered buyers, Área Pix and cash.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table shift as select public.open_seller_shift('50000000-0000-4000-8000-000000000002', 1000, 'refund-shift', gen_random_uuid()) ->> 'shift_id' shift_id;
create temp table sales (label text primary key, sale_id uuid, total_cents bigint);
insert into sales select 'pix', (result ->> 'sale_id')::uuid, (result ->> 'total_cents')::bigint from (select public.reserve_raffle_numbers_pdv((select campaign_id::uuid from campaigns where label = 'open'),
  '50000000-0000-4000-8000-000000000002', array[1, 2], null, 'Maria Souza', 'maria@exemplo.com', 'refund-pix', gen_random_uuid()) result) reserved;
insert into sales select 'cash', (result ->> 'sale_id')::uuid, (result ->> 'total_cents')::bigint from (select public.reserve_raffle_numbers_pdv((select campaign_id::uuid from campaigns where label = 'open'),
  '50000000-0000-4000-8000-000000000002', array[3], '10000000-0000-4000-8000-000000000003', null, null, 'refund-cash', gen_random_uuid()) result) reserved;
insert into sales select 'closed', (result ->> 'sale_id')::uuid, (result ->> 'total_cents')::bigint from (select public.reserve_raffle_numbers_pdv((select campaign_id::uuid from campaigns where label = 'closed'),
  '50000000-0000-4000-8000-000000000002', array[5], null, 'João Lima', 'joao@exemplo.com', 'refund-closed', gen_random_uuid()) result) reserved;
insert into sales select 'drawn', (result ->> 'sale_id')::uuid, (result ->> 'total_cents')::bigint from (select public.reserve_raffle_numbers_pdv((select campaign_id::uuid from campaigns where label = 'drawn'),
  '50000000-0000-4000-8000-000000000002', array[7], null, 'Ana Reis', 'ana@exemplo.com', 'refund-drawn', gen_random_uuid()) result) reserved;
grant select on shift, sales to authenticated;
select public.confirm_manual_payment(sale_id, 'PIX_AREA', 'PIX-REF-' || label, null, null, 'refund-pay-' || label, gen_random_uuid()) from sales where label <> 'cash';
select public.confirm_cash_payment((select sale_id from sales where label = 'cash'), (select total_cents from sales where label = 'cash'), 'refund-pay-cash', gen_random_uuid());
select throws_ok($$select public.reverse_confirmed_sale((select sale_id from sales where label = 'pix'), 'Comprador desistiu da rifa', 'EST-PIX-0001', null, 'refund-seller', gen_random_uuid())$$,
  '42501', 'FINANCE_MANAGE_REQUIRED', 'only finance refunds a raffle sale');

-- Before the draw, while sales are open: individual refunds, numbers return to the board.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(public.get_sale_admin((select sale_id from sales where label = 'pix')) -> 'reversal' ->> 'allowed', 'true', 'finance may refund a paid sale of an open raffle');
select is(public.get_sale_admin((select sale_id from sales where label = 'pix')) -> 'raffle' -> 'numbers', '[1, 2]'::jsonb, 'the detail shows the numbers sold');
create temp table pix_refund as select public.reverse_confirmed_sale((select sale_id from sales where label = 'pix'), 'Comprador desistiu da rifa', 'EST-PIX-0001', null, 'refund-pix-key', gen_random_uuid()) result;
grant select on pix_refund to authenticated;
select is((select result ->> 'status' from pix_refund), 'CANCELLED', 'the raffle sale is cancelled by the refund');
select is((select result -> 'reversal' -> 'stock_movement_id' from pix_refund), 'null'::jsonb, 'a raffle refund moves no stock');
select is((select result -> 'reversal' -> 'raffle' -> 'numbers' from pix_refund), '[1, 2]'::jsonb, 'the refund reports the released numbers');
select is(public.reverse_confirmed_sale((select sale_id from sales where label = 'pix'), 'Comprador desistiu da rifa', 'EST-PIX-0001', null, 'refund-pix-key', gen_random_uuid()),
  (select result from pix_refund), 'a replay returns the same refund');
select throws_ok($$select public.reverse_confirmed_sale((select sale_id from sales where label = 'pix'), 'Comprador desistiu da rifa', 'EST-PIX-0002', null, 'refund-pix-other-key', gen_random_uuid())$$,
  'P0001', 'SALE_ALREADY_REVERSED', 'a raffle sale is never refunded twice');
create temp table cash_refund as select public.reverse_confirmed_sale((select sale_id from sales where label = 'cash'), 'Devolução em dinheiro no caixa', 'EST-CASH-001',
  (select shift_id::uuid from shift), 'refund-cash-key', gen_random_uuid()) result;
grant select on cash_refund to authenticated;
select is((select (result -> 'reversal' -> 'cash_payout' ->> 'amount_cents')::bigint from cash_refund), (select total_cents from sales where label = 'cash'), 'the drawer hands the cash back');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((select item -> 'numbers' from jsonb_array_elements(public.list_my_raffle_tickets()) item where item ->> 'sale_id' = (select sale_id::text from sales where label = 'cash')),
  '[3]'::jsonb, 'Meus bilhetes keeps the refunded purchase');
select is((select item ->> 'sale_status' from jsonb_array_elements(public.list_my_raffle_tickets()) item where item ->> 'sale_id' = (select sale_id::text from sales where label = 'cash')),
  'CANCELLED', 'the refunded purchase shows as cancelled');
select is(public.reserve_raffle_numbers((select campaign_id::uuid from campaigns where label = 'open'), array[1, 3], 'refund-resell', gen_random_uuid()) -> 'numbers',
  '[1, 3]'::jsonb, 'refunded numbers can be sold again while the raffle is open');

-- After the close: refunds only by cancelling the whole raffle before the draw.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.transition_raffle_campaign((select campaign_id::uuid from campaigns where label = 'closed'), 'CLOSE', 'refund-close', gen_random_uuid());
select is(public.get_sale_admin((select sale_id from sales where label = 'closed')) -> 'reversal' ->> 'blocked_reason', 'RAFFLE_CLOSED_REFUND_REQUIRES_CANCELLATION',
  'the detail explains why a closed raffle blocks the refund');
select throws_ok($$select public.reverse_confirmed_sale((select sale_id from sales where label = 'closed'), 'Comprador desistiu da rifa', 'EST-CLOSED-01', null, 'refund-closed-early', gen_random_uuid())$$,
  'P0001', 'RAFFLE_CLOSED_REFUND_REQUIRES_CANCELLATION', 'a closed raffle refunds nobody individually');
select public.cancel_raffle_campaign((select campaign_id::uuid from campaigns where label = 'closed'), 'Prêmio indisponível', 'refund-cancel', gen_random_uuid());
select is(public.reverse_confirmed_sale((select sale_id from sales where label = 'closed'), 'Rifa cancelada antes do sorteio', 'EST-CLOSED-02', null, 'refund-closed-late', gen_random_uuid()) ->> 'status',
  'CANCELLED', 'a raffle cancelled before the draw refunds its paid sales');

-- After the draw: nothing changes the eligible universe.
select public.transition_raffle_campaign((select campaign_id::uuid from campaigns where label = 'drawn'), 'CLOSE', 'refund-drawn-close', gen_random_uuid());
select is(public.draw_raffle_campaign((select campaign_id::uuid from campaigns where label = 'drawn'), 'refund-draw', gen_random_uuid()) ->> 'winner_number', '7', 'the only paid number wins');
select is(public.get_sale_admin((select sale_id from sales where label = 'drawn')) -> 'reversal' ->> 'allowed', 'false', 'a drawn raffle offers no refund');
select throws_ok($$select public.reverse_confirmed_sale((select sale_id from sales where label = 'drawn'), 'Comprador desistiu da rifa', 'EST-DRAWN-01', null, 'refund-drawn', gen_random_uuid())$$,
  'P0001', 'RAFFLE_ALREADY_DRAWN', 'a drawn raffle refunds nobody');
reset role;

select is((select string_agg(number || ':' || status, ',' order by number) from public.raffle_numbers where campaign_id = (select campaign_id::uuid from campaigns where label = 'open') and number <= 3),
  '1:RESERVED,2:AVAILABLE,3:RESERVED', 'released numbers returned to the board');
select is((select sum(amount_cents) from public.financial_ledger_entries where sale_id = (select sale_id from sales where label = 'pix')), 0::numeric, 'receipt and refund cancel out in the ledger');
select is((select numbers from public.raffle_sale_refunds where sale_id = (select sale_id from sales where label = 'pix')), array[1, 2], 'the refunded numbers are recorded');
select throws_ok($$delete from public.raffle_sale_refunds$$, 'P0001', 'RAFFLE_REFUND_IMMUTABLE', 'the refund record is immutable');
select ok(exists (select 1 from public.outbox_events where topic = 'raffles.sale.refunded' and aggregate_id = (select sale_id::text from sales where label = 'pix')), 'the refund is published to the outbox');
select is((select status::text from public.raffle_numbers where campaign_id = (select campaign_id::uuid from campaigns where label = 'drawn') and number = 7), 'PAID', 'the winning number stays paid');

select * from finish();
rollback;
