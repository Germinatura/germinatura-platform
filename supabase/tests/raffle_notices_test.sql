-- Spec 4.4, 5.11 and 15.5 (RAF-006): raffle notices reach the sale's customer, managers reach walk-in winners,
-- buyers hear about cancellations and refunds, and only managers list buyers and contacts.
begin;
select plan(15);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table campaigns as
select label, public.create_raffle_campaign('Rifa aviso ' || label, '33f00000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 10,
  now() - interval '1 minute', now() + interval '1 day', 'notice-create-' || label, gen_random_uuid()) ->> 'campaign_id' campaign_id
from unnest(array['walk_in', 'mine', 'gone']) label;
grant select on campaigns to authenticated;
select public.transition_raffle_campaign(campaign_id::uuid, 'PUBLISH', 'notice-publish-' || label, gen_random_uuid()) from campaigns;

-- The seller sells: a walk-in buyer alone in one raffle, the registered consumer alone in another, both in the third.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table sales (label text primary key, sale_id uuid);
insert into sales select 'walk_in', (public.reserve_raffle_numbers_pdv((select campaign_id::uuid from campaigns where label = 'walk_in'),
  '50000000-0000-4000-8000-000000000002', array[4], null, 'Maria Souza', 'maria.aviso@exemplo.com', 'notice-walk-in', gen_random_uuid()) ->> 'sale_id')::uuid;
insert into sales select 'mine', (public.reserve_raffle_numbers_pdv((select campaign_id::uuid from campaigns where label = 'mine'),
  '50000000-0000-4000-8000-000000000002', array[6], '10000000-0000-4000-8000-000000000003', null, null, 'notice-mine', gen_random_uuid()) ->> 'sale_id')::uuid;
insert into sales select 'gone_registered', (public.reserve_raffle_numbers_pdv((select campaign_id::uuid from campaigns where label = 'gone'),
  '50000000-0000-4000-8000-000000000002', array[1], '10000000-0000-4000-8000-000000000003', null, null, 'notice-gone-registered', gen_random_uuid()) ->> 'sale_id')::uuid;
insert into sales select 'gone_walk_in', (public.reserve_raffle_numbers_pdv((select campaign_id::uuid from campaigns where label = 'gone'),
  '50000000-0000-4000-8000-000000000002', array[2], null, 'João Lima', '(11) 97777-6666', 'notice-gone-walk-in', gen_random_uuid()) ->> 'sale_id')::uuid;
grant select on sales to authenticated;
select public.confirm_manual_payment(sale_id, 'PIX_AREA', 'PIX-AVISO-' || label, null, null, 'notice-pay-' || label, gen_random_uuid()) from sales;
select throws_ok($$select public.list_raffle_buyers((select campaign_id::uuid from campaigns where label = 'gone'))$$,
  '42501', 'RAFFLE_MANAGE_FORBIDDEN', 'sellers do not list buyers and contacts');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.list_raffle_buyers((select campaign_id::uuid from campaigns where label = 'gone'))$$,
  '42501', 'RAFFLE_MANAGE_FORBIDDEN', 'buyers never list other buyers');

-- Management: draws, cancellation and a refund.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.transition_raffle_campaign(campaign_id::uuid, 'CLOSE', 'notice-close-' || label, gen_random_uuid()) from campaigns where label <> 'gone';
select public.draw_raffle_campaign(campaign_id::uuid, 'notice-draw-' || label, gen_random_uuid()) from campaigns where label <> 'gone';
select public.cancel_raffle_campaign((select campaign_id::uuid from campaigns where label = 'gone'), 'Prêmio indisponível', 'notice-cancel', gen_random_uuid());
create temp table buyers_before as select public.list_raffle_buyers((select campaign_id::uuid from campaigns where label = 'gone')) result;
grant select on buyers_before to authenticated;
select is(jsonb_array_length((select result from buyers_before)), 2, 'managers list every buyer of the raffle');
select is((select item ->> 'buyer_contact' from jsonb_array_elements((select result from buyers_before)) item where item ->> 'sale_id' = (select sale_id::text from sales where label = 'gone_walk_in')),
  '11977776666', 'managers see the walk-in contact to reach the buyer');
select is((select item ->> 'registered' from jsonb_array_elements((select result from buyers_before)) item where item ->> 'sale_id' = (select sale_id::text from sales where label = 'gone_registered')),
  'true', 'registered buyers are marked as such');
select public.reverse_confirmed_sale((select sale_id from sales where label = 'gone_registered'), 'Rifa cancelada antes do sorteio', 'EST-AVISO-01', null, 'notice-refund', gen_random_uuid());
select is((select item ->> 'status' from jsonb_array_elements(public.list_raffle_buyers((select campaign_id::uuid from campaigns where label = 'gone'))) item
  where item ->> 'sale_id' = (select sale_id::text from sales where label = 'gone_registered')), 'REFUNDED', 'refunded purchases stay in the buyer list');
reset role;

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table claimed as select * from public.worker_claim_outbox_events('worker-raffle-notices', 100, 300);
select lives_ok($$select public.worker_process_outbox_event(id, 'worker-raffle-notices') from claimed$$, 'the worker delivers the raffle notices');
reset role;

select is((select count(*)::integer from public.notifications where recipient_id = '10000000-0000-4000-8000-000000000002' and kind = 'RAFFLE_DRAWN'),
  0, 'the seller of a walk-in sale is never told they won');
select is((select count(*)::integer from public.notifications where recipient_id = '10000000-0000-4000-8000-000000000001' and kind = 'RAFFLE_WINNER_CONTACT'
  and data ->> 'campaign_id' = (select campaign_id from campaigns where label = 'walk_in')), 1, 'managers are asked to contact the walk-in winner');
select is((select count(*)::integer from public.notifications where kind = 'RAFFLE_WINNER_CONTACT' and data ->> 'campaign_id' = (select campaign_id from campaigns where label = 'mine')),
  0, 'a registered winner needs no manager contact');
select is((select data ->> 'won' from public.notifications where recipient_id = '10000000-0000-4000-8000-000000000003' and kind = 'RAFFLE_DRAWN'
  and data ->> 'campaign_id' = (select campaign_id from campaigns where label = 'mine')), 'true', 'the registered buyer of a PDV sale learns they won');
select is((select count(*)::integer from public.notifications where recipient_id = '10000000-0000-4000-8000-000000000003' and kind = 'RAFFLE_CANCELLED'
  and data ->> 'campaign_id' = (select campaign_id from campaigns where label = 'gone')), 1, 'buyers are told the raffle was cancelled');
select is((select (data ->> 'paid_sales_to_refund')::integer from public.notifications where recipient_id = '10000000-0000-4000-8000-000000000001' and kind = 'RAFFLE_REFUNDS_PENDING'
  and data ->> 'campaign_id' = (select campaign_id from campaigns where label = 'gone')), 2, 'finance is told which paid sales to refund');
select is((select count(*)::integer from public.notifications where recipient_id = '10000000-0000-4000-8000-000000000003' and kind = 'RAFFLE_REFUNDED'),
  1, 'the buyer is told the purchase was refunded');
select ok(not exists (select 1 from public.notifications where (body || data::text) ~ '(exemplo\.com|97777)'), 'notices never carry a walk-in contact');

select * from finish();
rollback;
