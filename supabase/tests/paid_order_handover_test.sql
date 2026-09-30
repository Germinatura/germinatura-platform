-- Spec 4.3 and 5.10 (RES-005): an order paid online is handed over at the PDV without a second charge, and a
-- replay or a double tap never duplicates the sale, the stock movement or the finance entry.
begin;
select plan(15);

insert into public.inventory_balances(location_id, product_id)
values ('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.adjust_stock('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001', 3, 'Estoque entrega paga', 'handover-stock', gen_random_uuid());
select public.update_feature_flag('payment_link', true, 'Teste da entrega paga', gen_random_uuid());

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
create temp table orders (label text primary key, reservation_id uuid, charge_id uuid, amount_cents bigint);
grant select on orders to authenticated, service_role;
insert into orders (label, reservation_id) select label, (public.create_commercial_reservation('50000000-0000-4000-8000-000000000001',
  '[{"quantity":1,"product_id":"33f00000-0000-4000-8000-000000000001"}]'::jsonb, 'handover-res-' || label, gen_random_uuid()) ->> 'reservation_id')::uuid
from unnest(array['paid', 'pending']) label;
update orders set charge_id = (public.request_portal_payment_link(reservation_id, 'https://portal.example', 'handover-link-' || label, gen_random_uuid()) ->> 'charge_id')::uuid;
select throws_ok($$select public.deliver_paid_reservation((select reservation_id from orders where label = 'paid'), 'handover-consumer', gen_random_uuid())$$,
  '42501', 'SELLER_REQUIRED', 'consumers do not hand over orders');
reset role;
update orders set amount_cents = (select amount_cents from public.payment_link_charges where id = orders.charge_id);

-- PicPay confirms only the first order.
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select public.worker_claim_payment_link_requests('worker-handover', 10, 120);
select public.worker_record_payment_link_created(charge_id, 'worker-handover', 'handover-link-' || label, 'https://link.picpay.com/p/handover-link-' || label, null, null) from orders;
select public.worker_record_payment_link_event('WEBHOOK', 'TransactionPaymentMessage',
  jsonb_build_object('type', 'PAYMENT', 'data', jsonb_build_object('transaction', jsonb_build_object('id', 'handover-tx-0001', 'status', 'PAYED',
    'amount', (select amount_cents from orders where label = 'paid'), 'paymentType', 'PIX'),
    'charge', jsonb_build_object('paymentLinkId', 'handover-link-paid'))));
reset role;

create temp table before_handover as
select sale.id sale_id,
  (select count(*) from public.sales where customer_id = '10000000-0000-4000-8000-000000000003') sales,
  (select count(*) from public.stock_movements where source_type = 'sale' and source_id = sale.id::text) movements,
  (select count(*) from public.financial_ledger_entries where sale_id = sale.id) entries
from public.sales sale where sale.id = (select converted_sale_id from public.commercial_reservations where id = (select reservation_id from orders where label = 'paid'));
grant select on before_handover to authenticated;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is((select item ->> 'paid_online' from jsonb_array_elements(public.list_pickup_reservations(null, 50)) item
  where item ->> 'reservation_id' = (select reservation_id::text from orders where label = 'paid')), 'true', 'the paid order waits for delivery');
select ok(not exists (select 1 from jsonb_array_elements(public.list_pickup_reservations(null, 50)) item
  where item ->> 'reservation_id' = (select reservation_id::text from orders where label = 'pending')), 'an order still awaiting the online payment is not listed');
select throws_ok($$select public.complete_reservation_pickup((select reservation_id from orders where label = 'paid'), 'PIX_AREA', null, 'PIX-DUPLO-01', null, null, 'handover-charge-again', gen_random_uuid())$$,
  'P0001', 'COMMERCIAL_RESERVATION_NOT_READY', 'a paid order is never charged again at pickup');
select throws_ok($$select public.deliver_paid_reservation((select reservation_id from orders where label = 'pending'), 'handover-pending', gen_random_uuid())$$,
  'P0001', 'COMMERCIAL_RESERVATION_PAYMENT_PENDING', 'an order awaiting the online payment is not delivered');
create temp table delivered as select public.deliver_paid_reservation((select reservation_id from orders where label = 'paid'), 'handover-deliver', gen_random_uuid()) result;
grant select on delivered to authenticated;
select is((select result ->> 'status' from delivered), 'COMPLETED', 'the paid order is handed over');
select is(public.deliver_paid_reservation((select reservation_id from orders where label = 'paid'), 'handover-deliver', gen_random_uuid()),
  (select result from delivered), 'a double tap returns the same delivery');
select throws_ok($$select public.deliver_paid_reservation((select reservation_id from orders where label = 'paid'), 'handover-deliver-again', gen_random_uuid())$$,
  'P0001', 'COMMERCIAL_RESERVATION_ALREADY_DELIVERED', 'an order is delivered once');
select ok(not exists (select 1 from jsonb_array_elements(public.list_pickup_reservations(null, 50)) item
  where item ->> 'reservation_id' = (select reservation_id::text from orders where label = 'paid')), 'a delivered order leaves the pickup list');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.deliver_paid_reservation((select reservation_id from orders where label = 'pending'), 'handover-seller', gen_random_uuid())$$,
  'P0001', 'COMMERCIAL_RESERVATION_NOT_FOUND', 'a seller does not hand over orders held at the central stock');
reset role;

select is((select status::text || ':' || completed_by::text from public.commercial_reservations where id = (select reservation_id from orders where label = 'paid')),
  'COMPLETED:10000000-0000-4000-8000-000000000001', 'the reservation records who handed it over');
select is((select count(*) from public.sales where customer_id = '10000000-0000-4000-8000-000000000003'), (select sales from before_handover), 'no second sale is created');
select is((select count(*) from public.stock_movements where source_type = 'sale' and source_id = (select sale_id::text from before_handover)), (select movements from before_handover), 'stock is not moved again');
select is((select count(*) from public.financial_ledger_entries where sale_id = (select sale_id from before_handover)), (select entries from before_handover), 'finance is not posted again');
select is((select count(*)::integer from public.outbox_events where topic = 'reservations.completed' and payload ->> 'paid_online' = 'true'
  and aggregate_id = (select reservation_id::text from orders where label = 'paid')), 1, 'the customer is told once that the order was delivered');

select * from finish();
rollback;
