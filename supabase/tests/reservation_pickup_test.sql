-- Spec 4.3 / 5.10 (RES-003): atomic pickup of a prepared reservation at the frozen price.
begin;
select plan(20);

select ok(not has_function_privilege('anon','public.complete_reservation_pickup(uuid,public.payment_integration_channel,bigint,text,public.card_payment_method,uuid,text,uuid)','EXECUTE'),'anonymous cannot complete a pickup');

insert into public.inventory_balances (location_id, product_id) values
  ('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001',3,'Retiradas','pickup-stock',gen_random_uuid())$$,'admin prepares central stock');

-- Consumer reserves three units; the commission prepares two of them.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
create temp table res as select label, (public.create_commercial_reservation('50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'pickup-res-'||label,gen_random_uuid())->>'reservation_id')::uuid as reservation_id
from unnest(array['cash','card','active']) label;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.mark_commercial_reservation_ready(reservation_id,'Balcão da comissão','pickup-ready-'||label,gen_random_uuid()) from res where label in ('cash','card')$$,'the commission prepares two reservations');

-- A seller who does not operate the central location neither sees nor hands over these reservations.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select is((select count(*)::integer from jsonb_array_elements(public.list_pickup_reservations()) item where (item->>'reservation_id')::uuid in (select reservation_id from res)),0,'a seller only sees pickups at the locations it operates');
select throws_ok($$select public.complete_reservation_pickup((select reservation_id from res where label='cash'),'DINHEIRO',3000,null,null,null,'pickup-seller',gen_random_uuid())$$,'P0001','COMMERCIAL_RESERVATION_NOT_FOUND','a seller cannot hand over a central reservation');

-- The central operator lists and hands over the prepared reservations.
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select is((select count(*)::integer from jsonb_array_elements(public.list_pickup_reservations()) item where (item->>'reservation_id')::uuid in (select reservation_id from res)),2,'the operator lists the prepared reservations only');
select throws_ok($$select public.complete_reservation_pickup((select reservation_id from res where label='cash'),'DINHEIRO',3000,null,null,null,'pickup-no-shift',gen_random_uuid())$$,'P0001','SELLER_SHIFT_REQUIRED','cash pickup needs an open shift at the location');
select is((select status::text from public.commercial_reservations where id=(select reservation_id from res where label='cash')),'READY','a failed charge leaves the reservation ready');
select lives_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000001',0,'pickup-shift',gen_random_uuid())$$,'the operator opens a shift at the central location');
select throws_ok($$select public.complete_reservation_pickup((select reservation_id from res where label='cash'),'DINHEIRO',1000,null,null,null,'pickup-short',gen_random_uuid())$$,'P0001','CASH_TENDERED_INSUFFICIENT','the tendered cash must cover the frozen total');
create temp table cash_pickup as select public.complete_reservation_pickup((select reservation_id from res where label='cash'),'DINHEIRO',3000,null,null,null,'pickup-cash','74000000-0000-4000-8000-000000000001') result;
select is((select result->>'status' from cash_pickup),'COMPLETED','the cash pickup completes the reservation');
select is((select (result->>'change_cents')::bigint from cash_pickup),(3000 - (select total_cents from public.commercial_reservations where id=(select reservation_id from res where label='cash')))::bigint,'change is computed from the frozen total');
select is(public.complete_reservation_pickup((select reservation_id from res where label='cash'),'DINHEIRO',3000,null,null,null,'pickup-cash','74000000-0000-4000-8000-000000000001'),(select result from cash_pickup),'the pickup replay is idempotent');
select throws_ok($$select public.complete_reservation_pickup((select reservation_id from res where label='card'),'MAQUININHA',null,'NSU-PICKUP-01',null,null,'pickup-card-no-method',gen_random_uuid())$$,'22023','CARD_METHOD_REQUIRED','a card pickup needs the card method');
select is((public.complete_reservation_pickup((select reservation_id from res where label='card'),'MAQUININHA',null,'NSU-PICKUP-01','DEBITO',null,'pickup-card',gen_random_uuid())->>'card_method'),'DEBITO','a card pickup records the method');
select throws_ok($$select public.complete_reservation_pickup((select reservation_id from res where label='active'),'PIX_AREA',null,'PIX-PICKUP-01',null,null,'pickup-active',gen_random_uuid())$$,'P0001','COMMERCIAL_RESERVATION_NOT_READY','only prepared reservations are handed over');
select is((select item->>'channel' from jsonb_array_elements(public.list_my_sales(null,null,50)->'items') item where (item->>'sale_id')::uuid=(select converted_sale_id from public.commercial_reservations where id=(select reservation_id from res where label='cash'))),'RESERVA','the operator sees the pickup in "Minhas vendas"');
reset role;

select is((select channel::text||':'||(customer_id='10000000-0000-4000-8000-000000000003')::text||':'||(created_by='10000000-0000-4000-8000-000000000001')::text||':'||status::text
  from public.sales where id=(select converted_sale_id from public.commercial_reservations where id=(select reservation_id from res where label='cash'))),'RESERVA:true:true:CONFIRMED','the sale is RESERVA, keeps the consumer as customer and the operator apart');
select is((select sum(item.total_cents)::bigint from public.sale_items item where item.sale_id=(select converted_sale_id from public.commercial_reservations where id=(select reservation_id from res where label='card'))),
  (select total_cents from public.commercial_reservations where id=(select reservation_id from res where label='card')),'the sale keeps the reserved price');
select is((select stock.status::text from public.stock_reservations stock join public.commercial_reservations reservation on reservation.stock_reservation_id=stock.id where reservation.id=(select reservation_id from res where label='card')),'CONSUMED','the held stock is consumed once');

select * from finish();
rollback;
