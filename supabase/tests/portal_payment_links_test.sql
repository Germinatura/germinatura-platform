-- ADR 0010 and PAY-004: the consumer pays an active reservation online with a Payment Link.
begin;
select plan(14);

select ok(not has_function_privilege('anon', 'public.request_portal_payment_link(uuid,text,text,uuid)', 'EXECUTE'), 'anonymous cannot ask for a link');

insert into public.inventory_balances(location_id, product_id)
values ('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000001','33f00000-0000-4000-8000-000000000001',3,'Estoque link do Portal','portal-link-stock','6e000000-0000-4000-8000-000000000001')$$, 'admin prepares central stock');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
create temp table portal_reservations(label text primary key, reservation_id uuid);
grant select on portal_reservations to authenticated, service_role;
insert into portal_reservations select label, (public.create_commercial_reservation('50000000-0000-4000-8000-000000000001',
  '[{"quantity":1,"product_id":"33f00000-0000-4000-8000-000000000001"}]'::jsonb, 'portal-link-res-'||label, gen_random_uuid())->>'reservation_id')::uuid
from unnest(array['a','b']) label;
select throws_ok($$select public.request_portal_payment_link((select reservation_id from portal_reservations where label='a'),'https://portal.example','portal-link-off',gen_random_uuid())$$, 'P0001', 'FEATURE_DISABLED', 'online payment waits for the flag');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000005'; -- ADR 0011: global flags belong to ADMIN_MASTER
select lives_ok($$select public.update_feature_flag('payment_link', true, 'Teste do link no Portal', gen_random_uuid())$$, 'admin turns the flag on');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.request_portal_payment_link((select reservation_id from portal_reservations where label='a'),'javascript:alert(1)','portal-link-bad',gen_random_uuid())$$, '22023', 'INVALID_PAYMENT_LINK_REQUEST', 'the return address is validated');
create temp table portal_link as select public.request_portal_payment_link((select reservation_id from portal_reservations where label='a'),'https://portal.example','portal-link-a',gen_random_uuid()) result;
grant select on portal_link to authenticated, service_role;
select is((select result->>'status' from portal_link), 'REQUESTED', 'the consumer gets a requested link');
select is((select status::text from public.commercial_reservations where id=(select reservation_id from portal_reservations where label='a')), 'CONVERTED', 'the reservation became a sale awaiting payment');
select is(public.request_portal_payment_link((select reservation_id from portal_reservations where label='a'),'https://portal.example','portal-link-a-again',gen_random_uuid())->>'charge_id', (select result->>'charge_id' from portal_link), 'asking again returns the same link');
select is(public.get_payment_link_charge((select (result->>'charge_id')::uuid from portal_link))->>'status', 'REQUESTED', 'the consumer follows the link');
select lives_ok($$select public.cancel_commercial_reservation((select reservation_id from portal_reservations where label='b'),'portal-link-cancel-b',gen_random_uuid())$$, 'the consumer cancels another reservation');
select throws_ok($$select public.request_portal_payment_link((select reservation_id from portal_reservations where label='b'),'https://portal.example','portal-link-b',gen_random_uuid())$$, 'P0001', 'COMMERCIAL_RESERVATION_NOT_PAYABLE', 'a cancelled reservation cannot be paid');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.request_portal_payment_link((select reservation_id from portal_reservations where label='a'),'https://portal.example','portal-link-other',gen_random_uuid())$$, 'P0001', 'COMMERCIAL_RESERVATION_NOT_FOUND', 'nobody pays someone else''s reservation');
reset role;

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select is((select claim->>'redirect_url' from jsonb_array_elements(public.worker_claim_payment_link_requests('worker-portal', 10, 120)) claim
  where claim->>'charge_id' = (select result->>'charge_id' from portal_link)),
  'https://portal.example/pedidos/pagamento/' || (select result->>'charge_id' from portal_link), 'the worker receives the return page');
select public.worker_record_payment_link_created((select (result->>'charge_id')::uuid from portal_link), 'worker-portal', 'portal-link-0001', 'https://link.picpay.com/p/portal-link-0001', null, null);
select is(public.worker_record_payment_link_event('WEBHOOK', 'TransactionPaymentMessage',
  jsonb_build_object('type', 'PAYMENT', 'data', jsonb_build_object('transaction', jsonb_build_object('id', 'portal-tx-0001', 'status', 'PAYED',
    'amount', (select (result->>'amount_cents')::int from portal_link)), 'charge', jsonb_build_object('paymentLinkId', 'portal-link-0001'))))->>'outcome',
  'APPLIED', 'PicPay confirms the online payment');
reset role;

select * from finish();
rollback;
