-- Spec 4.4, 5.11 and 15.5 (RAF-002): raffle lifecycle and buyer privacy.
begin;
select plan(33);

select ok(not has_table_privilege('authenticated', 'public.raffle_numbers', 'SELECT'), 'buyers cannot read who holds each number');
select ok(not has_function_privilege('anon', 'public.transition_raffle_campaign(uuid,text,text,uuid)', 'EXECUTE'), 'anonymous cannot change campaigns');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table life as select public.create_raffle_campaign('Rifa do ciclo', '33f00000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', 20, now() - interval '1 minute', now() + interval '1 day', 'life-create', gen_random_uuid()) result;
grant select on life to authenticated;
create temp table stale as select public.create_raffle_campaign('Rifa vencida', '33f00000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', 5, now() - interval '2 days', now() - interval '1 day', 'life-stale', gen_random_uuid()) result;
grant select on stale to authenticated;
select is((select result ->> 'status' from life), 'DRAFT', 'a new campaign is a draft');
select is(public.update_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'Rifa do ciclo', 'Concorra a uma cesta.',
  '33f00000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 30, now() - interval '1 minute', now() + interval '1 day',
  'life-update', gen_random_uuid()) ->> 'number_count', '30', 'the draft structure can be edited');
select throws_ok($$select public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from stale), 'PUBLISH', 'life-publish-stale', gen_random_uuid())$$,
  'P0001', 'RAFFLE_PERIOD_OVER', 'a campaign whose period is over cannot be published');
select throws_ok($$select public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'RESUME', 'life-resume-draft', gen_random_uuid())$$,
  'P0001', 'RAFFLE_TRANSITION_INVALID', 'a draft cannot be resumed');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((select count(*)::integer from jsonb_array_elements(public.list_raffles_for_buyer()) item where item ->> 'campaign_id' = (select result ->> 'campaign_id' from life)), 0, 'buyers do not see drafts');
select throws_ok($$select public.get_raffle_number_board((select (result ->> 'campaign_id')::uuid from life))$$, 'P0001', 'RAFFLE_CAMPAIGN_NOT_FOUND', 'a draft has no public board');
select throws_ok($$select public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'PUBLISH', 'life-publish-buyer', gen_random_uuid())$$,
  '42501', 'RAFFLE_MANAGE_FORBIDDEN', 'buyers cannot publish');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'PUBLISH', 'life-publish', gen_random_uuid()) ->> 'status', 'ACTIVE', 'publishing opens sales');
select is(jsonb_array_length(public.get_raffle_number_board((select (result ->> 'campaign_id')::uuid from life))), 30, 'publishing materializes the numbers');
select throws_ok($$select public.update_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'Rifa do ciclo', null,
  '33f00000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 40, now() - interval '1 minute', now() + interval '1 day', 'life-update-late', gen_random_uuid())$$,
  'P0001', 'RAFFLE_STRUCTURE_LOCKED', 'the structure is immutable after publishing');
select is(public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'PAUSE', 'life-pause', gen_random_uuid()) ->> 'status', 'PAUSED', 'sales can be paused');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.reserve_raffle_numbers((select (result ->> 'campaign_id')::uuid from life), array[1], 'life-reserve-paused', gen_random_uuid())$$,
  'P0001', 'RAFFLE_CAMPAIGN_NOT_AVAILABLE', 'a paused campaign takes no reservation');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'RESUME', 'life-resume', gen_random_uuid()) ->> 'status', 'ACTIVE', 'sales can resume');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
create temp table life_paid as select public.reserve_raffle_numbers((select (result ->> 'campaign_id')::uuid from life), array[1,2], 'life-reserve-paid', gen_random_uuid()) result;
create temp table life_pending as select public.reserve_raffle_numbers((select (result ->> 'campaign_id')::uuid from life), array[3], 'life-reserve-pending', gen_random_uuid()) result;
grant select on life_paid, life_pending to authenticated;
select throws_ok($$select count(*) from public.raffle_numbers$$, '42501', null, 'buyers cannot query the number table');
reset role;
select private.transition_sale_state((select (result ->> 'sale_id')::uuid from life_paid), 'CONFIRMED', '10000000-0000-4000-8000-000000000001', gen_random_uuid(), 'Pagamento de teste');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((select item -> 'my_numbers' from jsonb_array_elements(public.list_raffles_for_buyer()) item where item ->> 'campaign_id' = (select result ->> 'campaign_id' from life)) @> '[{"number":1,"status":"PAID"},{"number":3,"status":"RESERVED"}]'::jsonb, true, 'the buyer sees their own tickets');
select ok(public.list_raffles_for_buyer()::text !~ 'reserved_by|10000000-0000-4000-8000-000000000003', 'the buyer listing names nobody');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is((select string_agg(item ->> 1, ',' order by (item ->> 0)::integer) from jsonb_array_elements(public.get_raffle_number_board((select (result ->> 'campaign_id')::uuid from life))) item where (item ->> 0)::integer <= 4),
  'TAKEN,TAKEN,TAKEN,AVAILABLE', 'others only see that a number is taken');
select throws_ok($$select public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'CLOSE', 'life-close-pending', gen_random_uuid())$$,
  'P0001', 'RAFFLE_PENDING_RESERVATIONS', 'a pending reservation blocks closing');
select is((select (item ->> 'paid_count')::integer || ':' || (item ->> 'reserved_count')::integer || ':' || (item ->> 'paid_sales')::integer
  from jsonb_array_elements(public.list_raffles_admin(50)) item where item ->> 'campaign_id' = (select result ->> 'campaign_id' from life)), '2:1:1', 'managers see occupancy and payments');

-- Cancelling before the draw releases the pending reservation and keeps the paid numbers for refund.
create temp table life_cancel as select public.cancel_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'Prêmio indisponível', 'life-cancel', gen_random_uuid()) result;
select is((select result ->> 'status' from life_cancel), 'CANCELLED', 'the campaign is cancelled');
select is((select (result ->> 'paid_sales_to_refund')::integer from life_cancel), 1, 'the paid sale is reported for refund');
select is(public.cancel_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'Prêmio indisponível', 'life-cancel', gen_random_uuid()), (select result from life_cancel), 'cancellation replay is idempotent');
select throws_ok($$select public.cancel_raffle_campaign((select (result ->> 'campaign_id')::uuid from life), 'Outro motivo', 'life-cancel-again', gen_random_uuid())$$,
  'P0001', 'RAFFLE_TRANSITION_INVALID', 'a cancelled campaign cannot be cancelled again');
reset role;
select is((select status::text from public.sales where id = (select (result ->> 'sale_id')::uuid from life_pending)), 'CANCELLED', 'the pending sale is cancelled');
select is((select status::text from public.payment_attempts where sale_id = (select (result ->> 'sale_id')::uuid from life_pending)), 'CANCELLED', 'its payment attempt is cancelled');
select is((select status::text from public.raffle_numbers where campaign_id = (select (result ->> 'campaign_id')::uuid from life) and number = 3), 'AVAILABLE', 'the reserved number is released');
select is((select string_agg(status::text, ',' order by number) from public.raffle_numbers where campaign_id = (select (result ->> 'campaign_id')::uuid from life) and number in (1,2)), 'PAID,PAID', 'paid numbers keep their history');
select is((select count(*)::integer from public.outbox_events where topic = 'raffles.campaign.cancelled' and aggregate_id = (select result ->> 'campaign_id' from life)), 1, 'the cancellation is announced once');
select throws_ok($$update public.raffle_campaigns set number_count = 50 where id = (select (result ->> 'campaign_id')::uuid from life)$$,
  'P0001', 'RAFFLE_STRUCTURE_LOCKED', 'the structure cannot be changed behind the RPCs');

-- A drawn campaign cannot be cancelled.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table drawn as select public.create_raffle_campaign('Rifa sorteada', '33f00000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', 5, now() - interval '1 minute', now() + interval '1 day', 'life-drawn', gen_random_uuid()) result;
grant select on drawn to authenticated;
select public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from drawn), 'PUBLISH', 'life-drawn-publish', gen_random_uuid());
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
create temp table drawn_sale as select public.reserve_raffle_numbers((select (result ->> 'campaign_id')::uuid from drawn), array[4], 'life-drawn-reserve', gen_random_uuid()) result;
grant select on drawn_sale to authenticated;
reset role;
select private.transition_sale_state((select (result ->> 'sale_id')::uuid from drawn_sale), 'CONFIRMED', '10000000-0000-4000-8000-000000000001', gen_random_uuid(), 'Pagamento de teste');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from drawn), 'CLOSE', 'life-drawn-close', gen_random_uuid());
select is(public.draw_raffle_campaign((select (result ->> 'campaign_id')::uuid from drawn), 'life-drawn-draw', gen_random_uuid()) ->> 'winner_number', '4', 'the only paid number wins');
select throws_ok($$select public.cancel_raffle_campaign((select (result ->> 'campaign_id')::uuid from drawn), 'Tarde demais', 'life-drawn-cancel', gen_random_uuid())$$,
  'P0001', 'RAFFLE_ALREADY_DRAWN', 'a drawn campaign cannot be cancelled');
reset role;

select * from finish();
rollback;
