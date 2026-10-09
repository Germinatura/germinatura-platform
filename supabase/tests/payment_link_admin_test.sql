-- ADR 0010: finance view of recent Payment Links and provider refunds.
begin;
select plan(6);

insert into public.inventory_balances(location_id, product_id)
values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',2,'Estoque visão financeira','admin-link-stock','6d000000-0000-4000-8000-000000000001');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000005'; -- ADR 0011: global flags belong to ADMIN_MASTER
select public.update_feature_flag('payment_link', true, 'Teste da visão financeira', gen_random_uuid());
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table admin_link as select public.request_payment_link(
  (public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'admin-link-sale',gen_random_uuid())->>'sale_id')::uuid,
  'admin-link-req', gen_random_uuid()) result;
grant select on admin_link to service_role, authenticated;
select throws_ok($$select public.list_payment_link_activity_admin(50)$$, '42501', 'FINANCE_REQUIRED', 'sellers cannot list online payments');
reset role;

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select public.worker_claim_payment_link_requests('worker-admin', 10, 120);
select public.worker_record_payment_link_created((select (result->>'charge_id')::uuid from admin_link), 'worker-admin', 'admin-link-0001', 'https://link.picpay.com/p/admin-link-0001', null, null);
select public.worker_record_payment_link_event('WEBHOOK', 'TransactionPaymentMessage',
  '{"type":"PAYMENT","data":{"transaction":{"status":"PAYED","id":"admin-tx-0001","amount":2590},"charge":{"paymentLinkId":"admin-link-0001"}}}'::jsonb);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.request_payment_link_refund('admin-tx-0001', 500, 'Troca parcial', null, 'admin-refund', gen_random_uuid())$$, 'finance asks for a partial refund');
create temp table admin_view as select public.list_payment_link_activity_admin(50) result;
select is((select item->>'status' from admin_view, jsonb_array_elements(result->'charges') item where item->>'charge_id' = (select result->>'charge_id' from admin_link)), 'PAID', 'finance sees the paid link');
select is((select item->>'paid_transaction_id' from admin_view, jsonb_array_elements(result->'charges') item where item->>'charge_id' = (select result->>'charge_id' from admin_link)), 'admin-tx-0001', 'the paid transaction can be refunded from the list');
select is((select (item->>'amount_cents')::int from admin_view, jsonb_array_elements(result->'refunds') item where item->>'transaction_id' = 'admin-tx-0001'), 500, 'finance sees the refund request');
select throws_ok($$select public.list_payment_link_activity_admin(0)$$, '22023', 'INVALID_FILTER', 'the limit is validated');
reset role;

select * from finish();
rollback;
