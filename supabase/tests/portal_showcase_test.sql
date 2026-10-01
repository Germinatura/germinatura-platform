-- Spec 4.1 (VIT-001): the Início showcase brings the highlight, new products, live promotions, upcoming events
-- and raffles on sale.
begin;
select plan(13);

select ok(not has_function_privilege('anon', 'public.get_portal_showcase()', 'EXECUTE'), 'anonymous cannot read the showcase');
select ok(not has_table_privilege('authenticated', 'public.portal_highlights', 'SELECT'), 'highlights are read only through functions');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.save_portal_highlight('Festa', null, null, null, true, null, 'highlight-consumer', gen_random_uuid())$$,
  '42501', 'COMMUNICATIONS_MANAGE_REQUIRED', 'a consumer cannot change the highlight');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.save_portal_highlight('Festa', null, 'Ver', null, true, null, 'highlight-half-cta', gen_random_uuid())$$,
  '22023', 'INVALID_PORTAL_HIGHLIGHT', 'a call to action needs text and link');
select throws_ok($$select public.save_portal_highlight('Festa', null, null, null, true, now() - interval '1 hour', 'highlight-expired', gen_random_uuid())$$,
  '22023', 'INVALID_PORTAL_HIGHLIGHT', 'an active highlight cannot end in the past');
select lives_ok($$select public.save_portal_highlight('Festa da formatura', 'Ingressos à venda no PDV.', 'Ver eventos', '/eventos', true,
  now() + interval '7 days', 'highlight-on', gen_random_uuid())$$, 'the communications team sets the highlight');

-- A live public promotion, an upcoming event and an open raffle.
create temp table live as select public.save_quantity_price_promotion(null, null, 'SHOWCASE-LIVE', 'Duas por dez', 'Oferta no ar', true, true, 150, false,
  now() - interval '1 hour', now() + interval '2 days', null, null, array['33000000-0000-4000-8000-000000000001']::uuid[],
  array['PORTAL', 'PDV']::public.promotion_channel[], 2, 1000, 3, 'Promoção pública', 'showcase-live', gen_random_uuid()) as result;
create temp table party as select public.save_portal_event(null, null, 'EVENTO', 'Festa da vitrine', 'Noite de festa.', now() + interval '3 days',
  null, null, null, null, null, '{}', '{}', '{}', 'showcase-event', gen_random_uuid()) as result;
select public.transition_portal_event((select (result ->> 'id')::uuid from party), 'PUBLICAR', null, 'showcase-event-publish', gen_random_uuid());
create temp table raffle as select public.create_raffle_campaign('Rifa da vitrine', '33f00000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', 10, now() - interval '1 minute', now() + interval '1 day', 'showcase-raffle', gen_random_uuid()) as result;
select public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from raffle), 'PUBLISH', 'showcase-raffle-publish', gen_random_uuid());
-- A new product reaches the showcase once it is published with central stock (NOTIF-005).
select public.adjust_stock('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000002', 2, 'Estoque da novidade', 'showcase-new-stock', gen_random_uuid());
reset role;
update public.products set published = true where id = '33f00000-0000-4000-8000-000000000002';

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
create temp table showcase as select public.get_portal_showcase() as result;
select is((select result -> 'highlight' ->> 'title' from showcase), 'Festa da formatura', 'the consumer sees the highlight');
select ok((select result -> 'new_products' -> 0 ->> 'id' from showcase) = '33f00000-0000-4000-8000-000000000002', 'the newest product comes first');
select ok(exists (select 1 from showcase, jsonb_array_elements(result -> 'promotions') item where item ->> 'id' = (select result ->> 'id' from live)),
  'the live public promotion is shown');
select ok(exists (select 1 from showcase, jsonb_array_elements(result -> 'events') item where item ->> 'id' = (select result ->> 'id' from party)),
  'the upcoming event is shown');
select ok(exists (select 1 from showcase, jsonb_array_elements(result -> 'raffles') item
  where item ->> 'id' = (select result ->> 'campaign_id' from raffle) and (item ->> 'available_count')::integer = 10), 'the open raffle is shown with its free numbers');

-- Turning the highlight off hides it but keeps its history.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.save_portal_highlight('Festa da formatura', null, null, null, false, null, 'highlight-off', gen_random_uuid())$$,
  'the highlight is turned off');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((select public.get_portal_showcase() -> 'highlight'), 'null'::jsonb, 'a highlight turned off is not shown');
reset role;

select * from finish();
rollback;
