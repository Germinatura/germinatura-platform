-- Spec 4.3 / 5.10 (RES-002): the commission prepares reservations, filters them and sets their deadlines.
begin;
select plan(22);

select ok(not has_function_privilege('anon','public.mark_commercial_reservation_ready(uuid,text,text,uuid)','EXECUTE'),'anonymous cannot prepare reservations');
select is((select hold_hours from public.reservation_settings),72,'reservations hold stock for 72 hours by default');

insert into public.inventory_balances (location_id, product_id) values
  ('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001',6,'Reservas administradas','res-admin-stock',gen_random_uuid())$$,'admin prepares central stock');
select throws_ok($$select public.update_reservation_settings(0,48,'res-settings-bad',gen_random_uuid())$$,'22023','INVALID_RESERVATION_SETTINGS','deadlines must be positive');
select lives_ok($$select public.update_reservation_settings(24,12,'res-settings',gen_random_uuid())$$,'the commission configures the deadlines');

-- Consumer: two reservations with the configured 24-hour hold.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
create temp table res as select label, (public.create_commercial_reservation('50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'res-admin-'||label,gen_random_uuid())->>'reservation_id')::uuid as reservation_id
from unnest(array['ready','other']) label;
-- created_at is the transaction start and expires_at the clock at insert, so a slow run adds a few seconds.
select ok((select extract(epoch from (expires_at - created_at)) from public.commercial_reservations where id=(select reservation_id from res where label='ready')) between 86400 and 86460,'a new reservation follows the configured hold');
select throws_ok($$select public.mark_commercial_reservation_ready((select reservation_id from res where label='ready'),null,'res-ready-consumer',gen_random_uuid())$$,'42501','RESERVATIONS_MANAGE_REQUIRED','a consumer cannot prepare a reservation');
select throws_ok($$select public.list_commercial_reservations_admin()$$,'42501','RESERVATIONS_MANAGE_REQUIRED','a consumer cannot list every reservation');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table ready as select public.mark_commercial_reservation_ready((select reservation_id from res where label='ready'),'Retire na sala da comissão, das 12h às 13h','res-ready','73000000-0000-4000-8000-000000000001') result;
select is((select result->>'status' from ready),'READY','the commission marks the reservation ready');
select is((select extract(epoch from (pickup_deadline - ready_at))::integer from public.commercial_reservations where id=(select reservation_id from res where label='ready')),43200,'the pickup deadline follows the configured window');
select is(public.mark_commercial_reservation_ready((select reservation_id from res where label='ready'),'Retire na sala da comissão, das 12h às 13h','res-ready','73000000-0000-4000-8000-000000000001'),(select result from ready),'marking ready is idempotent');
select throws_ok($$select public.mark_commercial_reservation_ready((select reservation_id from res where label='ready'),null,'res-ready-2',gen_random_uuid())$$,'P0001','COMMERCIAL_RESERVATION_NOT_ACTIVE','a reservation is prepared once');
select is((select (item->>'status') from jsonb_array_elements(public.list_commercial_reservations_admin('READY',null,null,null,null,100)->'items') item where (item->>'reservation_id')::uuid=(select reservation_id from res where label='ready')),'READY','the status filter finds prepared reservations');
select is((select count(*)::integer from jsonb_array_elements(public.list_commercial_reservations_admin(null,'consumidor',null,null,null,100)->'items') item where (item->>'reservation_id')::uuid in (select reservation_id from res)),2,'the customer filter searches name and e-mail');
select is((select count(*)::integer from jsonb_array_elements(public.list_commercial_reservations_admin(null,null,(now() at time zone 'America/Sao_Paulo')::date + 1,null,null,100)->'items') item where (item->>'reservation_id')::uuid in (select reservation_id from res)),0,'the period starts at the São Paulo day');
select throws_ok($$select public.list_commercial_reservations_admin('PRONTA',null,null,null,null,25)$$,'22023','INVALID_RESERVATION_FILTER','unknown statuses are rejected');

-- Only the commission cancels a prepared reservation.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.cancel_commercial_reservation((select reservation_id from res where label='ready'),'res-cancel-consumer',gen_random_uuid())$$,'P0001','COMMERCIAL_RESERVATION_READY_CANCEL_FORBIDDEN','the customer cannot cancel a prepared reservation');
select is((select status::text from public.commercial_reservations where id=(select reservation_id from res where label='ready')),'READY','the prepared reservation is untouched');
reset role;

-- The commission cancels an active reservation, releasing its stock.
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select is((public.cancel_commercial_reservation((select reservation_id from res where label='other'),'res-cancel-admin',gen_random_uuid())->>'status'),'CANCELLED','the commission cancels an active reservation');
reset role;

-- A prepared reservation past its pickup deadline expires and releases the stock.
update public.commercial_reservations set pickup_deadline = now() - interval '1 minute'
where id = (select reservation_id from res where label='ready');
select ok(private.expire_due_commercial_reservations(10) >= 1,'the expiry job picks up the overdue prepared reservation');
select is((select status::text from public.commercial_reservations where id=(select reservation_id from res where label='ready')),'EXPIRED','an overdue prepared reservation expires');
select is((select stock.status::text from public.stock_reservations stock join public.commercial_reservations reservation on reservation.stock_reservation_id = stock.id where reservation.id=(select reservation_id from res where label='ready')),'EXPIRED','its stock is released');

select * from finish();
rollback;
