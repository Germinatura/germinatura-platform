begin;
select plan(43);

select has_table('public','purchase_payable_settlements','payable settlement table exists');
select has_view('public','purchase_payable_balances','payable balance projection exists');
select ok((select relrowsecurity from pg_class where oid='public.purchase_payable_settlements'::regclass),'settlements have RLS');
select ok(not has_table_privilege('authenticated','public.purchase_payable_settlements','INSERT'),'direct settlement inserts denied');
select ok(not has_function_privilege('anon','public.settle_purchase_payable(uuid,bigint,date,text,text,text,text,uuid)','EXECUTE'),'anonymous settlement command denied');
select ok(not has_function_privilege('anon','public.reverse_purchase_payable_settlement(uuid,date,text,text,uuid)','EXECUTE'),'anonymous reversal command denied');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.settle_purchase_payable(gen_random_uuid(),100,current_date,'PIX','REF-1','Tentativa indevida','payable-denied',gen_random_uuid())$$,'42501','FINANCE_MANAGE_FORBIDDEN','consumer cannot settle a payable');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table payable_supplier as select public.save_supplier(null,null,'Fornecedor a liquidar','Equipe',null,null,null,null,true,'Preparar pagamento','payable-supplier',gen_random_uuid()) result;
create temp table payable_order as select public.create_purchase_order(
  (select (result->>'id')::uuid from payable_supplier),current_date,null,250,50,'PIX após entrega',null,null,
  '[{"productId":"33000000-0000-4000-8000-000000000001","quantity":2,"unitCostCents":625}]'::jsonb,
  'Compra a liquidar','payable-order',gen_random_uuid()) result;
create temp table payable_item as select id from public.purchase_order_items where order_id=(select (result->>'id')::uuid from payable_order);
create temp table payable_receipt as select public.receive_purchase_order_item(
  (select (result->>'id')::uuid from payable_order),(select id from payable_item),2,current_date,
  'PAYABLE-LOT',null,null,'Entrega completa','payable-receipt',gen_random_uuid()) result;
create temp table payable_target as select (result->>'payableId')::uuid id from payable_receipt;

select is((select amount_cents from public.purchase_payable_entries where id=(select id from payable_target)),1550::bigint,'receipt creates expected obligation');
select is((select settled_cents from public.purchase_payable_balances where id=(select id from payable_target)),0::bigint,'new obligation has no settlement');
select is((select outstanding_cents from public.purchase_payable_balances where id=(select id from payable_target)),1550::bigint,'new obligation is fully outstanding');
select is((select status from public.purchase_payable_balances where id=(select id from payable_target)),'PENDING','new obligation is pending');
select throws_ok($$select public.settle_purchase_payable((select id from payable_target),100,current_date-1,'PIX','BEFORE','Pagamento anterior','payable-before',gen_random_uuid())$$,'22023','INVALID_PAYABLE_SETTLEMENT','settlement cannot precede the receipt');
select throws_ok($$select public.settle_purchase_payable((select id from payable_target),100,current_date+1,'PIX','FUTURE','Data futura','payable-future',gen_random_uuid())$$,'22023','INVALID_PAYABLE_SETTLEMENT','future settlement date rejected');

reset role;
insert into public.user_roles(user_id,role_id) values('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000005');
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select is((select supplier_name from public.purchase_payable_balances where id=(select id from payable_target)),'Fornecedor a liquidar','finance reads supplier and obligation projection');
create temp table partial_settlement as select public.settle_purchase_payable(
  (select id from payable_target),600,current_date,'PIX PicPay Empresas','PIX-001','Pagamento parcial conferido','payable-partial',gen_random_uuid()) result;
select is((select (result->>'amountCents')::bigint from partial_settlement),600::bigint,'partial settlement records requested amount');
select is((select result->>'status' from partial_settlement),'PENDING','partial settlement keeps obligation pending');
select is((select (result->>'remainingCents')::bigint from partial_settlement),950::bigint,'server calculates remaining balance');
select is((select settled_cents from public.purchase_payable_balances where id=(select id from payable_target)),600::bigint,'projection sums partial settlement');
select is((select outstanding_cents from public.purchase_payable_balances where id=(select id from payable_target)),950::bigint,'projection calculates partial outstanding amount');
select is((select status from public.purchase_payable_balances where id=(select id from payable_target)),'PENDING','partial balance remains pending');
select results_eq($$select public.settle_purchase_payable((select id from payable_target),600,current_date,'PIX PicPay Empresas','PIX-001','Pagamento parcial conferido','payable-partial',gen_random_uuid())$$,$$select result from partial_settlement$$,'settlement replay returns original result');
select is((select count(*)::integer from public.purchase_payable_settlements where payable_id=(select id from payable_target)),1,'settlement replay creates no duplicate');
select throws_ok($$select public.settle_purchase_payable((select id from payable_target),951,current_date,'PIX','PIX-OVER','Pagamento excedente','payable-over',gen_random_uuid())$$,'P0001','PURCHASE_PAYABLE_AMOUNT_EXCEEDED','overpayment rejected under lock');
create temp table final_settlement as select public.settle_purchase_payable(
  (select id from payable_target),950,current_date,'PIX PicPay Empresas','PIX-002','Pagamento final conferido','payable-final',gen_random_uuid()) result;
select is((select result->>'status' from final_settlement),'SETTLED','exact final payment settles obligation');
select is((select settled_cents from public.purchase_payable_balances where id=(select id from payable_target)),1550::bigint,'projection reconciles exact settled amount');
select is((select outstanding_cents from public.purchase_payable_balances where id=(select id from payable_target)),0::bigint,'fully paid obligation has no outstanding amount');
select is((select status from public.purchase_payable_balances where id=(select id from payable_target)),'SETTLED','fully paid obligation is settled');
select throws_ok($$select public.settle_purchase_payable((select id from payable_target),1,current_date,'PIX','PIX-LATE','Pagamento adicional','payable-late',gen_random_uuid())$$,'P0001','PURCHASE_PAYABLE_ALREADY_SETTLED','settled obligation rejects another payment');
create temp table payable_reversal as select public.reverse_purchase_payable_settlement(
  (select (result->>'id')::uuid from partial_settlement),current_date,'Pagamento lançado na conta errada','payable-reverse',gen_random_uuid()) result;
select is((select (result->>'amountCents')::bigint from payable_reversal),600::bigint,'reversal mirrors original amount');
select is((select (result->>'remainingCents')::bigint from payable_reversal),600::bigint,'reversal reopens only its amount');
select is((select settled_cents from public.purchase_payable_balances where id=(select id from payable_target)),950::bigint,'reversal removes original payment from settled total');
select is((select outstanding_cents from public.purchase_payable_balances where id=(select id from payable_target)),600::bigint,'reversal restores outstanding amount');
select is((select status from public.purchase_payable_balances where id=(select id from payable_target)),'PENDING','reversal reopens obligation');
select results_eq($$select public.reverse_purchase_payable_settlement((select (result->>'id')::uuid from partial_settlement),current_date,'Pagamento lançado na conta errada','payable-reverse',gen_random_uuid())$$,$$select result from payable_reversal$$,'reversal replay returns original result');
select throws_ok($$select public.reverse_purchase_payable_settlement((select (result->>'id')::uuid from partial_settlement),current_date,'Segunda tentativa de reversão','payable-reverse-twice',gen_random_uuid())$$,'P0001','PAYABLE_SETTLEMENT_ALREADY_REVERSED','settlement cannot be reversed twice');
reset role;
select is((select count(*)::integer from public.audit_logs where action='finance.purchase_payable.settled' and metadata->>'payable_id'=(select id::text from payable_target)),2,'each settlement has audit evidence');
select is((select count(*)::integer from public.outbox_events where topic='finance.purchase_payable.settled' and aggregate_id=(select id::text from payable_target)),2,'each settlement has outbox evidence');
select is((select count(*)::integer from public.audit_logs where action='finance.purchase_payable.settlement_reversed' and metadata->>'payable_id'=(select id::text from payable_target)),1,'reversal has audit evidence');
select is((select count(*)::integer from public.outbox_events where topic='finance.purchase_payable.settlement_reversed' and aggregate_id=(select id::text from payable_target)),1,'reversal has outbox evidence');
select throws_ok($$update public.purchase_payable_settlements set amount_cents=1 where id=(select (result->>'id')::uuid from final_settlement)$$,'P0001','IMMUTABLE_RECORD','settlement history cannot be rewritten');
select throws_ok($$delete from public.purchase_payable_settlements where id=(select (result->>'id')::uuid from final_settlement)$$,'P0001','IMMUTABLE_RECORD','settlement history cannot be deleted');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select is((select count(*)::integer from public.purchase_payable_balances where id=(select id from payable_target)),0,'seller cannot read obligations');
select is((select count(*)::integer from public.purchase_payable_settlements where payable_id=(select id from payable_target)),0,'seller cannot read settlement history');

select * from finish();
rollback;
