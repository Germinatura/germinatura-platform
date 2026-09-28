-- Spec 5.8 (FIN-005): audited manual entries on fixed categories and treasury accounts.
begin;
select plan(22);

select has_table('public','finance_manual_entries','manual entries exist');
select ok(not has_function_privilege('anon','public.record_finance_entry(public.finance_manual_entry_kind,public.finance_category,public.finance_account,public.finance_account,bigint,date,text,text,text,uuid)','EXECUTE'),'anonymous cannot record entries');
select ok(not has_table_privilege('authenticated','public.finance_manual_entries','INSERT'),'entries deny direct writes');

set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.record_finance_entry('EXPENSE','TRANSPORTE','PICPAY_EMPRESAS',null,5000,current_date,'Frete do evento',null,'fin-seller',gen_random_uuid())$$,'42501','FINANCE_MANAGE_REQUIRED','a seller cannot record entries');

set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000001';
create temp table expense as select public.record_finance_entry('EXPENSE','TRANSPORTE','PICPAY_EMPRESAS',null,5000,'2026-09-15','Frete do evento de formatura','NF-2026-0915','fin-expense','6c000000-0000-4000-8000-000000000001') result;
select is((select result->>'kind' from expense),'EXPENSE','finance records an expense');
select is(public.record_finance_entry('EXPENSE','TRANSPORTE','PICPAY_EMPRESAS',null,5000,'2026-09-15','Frete do evento de formatura','NF-2026-0915','fin-expense','6c000000-0000-4000-8000-000000000001'),(select result from expense),'replay is idempotent');
select throws_ok($$select public.record_finance_entry('EXPENSE','TRANSPORTE','PICPAY_EMPRESAS',null,6000,'2026-09-15','Frete do evento de formatura','NF-2026-0915','fin-expense',gen_random_uuid())$$,'P0001','IDEMPOTENCY_CONFLICT','a reused key with other data is rejected');
select lives_ok($$select public.record_finance_entry('INCOME','MENSALIDADES','PICPAY_EMPRESAS',null,20000,'2026-09-16','Mensalidades de setembro',null,'fin-income',gen_random_uuid())$$,'finance records an income');
select lives_ok($$select public.record_finance_entry('TRANSFER',null,'DINHEIRO_FISICO','PICPAY_EMPRESAS',3000,'2026-09-17','Depósito do caixa físico','DEP-0917','fin-transfer',gen_random_uuid())$$,'finance records a treasury transfer');
select throws_ok($$select public.record_finance_entry('INCOME','VENDA_PDV','DINHEIRO_FISICO',null,2590,'2026-09-16','Venda avulsa',null,'fin-sale',gen_random_uuid())$$,'22023','FINANCE_CATEGORY_AUTOMATIC_ONLY','sale revenue never comes from manual entries');
select throws_ok($$select public.record_finance_entry('TRANSFER',null,'PICPAY_EMPRESAS','PICPAY_EMPRESAS',100,'2026-09-16','Transferência inválida',null,'fin-same',gen_random_uuid())$$,'22023','INVALID_FINANCE_ENTRY','a transfer needs two different accounts');
select throws_ok($$select public.record_finance_entry('EXPENSE','OUTROS','PICPAY_EMPRESAS',null,100,(now() at time zone 'America/Sao_Paulo')::date + 1,'Despesa futura',null,'fin-future',gen_random_uuid())$$,'22023','INVALID_FINANCE_ENTRY','future dates are rejected');
select throws_ok($$select public.record_finance_entry('EXPENSE','OUTROS','PICPAY_EMPRESAS',null,100,'2026-09-16','Pagamento com cartão','4111111111111111','fin-pan',gen_random_uuid())$$,'22023','INVALID_NON_SENSITIVE_REFERENCE','card numbers are never references');

create temp table totals as select public.list_finance_entries('2026-09-01','2026-09-30',null,null,null,100)->'totals' result;
select is((select (result->'by_account'->>'PICPAY_EMPRESAS')::bigint from totals),18000::bigint,'PicPay account nets income, expense and the incoming transfer');
select is((select (result->'by_account'->>'DINHEIRO_FISICO')::bigint from totals),-3000::bigint,'the transfer leaves the physical cash account');
select is((select (result->>'inflow_cents')::bigint from totals),23000::bigint,'inflow counts the income and the incoming side of the transfer');

create temp table reversal as select public.reverse_finance_entry((select (result->>'id')::uuid from expense),'Frete lançado em duplicidade','fin-reverse','6c000000-0000-4000-8000-000000000002') result;
select is((select result->>'reversal_of' from reversal),(select result->>'id' from expense),'the reversal points to the original entry');
select throws_ok($$select public.reverse_finance_entry((select (result->>'id')::uuid from expense),'Estorno repetido do frete','fin-reverse-2',gen_random_uuid())$$,'P0001','FINANCE_ENTRY_ALREADY_REVERSED','an entry is reversed only once');
select throws_ok($$select public.reverse_finance_entry((select (result->>'id')::uuid from reversal),'Estorno do próprio estorno','fin-reverse-3',gen_random_uuid())$$,'P0001','FINANCE_ENTRY_NOT_REVERSIBLE','a reversal cannot be reversed');
select is((select (item->>'reversed_by') from jsonb_array_elements(public.list_finance_entries('2026-09-01','2026-09-30',null,null,null,100)->'items') item where item->>'id'=(select result->>'id' from expense)),(select result->>'id' from reversal),'the list shows which entry reversed the expense');
select is((public.list_finance_entries('2026-09-01','2026-09-30','TRANSPORTE',null,null,100)->'totals'->'by_category'->>'TRANSPORTE')::bigint,
  case when (now() at time zone 'America/Sao_Paulo')::date between '2026-09-01' and '2026-09-30' then 0 else -5000 end::bigint,'the reversal cancels the expense in its own period');
reset role;

select throws_ok($$delete from public.finance_manual_entries$$,'P0001','IMMUTABLE_RECORD','entries are immutable');

select * from finish();
rollback;
