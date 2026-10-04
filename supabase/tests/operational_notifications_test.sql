-- Spec 5.15 (COMM-002): automatic operational notifications reach the people who must act.
begin;
select plan(12);

-- A reservation of the consumer to reference from the reservation events.
insert into public.inventory_balances (location_id, product_id) values
  ('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001',1,'Avisos','notify-stock',gen_random_uuid())$$,'admin prepares central stock');
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
create temp table res as select (public.create_commercial_reservation('50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'notify-res',gen_random_uuid())->>'reservation_id')::uuid as id;
reset role;

-- A transfer request asked from a location owned by the admin to the seller.
insert into public.stock_locations (id, location_type, name, seller_id)
values ('50000000-0000-4000-8000-0000000000a1', 'SELLER', 'Mochila do administrador', '10000000-0000-4000-8000-000000000001');
insert into public.seller_stock_transfer_requests (id, from_location_id, to_location_id, product_id, quantity, requested_by, request_reason, correlation_id)
values ('75000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-000000000002',
  '33f00000-0000-4000-8000-000000000001', 1, '10000000-0000-4000-8000-000000000002', 'Preciso repor o estoque', gen_random_uuid());

insert into public.outbox_events (id, topic, aggregate_type, aggregate_id, payload) values
  ('95000000-0000-4000-8000-000000000001', 'reservations.ready', 'commercial_reservation', (select id::text from res), jsonb_build_object('pickup_deadline', '2026-10-01T18:30:00Z')),
  ('95000000-0000-4000-8000-000000000002', 'reservations.completed', 'commercial_reservation', (select id::text from res), '{}'),
  ('95000000-0000-4000-8000-000000000003', 'inventory.loss.reported', 'stock_loss_report', gen_random_uuid()::text, '{"status":"PENDING_APPROVAL"}'),
  ('95000000-0000-4000-8000-000000000004', 'inventory.loss.reported', 'stock_loss_report', gen_random_uuid()::text, '{"status":"APPLIED"}'),
  ('95000000-0000-4000-8000-000000000005', 'finance.payment.reconciled', 'payment_reconciliation', gen_random_uuid()::text, '{"outcome":"DIVERGENT"}'),
  ('95000000-0000-4000-8000-000000000006', 'finance.payment.reconciled', 'payment_reconciliation', gen_random_uuid()::text, '{"outcome":"MATCHED"}'),
  ('95000000-0000-4000-8000-000000000007', 'closeouts.created', 'seller_closeout', gen_random_uuid()::text, '{"seller_id":"10000000-0000-4000-8000-000000000002"}'),
  ('95000000-0000-4000-8000-000000000008', 'inventory.seller_transfer.requested', 'seller_stock_transfer_request', '75000000-0000-4000-8000-000000000001', '{}'),
  ('95000000-0000-4000-8000-000000000009', 'inventory.return.requested', 'stock_return_request', gen_random_uuid()::text, '{}');

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table claimed as select * from public.worker_claim_outbox_events('worker-operational', 100, 300);
select lives_ok($$select public.worker_process_outbox_event(id, 'worker-operational') from claimed where id::text like '95000000-%'$$,'the worker processes the operational events');
reset role;

create temp table sent as select notification.*, event.id as event_id from public.notifications notification
join public.outbox_events event on event.id = notification.source_event_id where event.id::text like '95000000-%';

select is((select recipient_id::text||':'||kind from sent where event_id='95000000-0000-4000-8000-000000000001'),'10000000-0000-4000-8000-000000000003:RESERVATION_READY','the customer learns the reservation is ready');
select is((select body from sent where event_id='95000000-0000-4000-8000-000000000001'),'Sua reserva foi separada. Retire até 01/10 às 15:30 (horário de Brasília).','the pickup deadline is shown in São Paulo time');
select is((select kind from sent where event_id='95000000-0000-4000-8000-000000000002'),'RESERVATION_COMPLETED','the customer learns the reservation was delivered');
select is((select array_agg(recipient_id::text) from sent where event_id='95000000-0000-4000-8000-000000000003'),array['10000000-0000-4000-8000-000000000001'],'a pending loss reaches the stock managers only');
select is((select count(*)::integer from sent where event_id='95000000-0000-4000-8000-000000000004'),0,'an applied loss needs no action');
select is((select kind from sent where event_id='95000000-0000-4000-8000-000000000005'),'SALE_DIVERGENT','a divergent reconciliation reaches finance');
select is((select count(*)::integer from sent where event_id='95000000-0000-4000-8000-000000000006'),0,'a matched reconciliation stays silent');
select is((select kind from sent where event_id='95000000-0000-4000-8000-000000000007'),'CLOSEOUT_PENDING','a closeout reaches whoever reviews it');
select is((select recipient_id::text||':'||kind from sent where event_id='95000000-0000-4000-8000-000000000008'),'10000000-0000-4000-8000-000000000001:TRANSFER_PENDING','the source seller is asked about the transfer');
select is((select kind from sent where event_id='95000000-0000-4000-8000-000000000009'),'RETURN_PENDING','a return reaches the stock team');

select * from finish();
rollback;
