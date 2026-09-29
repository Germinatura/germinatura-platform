-- ADR 0010, PAY-004 and PAY-007: Payment Link lifecycle — inactivation, status polling, provider refunds and
-- reconciliation of uncertain operations.
begin;
select plan(61);

select ok(not has_function_privilege('authenticated', 'public.worker_claim_payment_link_refunds(text,integer,integer)', 'EXECUTE'), 'users cannot submit refunds');
select ok(not has_table_privilege('authenticated', 'public.payment_link_refund_requests', 'SELECT'), 'refund requests are not readable directly');

insert into public.inventory_balances(location_id, product_id)
values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',12,'Estoque ciclo do link','life-stock','6c000000-0000-4000-8000-000000000001')$$, 'admin prepares seller stock');
select lives_ok($$select public.update_feature_flag('payment_link', true, 'Teste do ciclo do link', gen_random_uuid())$$, 'admin turns the flag on');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table life_sales(label text primary key, sale_id uuid);
grant select on life_sales to authenticated, service_role;
insert into life_sales select label, (public.checkout_sale('PDV','50000000-0000-4000-8000-000000000002','[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,'life-sale-'||label,gen_random_uuid())->>'sale_id')::uuid
from unnest(array['a','b','c','d','e','f','g','h','i']) label;
create temp table life_links(label text primary key, charge_id uuid);
grant select on life_links to authenticated, service_role;
insert into life_links select label, (public.request_payment_link(sale_id,'life-req-'||label,gen_random_uuid())->>'charge_id')::uuid
from life_sales where label <> 'e';

reset role;
create temp table life_events(label text primary key, payload jsonb);
grant select on life_events to service_role;
insert into life_events values
  ('pay-a', '{"type":"PAYMENT","data":{"transaction":{"status":"PAYED","id":"life-tx-a-01","amount":2590,"paymentType":"PIX"},"charge":{"paymentLinkId":"life-link-a"}}}'),
  ('refund-a', '{"type":"REFUND","data":{"transaction":{"originalTransactionId":"life-tx-a-01","status":"REFUNDED","id":"life-tx-a-r1","amount":2590,"paymentType":"PIX"},"charge":{"paymentLinkId":"life-link-a"}}}'),
  ('pay-f-1', '{"type":"PAYMENT","data":{"transaction":{"status":"PAYED","id":"life-tx-f-01","amount":2590},"charge":{"paymentLinkId":"life-link-f"}}}'),
  ('pay-f-2', '{"type":"PAYMENT","data":{"transaction":{"status":"PAYED","id":"life-tx-f-02","amount":2590,"paymentType":"PIX"},"charge":{"paymentLinkId":"life-link-f"}}}'),
  ('refund-f-2', '{"type":"REFUND","data":{"transaction":{"status":"REFUNDED","id":"life-tx-f-r2","amount":2590},"charge":{"paymentLinkId":"life-link-f"}}}'),
  ('pay-g', '{"type":"PAYMENT","data":{"transaction":{"status":"PAYED","id":"life-tx-g-01","amount":2590,"paymentType":"PIX"},"charge":{"paymentLinkId":"life-link-g"}}}');

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select is(jsonb_array_length(public.worker_claim_payment_link_requests('worker-1', 10, 120)), 8, 'the worker claims the requested links');
select lives_ok($$select public.worker_record_payment_link_created(charge_id,'worker-1','life-link-'||label,'https://link.picpay.com/p/life-link-'||label,null,null) from life_links where label in ('a','b','c','d','f','i')$$, 'six links are created');
select lives_ok($$select public.worker_record_payment_link_failure((select charge_id from life_links where label='g'),'worker-1',true,'PROVIDER_TIMEOUT')$$, 'a creation times out');
select lives_ok($$select public.worker_record_payment_link_failure((select charge_id from life_links where label='h'),'worker-1',true,'PROVIDER_TIMEOUT')$$, 'another creation times out');
reset role;

-- A request that the worker never took fails when its sale closes.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table life_e as select public.request_payment_link((select sale_id from life_sales where label='e'),'life-req-e',gen_random_uuid()) result;
reset role;
update public.stock_reservations set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
where origin_type = 'sale' and origin_id in (select sale_id::text from life_sales where label in ('b','e'));
select is(private.expire_due_sales(10), 2, 'two sales expire');
select is((select status::text||':'||error_code from public.payment_link_charges where id=(select (result->>'charge_id')::uuid from life_e)), 'FAILED:SALE_CLOSED', 'an unclaimed request fails when the sale closes');
select ok((select inactivation_requested_at is not null from public.payment_link_charges where id=(select charge_id from life_links where label='b')), 'the active link of an expired sale is marked for inactivation');

-- Paid elsewhere and cancelled sales close their links too.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select lives_ok($$select public.confirm_manual_payment((select sale_id from life_sales where label='c'),'PIX_AREA','PIX-LIFE-0003',null,null,'life-manual-c',gen_random_uuid())$$, 'sale c is paid by Área Pix');
select lives_ok($$select public.confirm_manual_payment((select sale_id from life_sales where label='d'),'PIX_AREA','PIX-LIFE-0004',null,null,'life-manual-d',gen_random_uuid())$$, 'sale d is paid by Área Pix');
reset role;
select ok((select bool_and(inactivation_requested_at is not null) from public.payment_link_charges where id in (select charge_id from life_links where label in ('c','d'))), 'links of sales paid by another means are marked for inactivation');

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
-- The webhook pays sale a; its link is inactivated afterwards so it cannot take a second payment.
select is(public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from life_events where label='pay-a'))->>'outcome', 'APPLIED', 'sale a is paid by link');
create temp table life_inactivations as select public.worker_claim_payment_link_inactivations('worker-1', 10, 120) claims;
select is((select jsonb_array_length(claims) from life_inactivations), 4, 'the worker claims every link to inactivate');
select is(jsonb_array_length(public.worker_claim_payment_link_inactivations('worker-2', 10, 120)), 0, 'claimed inactivations are not handed out twice');
select lives_ok($$select public.worker_record_payment_link_inactivation(charge_id,'worker-1',null) from life_links where label in ('a','b','c')$$, 'three inactivations succeed');
select throws_ok($$select public.worker_record_payment_link_inactivation((select charge_id from life_links where label='a'),'worker-1',null)$$, 'P0001', 'PAYMENT_LINK_CLAIM_MISMATCH', 'an inactivation is recorded once');
select lives_ok($$select public.worker_record_payment_link_inactivation((select charge_id from life_links where label='d'),'worker-1','PICPAY_C003')$$, 'an inactivation fails');
do $$
begin
  for i in 1..7 loop
    perform public.worker_claim_payment_link_inactivations('worker-1', 10, 120);
    perform public.worker_record_payment_link_inactivation((select charge_id from life_links where label='d'), 'worker-1', 'PICPAY_C003');
  end loop;
end;
$$;
reset role;
select is((select status::text||':'||(inactivated_at is not null)::text from public.payment_link_charges where id=(select charge_id from life_links where label='a')), 'PAID:true', 'a paid link stays paid and is inactivated');
select is((select string_agg(status::text, ',' order by label) from public.payment_link_charges c join life_links l on l.charge_id=c.id where label in ('b','c')), 'INACTIVE,INACTIVE', 'expired and paid-elsewhere links become inactive');
select is((select count(*)::int from public.payment_recovery_items where kind='INACTIVATION_FAILED' and charge_id=(select charge_id from life_links where label='d')), 1, 'persistent inactivation failure goes to finance');
select is((select status::text from public.sales where id=(select sale_id from life_sales where label='b')), 'CANCELLED', 'the expired sale stays cancelled');
select is((select count(*)::int from public.financial_ledger_entries where sale_id=(select sale_id from life_sales where label='b')), 0, 'the expired sale has no financial effect');

-- Polling recovers a lost notice through the same exactly-once path as the webhook.
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table life_checks as select public.worker_claim_payment_link_status_checks('worker-1', 50) claims;
select ok((select claims @> jsonb_build_array(jsonb_build_object('charge_id', (select charge_id from life_links where label='f'), 'provider_link_id', 'life-link-f')) from life_checks), 'open links are polled');
select ok(not (public.worker_claim_payment_link_status_checks('worker-1', 50) @> jsonb_build_array(jsonb_build_object('provider_link_id', 'life-link-f'))), 'a link just polled waits for the next window');
select is(public.worker_record_payment_link_event('STATUS_QUERY',null,(select payload from life_events where label='pay-f-1'))->>'outcome', 'APPLIED', 'a payment found by polling confirms the sale');
select is((public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from life_events where label='pay-f-1'))->>'duplicate')::boolean, true, 'the late webhook of the same payment is a duplicate');
create temp table life_dup as select public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from life_events where label='pay-f-2')) result;
grant select on life_dup to authenticated;
select is((select result->>'outcome' from life_dup), 'RECOVERY_OPENED', 'a second payment on the same link goes to recovery');
reset role;
select is((select confirmation_source::text from public.payment_attempts where sale_id=(select sale_id from life_sales where label='f')), 'STATUS_QUERY', 'the confirmation names the official query');
select is((select count(*)::int from public.financial_ledger_entries where sale_id=(select sale_id from life_sales where label='f') and entry_type='RECEIVABLE_PICPAY'), 1, 'polling plus webhook make one receivable');

-- Refunds through the provider.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.request_payment_link_refund('life-tx-a-01',2590,'Cliente desistiu',null,'life-refund-seller',gen_random_uuid())$$, '42501', 'FINANCE_REQUIRED', 'sellers cannot refund');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.request_payment_link_refund('life-tx-unknown',100,'Teste',null,'life-refund-unknown',gen_random_uuid())$$, 'P0001', 'PAYMENT_TRANSACTION_NOT_FOUND', 'only reported payments are refunded');
select throws_ok($$select public.request_payment_link_refund('life-tx-a-01',2591,'Cliente desistiu',null,'life-refund-too-much',gen_random_uuid())$$, 'P0001', 'REFUND_EXCEEDS_PAYMENT', 'a refund never exceeds the payment');
create temp table life_refund_a as select public.request_payment_link_refund('life-tx-a-01',2590,'Cliente desistiu',null,'life-refund-a',gen_random_uuid()) result;
grant select on life_refund_a to service_role;
select is((select result->>'status' from life_refund_a), 'REQUESTED', 'finance asks for the refund');
select is(public.request_payment_link_refund('life-tx-a-01',2590,'Cliente desistiu',null,'life-refund-a',gen_random_uuid()), (select result from life_refund_a), 'replaying the refund request returns the same request');
select throws_ok($$select public.request_payment_link_refund('life-tx-a-01',100,'Outro pedido',null,'life-refund-a-2',gen_random_uuid())$$, 'P0001', 'REFUND_EXCEEDS_PAYMENT', 'the requested amount is already committed');
create temp table life_refund_f as select public.request_payment_link_refund('life-tx-f-02',2590,'Pagamento em dobro',(select (result->>'recovery_item_id')::uuid from life_dup),'life-refund-f',gen_random_uuid()) result;
grant select on life_refund_f to service_role;
reset role;

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select is(jsonb_array_length(public.worker_claim_payment_link_refunds('worker-1', 10, 120)), 2, 'the worker takes both refunds');
select lives_ok($$select public.worker_record_payment_link_refund((select (result->>'refund_id')::uuid from life_refund_a),'worker-1','ACCEPTED','life-tx-a-r1',2590,null)$$, 'the provider accepts the first refund');
select lives_ok($$select public.worker_record_payment_link_refund((select (result->>'refund_id')::uuid from life_refund_f),'worker-1','UNCERTAIN',null,null,'PROVIDER_NO_RESPONSE')$$, 'the second refund times out');
select is(jsonb_array_length(public.worker_claim_payment_link_refunds('worker-1', 10, 120)), 0, 'an uncertain refund is never resubmitted');
select is(public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from life_events where label='refund-a'))->>'outcome', 'REFUND_RECORDED', 'the provider confirms the first refund');
reset role;
select is((select status::text from public.payment_link_refund_requests where id=(select (result->>'refund_id')::uuid from life_refund_a)), 'CONFIRMED', 'the refund is confirmed only by the provider event');
select is((select count(*)::int from public.payment_recovery_items where kind='REFUND_CONFIRMED' and sale_id=(select sale_id from life_sales where label='a') and status='OPEN'), 1, 'refunding the paying transaction asks finance for the sale reversal');
select is((select count(*)::int from public.payment_recovery_items where kind='REFUND_UNCERTAIN' and status='OPEN'), 1, 'the uncertain refund goes to finance');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(public.reconcile_uncertain_payment_link_refund((select (result->>'refund_id')::uuid from life_refund_f),true,'Estorno visto no painel PicPay','life-refund-f-seen',gen_random_uuid())->>'status', 'ACCEPTED', 'finance saw the refund in the panel');
reset role;
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select is(public.worker_record_payment_link_event('STATUS_QUERY',null,(select payload from life_events where label='refund-f-2'))->>'outcome', 'REFUND_RECORDED', 'polling confirms the second refund');
reset role;
select is((select status::text from public.payment_link_refund_requests where id=(select (result->>'refund_id')::uuid from life_refund_f)), 'CONFIRMED', 'the second refund is confirmed');
select is((select status from public.payment_recovery_items where id=(select (result->>'recovery_item_id')::uuid from life_dup)), 'RESOLVED', 'refunding the duplicate payment closes its recovery item');
select is((select count(*)::int from public.payment_recovery_items where kind='REFUND_CONFIRMED' and sale_id=(select sale_id from life_sales where label='f')), 0, 'refunding a payment that never confirmed the sale needs no reversal');

-- A request whose worker vanished may have reached the provider.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table life_refund_lost as select public.request_payment_link_refund('life-tx-f-01',100,'Ajuste parcial',null,'life-refund-lost',gen_random_uuid()) result;
reset role;
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select is(jsonb_array_length(public.worker_claim_payment_link_refunds('worker-1', 10, 120)), 1, 'the partial refund is claimed');
reset role;
update public.payment_link_refund_requests set lease_expires_at = clock_timestamp() - interval '1 second' where id = (select (result->>'refund_id')::uuid from life_refund_lost);
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select is(jsonb_array_length(public.worker_claim_payment_link_refunds('worker-2', 10, 120)), 0, 'an expired refund claim is not resubmitted');
reset role;
select is((select status::text from public.payment_link_refund_requests where id=(select (result->>'refund_id')::uuid from life_refund_lost)), 'UNCERTAIN', 'an expired refund claim becomes uncertain');

-- Uncertain links: found in the panel, or confirmed never created.
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select is(public.worker_record_payment_link_event('WEBHOOK','TransactionPaymentMessage',(select payload from life_events where label='pay-g'))->>'outcome', 'RECOVERY_OPENED', 'a payment on the uncertain link waits');
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(public.reconcile_uncertain_payment_link((select charge_id from life_links where label='g'),'life-link-g','https://link.picpay.com/p/life-link-g','Link encontrado no painel','life-reconcile-g',gen_random_uuid())->>'status', 'PAID', 'the found link catches up with its payment');
select is(public.reconcile_uncertain_payment_link((select charge_id from life_links where label='h'),null,null,'Link não existe no painel','life-reconcile-h',gen_random_uuid())->>'status', 'FAILED', 'a link confirmed as never created fails');
select throws_ok($$select public.reconcile_uncertain_payment_link((select charge_id from life_links where label='a'),null,null,'Tentativa indevida','life-reconcile-a',gen_random_uuid())$$, 'P0001', 'PAYMENT_LINK_NOT_UNCERTAIN', 'only uncertain links are reconciled');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select is(public.request_payment_link((select sale_id from life_sales where label='h'),'life-req-h-again',gen_random_uuid())->>'status', 'REQUESTED', 'the seller can ask again after a confirmed non-creation');
reset role;
select is((select status::text from public.sales where id=(select sale_id from life_sales where label='g')), 'CONFIRMED', 'the reconciled payment confirmed the sale once');
select is((select count(*)::int from public.payment_recovery_items where kind='UNCERTAIN_CREATION' and status='OPEN'), 0, 'reconciliation closes the uncertain items');

select * from finish();
rollback;
