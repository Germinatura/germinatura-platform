-- Spec 4.5 (EVT-001): events and campaigns are drafted, published, cancelled and archived, never deleted.
begin;
select plan(28);

select ok(not has_table_privilege('authenticated', 'public.portal_events', 'SELECT'), 'events are read only through functions');
select ok(not has_function_privilege('anon', 'public.list_portal_events(boolean,integer)', 'EXECUTE'), 'anonymous cannot list events');

set local role authenticated;
-- A consumer cannot manage events.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.save_portal_event(null, null, 'EVENTO', 'Festa junina', 'Quadrilha e comidas típicas', now() + interval '3 days',
  null, null, null, null, null, '{}', '{}', '{}', 'event-consumer', gen_random_uuid())$$, '42501', 'COMMUNICATIONS_MANAGE_REQUIRED', 'a consumer cannot create events');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.save_portal_event(null, null, 'EVENTO', 'Festa', 'Descrição', now() + interval '3 days', now() + interval '2 days',
  null, null, null, null, '{}', '{}', '{}', 'event-backwards', gen_random_uuid())$$, '22023', 'INVALID_PORTAL_EVENT', 'the end cannot come before the start');
select throws_ok($$select public.save_portal_event(null, null, 'EVENTO', 'Festa', 'Descrição', now() + interval '3 days', null,
  null, null, null, null, array[gen_random_uuid()], '{}', '{}', 'event-ghost-product', gen_random_uuid())$$, '22023', 'INVALID_PORTAL_EVENT_LINKS',
  'only published products can be linked');
select throws_ok($$select public.save_portal_event(null, null, 'CAMPANHA', 'Campanha', 'Descrição', now() + interval '3 days', null,
  null, null, null, null, '{}', '{}', array['10000000-0000-4000-8000-000000000003']::uuid[], 'event-not-seller', gen_random_uuid())$$, '22023',
  'INVALID_PORTAL_EVENT_LINKS', 'only sellers can be participants');

create temp table party as select public.save_portal_event(null, null, 'EVENTO', 'Festa da formatura', 'Noite com DJ e venda de bebidas.',
  now() + interval '5 days', now() + interval '5 days 4 hours', 'Ginásio da escola', 'https://exemplo.org/festa', 'Ver catálogo', '/catalogo',
  array['33f00000-0000-4000-8000-000000000001']::uuid[], '{}', array['10000000-0000-4000-8000-000000000002']::uuid[],
  'event-party', gen_random_uuid()) as result;
select is((select result ->> 'status' from party), 'RASCUNHO', 'a new event is a draft');
select is((select jsonb_array_length(result -> 'products') from party), 1, 'the published product is linked');
select is((select jsonb_array_length(result -> 'sellers') from party), 1, 'the participating seller is linked');
select is((select public.save_portal_event(null, null, 'EVENTO', 'Festa da formatura', 'Noite com DJ e venda de bebidas.',
  now() + interval '5 days', now() + interval '5 days 4 hours', 'Ginásio da escola', 'https://exemplo.org/festa', 'Ver catálogo', '/catalogo',
  array['33f00000-0000-4000-8000-000000000001']::uuid[], '{}', array['10000000-0000-4000-8000-000000000002']::uuid[],
  'event-party', gen_random_uuid()) ->> 'id'), (select result ->> 'id' from party), 'a replay returns the same event');

-- Drafts stay hidden from everyone but the communications team.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((select count(*) from jsonb_array_elements(public.list_portal_events(false, 50) -> 'items') item
  where item ->> 'id' = (select result ->> 'id' from party)), 0::bigint, 'a draft is not listed');
select throws_ok($$select public.get_portal_event((select (result ->> 'id')::uuid from party))$$, 'P0001', 'PORTAL_EVENT_NOT_FOUND',
  'a draft cannot be opened by a consumer');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.save_portal_event((select (result ->> 'id')::uuid from party), 7, 'EVENTO', 'Festa', 'Descrição', now() + interval '5 days',
  null, null, null, null, null, '{}', '{}', '{}', 'event-stale', gen_random_uuid())$$, 'P0001', 'PORTAL_EVENT_REVISION_CONFLICT', 'a stale edit is refused');
create temp table edited as select public.save_portal_event((select (result ->> 'id')::uuid from party), 1, 'EVENTO', 'Festa da formatura 2026',
  'Noite com DJ e venda de bebidas.', now() + interval '5 days', now() + interval '5 days 4 hours', 'Ginásio da escola', null, null, null,
  array['33f00000-0000-4000-8000-000000000001']::uuid[], '{}', '{}', 'event-edit', gen_random_uuid()) as result;
select is((select (result ->> 'revision')::integer from edited), 2, 'an edit moves the revision');

select lives_ok($$select public.transition_portal_event((select (result ->> 'id')::uuid from party), 'PUBLICAR', null, 'event-publish', gen_random_uuid())$$,
  'the event is published');
select throws_ok($$select public.transition_portal_event((select (result ->> 'id')::uuid from party), 'PUBLICAR', null, 'event-publish-again', gen_random_uuid())$$,
  'P0001', 'PORTAL_EVENT_NOT_DRAFT', 'an event is published once');

-- An event that is already over is not published.
create temp table past as select public.save_portal_event(null, null, 'EVENTO', 'Festa antiga', 'Já passou.', now() - interval '3 days',
  now() - interval '2 days', null, null, null, null, '{}', '{}', '{}', 'event-past', gen_random_uuid()) as result;
select throws_ok($$select public.transition_portal_event((select (result ->> 'id')::uuid from past), 'PUBLICAR', null, 'event-past-publish', gen_random_uuid())$$,
  'P0001', 'PORTAL_EVENT_ALREADY_OVER', 'an event that is over cannot be published');

-- Consumers see the published event, with its links.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((select item ->> 'title' from jsonb_array_elements(public.list_portal_events(false, 50) -> 'items') item
  where item ->> 'id' = (select result ->> 'id' from party)), 'Festa da formatura 2026', 'the published event is listed among the upcoming ones');
select is((select public.get_portal_event((select (result ->> 'id')::uuid from party)) ->> 'revision'), null, 'consumers do not see the revision');

-- The worker announces the publication to people who keep Eventos on.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select lives_ok($$select public.set_notification_preference('EVENTOS', false)$$, 'the seller silences events');
reset role;
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table claimed_publication as select * from public.worker_claim_outbox_events('worker-events', 100, 300);
select lives_ok($$select public.worker_process_outbox_event(id, 'worker-events') from claimed_publication$$, 'the worker delivers the announcement');
reset role;
set local role authenticated;

-- Cancelling keeps the event visible as cancelled and tells the people who were told.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.transition_portal_event((select (result ->> 'id')::uuid from party), 'CANCELAR', 'curto', 'event-cancel-short', gen_random_uuid())$$,
  '22023', 'INVALID_PORTAL_EVENT_TRANSITION', 'a cancellation needs a reason');
select lives_ok($$select public.transition_portal_event((select (result ->> 'id')::uuid from party), 'CANCELAR', 'Ginásio indisponível na data', 'event-cancel', gen_random_uuid())$$,
  'the event is cancelled with a reason');
select throws_ok($$select public.save_portal_event((select (result ->> 'id')::uuid from party), 4, 'EVENTO', 'Festa', 'Descrição', now() + interval '5 days',
  null, null, null, null, null, '{}', '{}', '{}', 'event-edit-cancelled', gen_random_uuid())$$, 'P0001', 'PORTAL_EVENT_CANCELLED', 'a cancelled event is frozen');
reset role;
select throws_ok($$delete from public.portal_events where id = (select (result ->> 'id')::uuid from party)$$, 'P0001', null, 'events are never deleted');
set local role authenticated;
reset role;
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table claimed_cancellation as select * from public.worker_claim_outbox_events('worker-events', 100, 300);
select lives_ok($$select public.worker_process_outbox_event(id, 'worker-events') from claimed_cancellation$$, 'the worker delivers the cancellation');
reset role;
set local role authenticated;

reset role;
select ok(exists (select 1 from public.notifications where kind = 'EVENT_PUBLISHED' and recipient_id = '10000000-0000-4000-8000-000000000003'
  and data ->> 'event_id' = (select result ->> 'id' from party))
  and exists (select 1 from public.notifications where kind = 'EVENT_CANCELLED' and recipient_id = '10000000-0000-4000-8000-000000000003'),
  'the consumer hears about the event and its cancellation');
select ok(not exists (select 1 from public.notifications where kind in ('EVENT_PUBLISHED', 'EVENT_CANCELLED')
  and recipient_id = '10000000-0000-4000-8000-000000000002'), 'nobody who turned Eventos off is told');

select * from finish();
rollback;
