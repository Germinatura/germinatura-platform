begin;
select plan(41);

select has_table('public', 'raffle_campaigns', 'raffle campaigns table exists');
select has_table('public', 'raffle_numbers', 'raffle numbers table exists');
select has_table('public', 'raffle_draws', 'raffle draws table exists');
select has_function('public', 'create_raffle_campaign', array['text','uuid','uuid','integer','timestamptz','timestamptz','text','uuid'], 'campaign create RPC exists');
select has_function('public', 'reserve_raffle_numbers', array['uuid','integer[]','text','uuid'], 'number reservation RPC exists');
select has_function('public', 'cancel_raffle_reservation', array['uuid','text','uuid'], 'reservation cancel RPC exists');
select has_function('public', 'close_raffle_campaign', array['uuid','text','uuid'], 'campaign close RPC exists');
select has_function('public', 'draw_raffle_campaign', array['uuid','text','uuid'], 'draw RPC exists');
select ok((select relrowsecurity from pg_class where oid = 'public.raffle_numbers'::regclass), 'raffle numbers have RLS');
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename in ('raffle_campaigns','raffle_numbers','raffle_draws') and cmd in ('INSERT','UPDATE','DELETE')$$,
  array[0::bigint], 'raffle tables expose no write policies'
);
select ok(not has_function_privilege('anon', 'public.reserve_raffle_numbers(uuid,integer[],text,uuid)', 'EXECUTE'), 'anonymous reservation is denied');
select ok(not has_function_privilege('anon', 'public.draw_raffle_campaign(uuid,text,uuid)', 'EXECUTE'), 'anonymous draw is denied');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table campaign as
select public.create_raffle_campaign(
  'Rifa de teste', '33f00000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', 20,
  now() - interval '1 minute', now() + interval '1 day',
  'raffle-campaign-1', '92000000-0000-4000-8000-000000000001'
) as result;
select results_eq($$select result ->> 'status' from campaign$$, array['ACTIVE'::text], 'campaign starts active');
select results_eq(
  $$select count(*)::bigint from public.raffle_numbers where campaign_id = (select (result ->> 'campaign_id')::uuid from campaign)$$,
  array[20::bigint], 'campaign materializes every unique number'
);
select results_eq(
  $$select public.create_raffle_campaign('Rifa de teste', '33f00000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 20, (select starts_at from public.raffle_campaigns where id = (select (result ->> 'campaign_id')::uuid from campaign)), (select ends_at from public.raffle_campaigns where id = (select (result ->> 'campaign_id')::uuid from campaign)), 'raffle-campaign-1', '92000000-0000-4000-8000-000000000099')$$,
  $$select result from campaign$$, 'campaign create replays idempotently'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
create temp table paid_candidate as
select public.reserve_raffle_numbers(
  (select (result ->> 'campaign_id')::uuid from campaign), array[2,1],
  'raffle-reserve-paid', '92000000-0000-4000-8000-000000000002'
) as result;
select results_eq($$select result -> 'numbers' from paid_candidate$$, array['[1, 2]'::jsonb], 'numbers are frozen in sorted order');
select results_eq($$select result ->> 'status' from paid_candidate$$, array['RESERVED'::text], 'number hold starts reserved');
select results_eq(
  $$select count(*)::bigint from public.raffle_numbers where campaign_id = (select (result ->> 'campaign_id')::uuid from campaign) and status = 'RESERVED'$$,
  array[2::bigint], 'exact selected numbers are reserved'
);
select throws_ok(
  $$select public.reserve_raffle_numbers((select (result ->> 'campaign_id')::uuid from campaign), array[2,3], 'raffle-conflict', '92000000-0000-4000-8000-000000000003')$$,
  'P0001', 'RAFFLE_NUMBER_CONFLICT', 'overlapping number reservation has one winner'
);
select throws_ok(
  $$select public.reserve_raffle_numbers((select (result ->> 'campaign_id')::uuid from campaign), array[4,4], 'raffle-duplicate', '92000000-0000-4000-8000-000000000004')$$,
  '22023', 'INVALID_RAFFLE_NUMBERS', 'duplicate requested numbers are rejected'
);
select results_eq(
  $$select public.reserve_raffle_numbers((select (result ->> 'campaign_id')::uuid from campaign), array[1,2], 'raffle-reserve-paid', '92000000-0000-4000-8000-000000000005')$$,
  $$select result from paid_candidate$$, 'reservation replay creates no duplicate sale'
);
create temp table cancelled_candidate as
select public.reserve_raffle_numbers(
  (select (result ->> 'campaign_id')::uuid from campaign), array[3],
  'raffle-reserve-cancel', '92000000-0000-4000-8000-000000000006'
) as result;
create temp table cancelled as
select public.cancel_raffle_reservation(
  (select (result ->> 'sale_id')::uuid from cancelled_candidate),
  'raffle-cancel-1', '92000000-0000-4000-8000-000000000007'
) as result;
select results_eq($$select result ->> 'status' from cancelled$$, array['CANCELLED'::text], 'pending raffle sale cancels');
select results_eq(
  $$select status::text from public.raffle_numbers where campaign_id = (select (result ->> 'campaign_id')::uuid from campaign) and number = 3$$,
  array['AVAILABLE'::text], 'cancellation makes the number available again'
);
select results_eq(
  $$select public.cancel_raffle_reservation((select (result ->> 'sale_id')::uuid from cancelled_candidate), 'raffle-cancel-1', '92000000-0000-4000-8000-000000000008')$$,
  $$select result from cancelled$$, 'cancellation replay is idempotent'
);
reset role;

select lives_ok(
  $$select private.transition_sale_state((select (result ->> 'sale_id')::uuid from paid_candidate), 'CONFIRMED', '10000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000009', 'Confirmação controlada de teste')$$,
  'confirmed linked sale marks raffle numbers paid'
);
select results_eq(
  $$select array_agg(number order by number) from public.raffle_numbers where campaign_id = (select (result ->> 'campaign_id')::uuid from campaign) and status = 'PAID'$$,
  $$values (array[1,2]::integer[])$$, 'only numbers from a confirmed sale become paid'
);
select results_eq(
  $$select count(*)::bigint from public.raffle_numbers where campaign_id = (select (result ->> 'campaign_id')::uuid from campaign) and status = 'RESERVED'$$,
  array[0::bigint], 'campaign has no pending reservation before close'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.draw_raffle_campaign((select (result ->> 'campaign_id')::uuid from campaign), 'raffle-consumer-draw', '92000000-0000-4000-8000-000000000010')$$,
  '42501', 'RAFFLE_MANAGE_FORBIDDEN', 'consumer cannot draw'
);
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select public.close_raffle_campaign((select (result ->> 'campaign_id')::uuid from campaign), 'raffle-close-1', '92000000-0000-4000-8000-000000000011') ->> 'status'$$,
  array['CLOSED'::text], 'admin closes campaign before draw'
);
create temp table draw as
select public.draw_raffle_campaign(
  (select (result ->> 'campaign_id')::uuid from campaign),
  'raffle-draw-1', '92000000-0000-4000-8000-000000000012'
) as result;
select results_eq($$select result -> 'eligible_numbers' from draw$$, array['[1, 2]'::jsonb], 'draw freezes only paid numbers in order');
select results_eq($$select length(result ->> 'random_material') from draw$$, array[64], 'draw stores 256-bit random material');
select results_eq($$select length(result ->> 'audit_hash') from draw$$, array[64], 'draw stores a SHA-256 audit hash');
select results_eq(
  $$select (result ->> 'winner_number')::integer = ((result -> 'eligible_numbers') ->> ((result ->> 'winner_index')::integer - 1))::integer from draw$$,
  array[true], 'winner number matches the persisted one-based index'
);
select results_eq(
  $$select public.draw_raffle_campaign((select (result ->> 'campaign_id')::uuid from campaign), 'raffle-draw-1', '92000000-0000-4000-8000-000000000013')$$,
  $$select result from draw$$, 'same draw key replays the unique proof'
);
select throws_ok(
  $$select public.draw_raffle_campaign((select (result ->> 'campaign_id')::uuid from campaign), 'raffle-draw-2', '92000000-0000-4000-8000-000000000014')$$,
  'P0001', 'RAFFLE_CAMPAIGN_NOT_DRAWABLE', 'campaign cannot be selectively redrawn'
);
reset role;
select results_eq($$select count(*)::bigint from public.raffle_draws$$, array[1::bigint], 'exactly one draw proof exists');
select results_eq($$select status::text from public.raffle_campaigns where id = (select (result ->> 'campaign_id')::uuid from campaign)$$, array['DRAWN'::text], 'campaign is terminally drawn');
select throws_ok($$update public.raffle_draws set winner_index = 1 where true$$, 'P0001', 'IMMUTABLE_RECORD', 'draw proof cannot be edited');
select throws_ok($$delete from public.raffle_draws where true$$, 'P0001', 'IMMUTABLE_RECORD', 'draw proof cannot be deleted');
select results_eq($$select count(*)::bigint from public.audit_logs where action = 'raffles.drawn'$$, array[1::bigint], 'draw is audited once');
select results_eq($$select count(*)::bigint from public.outbox_events where topic = 'raffles.drawn'$$, array[1::bigint], 'draw emits one outbox event');

select * from finish();
rollback;
