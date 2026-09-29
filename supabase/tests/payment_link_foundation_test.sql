-- ADR 0010, PAY-004 and PAY-007: Payment Link intents, worker creation, webhook receipts applied exactly once and
-- recovery for everything that must not become revenue.
begin;
select plan(59);

select has_table('public', 'payment_link_charges', 'payment link intents exist');
select has_table('public', 'payment_webhook_receipts', 'webhook receipts exist');
select ok(not has_function_privilege('authenticated', 'public.worker_record_payment_link_event(public.payment_confirmation_source,text,jsonb)', 'EXECUTE'), 'users cannot inject provider events');
select ok(not has_function_privilege('anon', 'public.worker_claim_payment_link_requests(text,integer,integer)', 'EXECUTE'), 'anonymous cannot claim link requests');
select ok(not has_table_privilege('authenticated', 'public.payment_webhook_receipts', 'SELECT'), 'receipts are not readable directly');
select is((select enabled from public.feature_flags where key = 'payment_link'), false, 'the Payment Link flag starts off');

insert into public.inventory_balances(location_id, product_id)
values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',12,'Estoque link de pagamento','link-stock','6b000000-0000-4000-8000-000000000001')$$, 'admin prepares seller stock');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table link_sales(label text primary key, sale_id uuid);
grant select on link_sales to authenticated, service_role;
insert into link_sales select label, (public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'link-sale-'||label,gen_random_uuid())->>'sale_id')::uuid
from unnest(array['a','b','c','d','e','f','g','h']) label;
select throws_ok($$select public.request_payment_link((select sale_id from link_sales where label='a'),'link-req-off',gen_random_uuid())$$, 'P0001', 'FEATURE_DISABLED', 'links wait for the flag');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.update_feature_flag('payment_link', true, 'Teste do link de pagamento', gen_random_uuid())$$, 'admin turns the flag on');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table link_requests(label text primary key, result jsonb);
grant select on link_requests to authenticated, service_role;
insert into link_requests select label, public.request_payment_link(sale_id, 'link-req-'||label, gen_random_uuid()) from link_sales;
select is((select result->>'status' from link_requests where label='a'), 'REQUESTED', 'the intent is persisted before the provider');
select ok((select result->>'order_number' ~ '^G[0-9A-F]{14}$' from link_requests where label='a'), 'order number fits the provider limit');
select is((select (result->>'amount_cents')::bigint from link_requests where label='a'), (select total_cents from public.sales where id=(select sale_id from link_sales where label='a')), 'the link carries the server total');
select is(public.request_payment_link((select sale_id from link_sales where label='a'),'link-req-a',gen_random_uuid()), (select result from link_requests where label='a'), 'replaying the request returns the same intent');
select is(public.request_payment_link((select sale_id from link_sales where label='a'),'link-req-a-again',gen_random_uuid())->>'charge_id', (select result->>'charge_id' from link_requests where label='a'), 'one open link per payment attempt');
select is(public.get_payment_link_charge((select (result->>'charge_id')::uuid from link_requests where label='a'))->>'status', 'REQUESTED', 'the seller follows the link status');

reset role;
create temp table link_events(label text primary key, payload jsonb);
grant select on link_events to service_role;
insert into link_events values
  ('pay-a', '{"type":"PAYMENT","eventDate":"2026-09-29T12:00:00Z","data":{"transaction":{"originalTransactionId":null,"status":"PAYED","id":"tx-aaaa-0001","amount":2590,"paymentType":"PIX"},"charge":{"paymentLinkId":"link-aaaa-0001","amount":2590}}}'),
  ('pay-a-second', '{"type":"PAYMENT","data":{"transaction":{"status":"PAYED","id":"tx-aaaa-0002","amount":2590,"paymentType":"WALLET"},"charge":{"paymentLinkId":"link-aaaa-0001","amount":2590}}}'),
  ('pay-b-short', '{"type":"PAYMENT","data":{"transaction":{"status":"PAYED","id":"tx-bbbb-0001","amount":100,"paymentType":"PIX"},"charge":{"paymentLinkId":"link-bbbb-0001","amount":2590}}}'),
  ('pay-c-early', '{"type":"PAYMENT","data":{"transaction":{"status":"PAYED","id":"tx-cccc-0001","amount":2590,"paymentType":"CREDIT_CARD"},"charge":{"paymentLinkId":"link-cccc-0001","amount":2590}}}'),
  ('pay-d', '{"type":"PAYMENT","data":{"transaction":{"status":"PAYED","id":"tx-dddd-0001","amount":2590,"paymentType":"PIX"},"charge":{"paymentLinkId":"link-dddd-0001","amount":2590}}}'),
  ('pay-h-late', '{"type":"PAYMENT","data":{"transaction":{"status":"PAYED","id":"tx-hhhh-0001","amount":2590,"paymentType":"PIX"},"charge":{"paymentLinkId":"link-hhhh-0001","amount":2590}}}'),
  ('refund-a', '{"type":"REFUND","data":{"transaction":{"originalTransactionId":"tx-aaaa-0001","status":"REFUNDED","id":"tx-aaaa-r001","amount":2590,"paymentType":"PIX"},"charge":{"paymentLinkId":"link-aaaa-0001","amount":2590}}}'),
  ('garbage', '{"hello":"world"}');

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table link_claims as select public.worker_claim_payment_link_requests('worker-1', 10, 120) claims;
select is(jsonb_array_length((select claims from link_claims)), 8, 'the worker claims every requested link');
select is(jsonb_array_length(public.worker_claim_payment_link_requests('worker-2', 10, 120)), 0, 'claimed requests are not handed out twice');
select ok((select claims->0->>'expires_on' ~ '^\d{4}-\d{2}-\d{2}$' from link_claims), 'the claim carries the provider expiry date');
select throws_ok($$select public.worker_record_payment_link_created((select (result->>'charge_id')::uuid from link_requests where label='a'),'worker-2','link-aaaa-0001','https://link.picpay.com/p/link-aaaa-0001',null,null)$$, 'P0001', 'PAYMENT_LINK_CLAIM_MISMATCH', 'only the claiming worker records the result');
select is(public.worker_record_payment_link_created((select (result->>'charge_id')::uuid from link_requests where label='a'),'worker-1','link-aaaa-0001','https://link.picpay.com/p/link-aaaa-0001','000201-brcode',null)->>'status', 'ACTIVE', 'the created link becomes active');
select lives_ok($$select public.worker_record_payment_link_created((select (result->>'charge_id')::uuid from link_requests where label='b'),'worker-1','link-bbbb-0001','https://link.picpay.com/p/link-bbbb-0001',null,null)$$, 'second link recorded');
select lives_ok($$select public.worker_record_payment_link_created((select (result->>'charge_id')::uuid from link_requests where label='d'),'worker-1','link-dddd-0001','https://link.picpay.com/p/link-dddd-0001',null,null)$$, 'fourth link recorded');
select lives_ok($$select public.worker_record_payment_link_created((select (result->>'charge_id')::uuid from link_requests where label='h'),'worker-1','link-hhhh-0001','https://link.picpay.com/p/link-hhhh-0001',null,null)$$, 'late link recorded');

-- A payment confirms the sale once.
create temp table pay_a as select public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from link_events where label='pay-a')) result;
grant select on pay_a to authenticated;
select is((select result->>'outcome' from pay_a), 'APPLIED', 'an authenticated payment is applied');
select is((public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from link_events where label='pay-a'))->>'duplicate')::boolean, true, 'a repeated delivery is recognized');
select is(public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from link_events where label='pay-a-second'))->>'outcome', 'RECOVERY_OPENED', 'a second payment on the same link is not revenue');
select is(public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from link_events where label='pay-b-short'))->>'outcome', 'RECOVERY_OPENED', 'a divergent amount is not revenue');
create temp table pay_c as select public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from link_events where label='pay-c-early')) result;
select is((select result->>'outcome' from pay_c), 'RECOVERY_OPENED', 'a notice for an unregistered link waits in recovery');
select lives_ok($$select public.worker_record_payment_link_created((select (result->>'charge_id')::uuid from link_requests where label='c'),'worker-1','link-cccc-0001','https://link.picpay.com/p/link-cccc-0001',null,null)$$, 'the early link is registered afterwards');
select lives_ok($$select public.worker_record_payment_link_failure((select (result->>'charge_id')::uuid from link_requests where label='e'),'worker-1',true,'PROVIDER_TIMEOUT')$$, 'a timeout is recorded as uncertain');
select lives_ok($$select public.worker_record_payment_link_failure((select (result->>'charge_id')::uuid from link_requests where label='f'),'worker-1',false,'PROVIDER_REJECTED')$$, 'a rejection is recorded as failed');
reset role;

select is((select status::text from public.sales where id=(select sale_id from link_sales where label='a')), 'CONFIRMED', 'the paid sale is confirmed');
select is((select status::text||':'||integration_channel::text||':'||confirmation_source::text from public.payment_attempts where sale_id=(select sale_id from link_sales where label='a')), 'APPROVED:PAYMENT_LINK:WEBHOOK', 'the attempt names the channel and the webhook source');
select is((select count(*)::int from public.financial_ledger_entries where sale_id=(select sale_id from link_sales where label='a') and entry_type='RECEIVABLE_PICPAY'), 1, 'exactly one receivable');
select is((select count(*)::int from public.payment_webhook_receipts where transaction_id='tx-aaaa-0001'), 1, 'one receipt per transaction and status');
select is((select count(*)::int from public.payment_webhook_deliveries d join public.payment_webhook_receipts r on r.id=d.receipt_id where r.transaction_id='tx-aaaa-0001'), 2, 'every delivery is kept');
select is((select status::text from public.payment_link_charges where provider_link_id='link-aaaa-0001'), 'PAID', 'the link is paid');
select is((select status::text from public.sales where id=(select sale_id from link_sales where label='b')), 'AWAITING_PAYMENT', 'the divergent payment leaves the sale pending');
select is((select status::text from public.sales where id=(select sale_id from link_sales where label='c')), 'CONFIRMED', 'the early notice is applied once the link is known');
select is((select status from public.payment_recovery_items where kind='UNKNOWN_LINK' and transaction_id='tx-cccc-0001'), 'RESOLVED', 'its recovery item closes by itself');
select is((select status::text from public.payment_link_charges where attempt_id=(select id from public.payment_attempts where sale_id=(select sale_id from link_sales where label='e'))), 'UNCERTAIN', 'the uncertain link is never recreated blindly');
select is((select count(*)::int from public.payment_recovery_items where kind='UNCERTAIN_CREATION'), 1, 'finance checks the uncertain link');

-- Paid elsewhere first, then by link; and paid after the sale expired.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select lives_ok($$select public.confirm_manual_payment((select sale_id from link_sales where label='d'),'PIX_AREA','PIX-LINK-0004',null,null,'link-manual-d',gen_random_uuid())$$, 'the seller confirms the sale by Área Pix');
select is(public.request_payment_link((select sale_id from link_sales where label='e'),'link-req-e-again',gen_random_uuid())->>'status', 'UNCERTAIN', 'an uncertain link blocks a second one');
select is(public.request_payment_link((select sale_id from link_sales where label='f'),'link-req-f-again',gen_random_uuid())->>'status', 'REQUESTED', 'a rejected link can be asked again');
reset role;
update public.stock_reservations set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
where origin_type = 'sale' and origin_id = (select sale_id::text from link_sales where label='h');
select private.expire_due_sales(10);
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select is(public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from link_events where label='pay-d'))->>'outcome', 'RECOVERY_OPENED', 'a link paid after another means is not revenue');
select is(public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from link_events where label='pay-h-late'))->>'outcome', 'RECOVERY_OPENED', 'a payment after expiry is not revenue');
select is(public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from link_events where label='refund-a'))->>'outcome', 'REFUND_RECORDED', 'a provider refund is recorded');
select is(public.worker_record_payment_link_event('WEBHOOK',null,(select payload from link_events where label='garbage'))->>'outcome', 'RECOVERY_OPENED', 'an unknown format is kept for review');
reset role;
select is((select string_agg(kind::text, ',' order by kind::text) from public.payment_recovery_items where status='OPEN'),
  'AMOUNT_MISMATCH,DUPLICATE_PAYMENT,DUPLICATE_PAYMENT,LATE_PAYMENT,REFUND_CONFIRMED,UNCERTAIN_CREATION,UNSUPPORTED_EVENT', 'each problem opens one recovery item');

-- Finance replays and resolves.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.replay_payment_webhook_receipt((select (result->>'receipt_id')::uuid from pay_a),'link-replay-seller',gen_random_uuid())$$, '42501', 'FINANCE_REQUIRED', 'sellers cannot replay receipts');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(public.replay_payment_webhook_receipt((select (result->>'receipt_id')::uuid from pay_a),'link-replay-a',gen_random_uuid())->>'outcome', 'ALREADY_APPLIED', 'replaying an applied receipt changes nothing');
select is(jsonb_array_length(public.list_payment_recovery_items('OPEN', 50)), 7, 'finance lists open recovery items');
select is(public.resolve_payment_recovery_item((select (item->>'id')::uuid from jsonb_array_elements(public.list_payment_recovery_items('OPEN', 50)) item where item->>'kind'='UNSUPPORTED_EVENT'),'Evento de teste descartado','link-resolve-1',gen_random_uuid())->>'status', 'RESOLVED', 'finance resolves an item with a note');
reset role;

select is((select count(*)::int from public.financial_ledger_entries where payment_attempt_id in (select attempt_id from public.payment_link_charges)), 3, 'only the applied payments produced receivables');

-- A worker that claimed a request and vanished may have created the link: it becomes uncertain, not retried.
update public.payment_link_charges set lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select (result->>'charge_id')::uuid from link_requests where label='g');
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select ok(not exists (select 1 from jsonb_array_elements(public.worker_claim_payment_link_requests('worker-3', 10, 120)) claim
  where claim->>'charge_id' = (select result->>'charge_id' from link_requests where label='g')), 'an expired claim is not handed out again');
reset role;
select is((select status::text||':'||coalesce(error_code, '') from public.payment_link_charges where id=(select (result->>'charge_id')::uuid from link_requests where label='g')), 'UNCERTAIN:WORKER_LEASE_EXPIRED', 'an expired claim becomes uncertain');
select throws_ok($$update public.payment_webhook_receipts set amount_cents = 1$$, 'P0001', 'PAYMENT_LINK_RECORD_IMMUTABLE', 'receipts are immutable');
select throws_ok($$delete from public.payment_link_charges$$, 'P0001', 'PAYMENT_LINK_RECORD_IMMUTABLE', 'intents are never deleted');

select * from finish();
rollback;
