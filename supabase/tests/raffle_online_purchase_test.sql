-- Spec 4.4 (RAF-003): the consumer buys raffle numbers online with a Payment Link.
begin;
select plan(16);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table online_campaign as select public.create_raffle_campaign('Rifa online', '33f00000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', 20, now() - interval '1 minute', now() + interval '1 day', 'online-create', gen_random_uuid()) result;
grant select on online_campaign to authenticated, service_role;
select public.transition_raffle_campaign((select (result ->> 'campaign_id')::uuid from online_campaign), 'PUBLISH', 'online-publish', gen_random_uuid());

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
create temp table online_sale as select public.reserve_raffle_numbers((select (result ->> 'campaign_id')::uuid from online_campaign), array[5,6], 'online-reserve', gen_random_uuid()) result;
create temp table late_sale as select public.reserve_raffle_numbers((select (result ->> 'campaign_id')::uuid from online_campaign), array[9], 'online-reserve-late', gen_random_uuid()) result;
grant select on online_sale, late_sale to authenticated, service_role;
select throws_ok($$select public.request_customer_payment_link((select (result ->> 'sale_id')::uuid from online_sale), 'https://portal.example', 'online-link-off', gen_random_uuid())$$,
  'P0001', 'FEATURE_DISABLED', 'online payment waits for the flag');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.update_feature_flag('payment_link', true, 'Teste da rifa online', gen_random_uuid());
select throws_ok($$select public.request_customer_payment_link((select (result ->> 'sale_id')::uuid from online_sale), 'https://portal.example', 'online-link-other', gen_random_uuid())$$,
  'P0001', 'SALE_NOT_FOUND', 'nobody pays someone else''s numbers');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.request_customer_payment_link((select (result ->> 'sale_id')::uuid from online_sale), 'ftp://portal.example', 'online-link-bad', gen_random_uuid())$$,
  '22023', 'INVALID_PAYMENT_LINK_REQUEST', 'the return address is validated');
create temp table online_link as select public.request_customer_payment_link((select (result ->> 'sale_id')::uuid from online_sale), 'https://portal.example', 'online-link', gen_random_uuid()) result;
create temp table late_link as select public.request_customer_payment_link((select (result ->> 'sale_id')::uuid from late_sale), 'https://portal.example', 'online-link-late', gen_random_uuid()) result;
grant select on online_link, late_link to authenticated, service_role;
select is((select result ->> 'status' from online_link), 'REQUESTED', 'the buyer gets a requested link');
select is(public.request_customer_payment_link((select (result ->> 'sale_id')::uuid from online_sale), 'https://portal.example', 'online-link', gen_random_uuid()), (select result from online_link), 'the request is idempotent');
select is((select count(*)::integer from jsonb_array_elements(public.list_my_raffle_tickets()) item
  where item ->> 'sale_id' = (select result ->> 'sale_id' from online_sale) and item ->> 'open_payment_link_id' = (select result ->> 'charge_id' from online_link)), 1, 'my tickets point to the open payment');
reset role;
select ok((select min(expires_at) > clock_timestamp() + interval '29 minutes' from public.raffle_numbers where sale_id = (select (result ->> 'sale_id')::uuid from online_sale)), 'paying online extends the hold');

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table online_claims as select public.worker_claim_payment_link_requests('worker-raffle', 10, 120) result;
select is((select claim ->> 'redirect_url' from online_claims, jsonb_array_elements(result) claim where claim ->> 'charge_id' = (select result ->> 'charge_id' from online_link)),
  'https://portal.example/pedidos/pagamento/' || (select result ->> 'charge_id' from online_link), 'the worker receives the return page');
select public.worker_record_payment_link_created((select (result ->> 'charge_id')::uuid from online_link), 'worker-raffle', 'raffle-link-0001', 'https://link.picpay.com/p/raffle-link-0001', null, null);
select public.worker_record_payment_link_created((select (result ->> 'charge_id')::uuid from late_link), 'worker-raffle', 'raffle-link-0002', 'https://link.picpay.com/p/raffle-link-0002', null, null);
select is(public.worker_record_payment_link_event('WEBHOOK', 'TransactionPaymentMessage', jsonb_build_object('type', 'PAYMENT', 'data', jsonb_build_object(
  'transaction', jsonb_build_object('id', 'raffle-tx-0001', 'status', 'PAYED', 'amount', (select (result ->> 'amount_cents')::int from online_link)),
  'charge', jsonb_build_object('paymentLinkId', 'raffle-link-0001')))) ->> 'outcome', 'APPLIED', 'PicPay confirms the raffle payment');
reset role;

select is((select status::text from public.sales where id = (select (result ->> 'sale_id')::uuid from online_sale)), 'CONFIRMED', 'the raffle sale is confirmed');
select is((select string_agg(status::text, ',' order by number) from public.raffle_numbers where sale_id = (select (result ->> 'sale_id')::uuid from online_sale)), 'PAID,PAID', 'the numbers become paid');
select is((select count(*)::integer from public.financial_ledger_entries where sale_id = (select (result ->> 'sale_id')::uuid from online_sale) and entry_type = 'RECEIVABLE_PICPAY'), 1, 'the raffle revenue is recorded once');
select is((select count(*)::integer from public.stock_movements where source_type = 'sale' and source_id = (select result ->> 'sale_id' from online_sale)), 0, 'raffle tickets move no stock');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((select item -> 'payment' ->> 'confirmation_source' from jsonb_array_elements(public.list_my_raffle_tickets()) item
  where item ->> 'sale_id' = (select result ->> 'sale_id' from online_sale)), 'WEBHOOK', 'my tickets show how the payment was confirmed');
reset role;

-- A payment that arrives after the hold expired never becomes revenue.
update public.raffle_numbers set expires_at = clock_timestamp() - interval '1 second' where sale_id = (select (result ->> 'sale_id')::uuid from late_sale);
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select is(public.worker_record_payment_link_event('WEBHOOK', 'TransactionPaymentMessage', jsonb_build_object('type', 'PAYMENT', 'data', jsonb_build_object(
  'transaction', jsonb_build_object('id', 'raffle-tx-0002', 'status', 'PAYED', 'amount', (select (result ->> 'amount_cents')::int from late_link)),
  'charge', jsonb_build_object('paymentLinkId', 'raffle-link-0002')))) ->> 'outcome', 'RECOVERY_OPENED', 'a payment after the hold expired goes to recovery');
reset role;
select is((select status::text from public.sales where id = (select (result ->> 'sale_id')::uuid from late_sale)), 'AWAITING_PAYMENT', 'the late sale is not confirmed');

select * from finish();
rollback;
