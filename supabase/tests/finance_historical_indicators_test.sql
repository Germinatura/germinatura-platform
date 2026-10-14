-- PR E (historical finance and indicators, design frozen 2026-10-13): historical adjustments without cash, cutover
-- counterpart designations (presentation only), the official result with adjustments, presentation = official for every
-- window, COGS visibility, the goal as net available resources, and the result → cash bridge with no residual.
-- Reference case (Mariana): Pix of R$ 680,00 classified as supplier, technical counterpart of R$ 570,50, historical CMV of
-- R$ 570,50 (2 units bought for R$ 285,25 each and written off by a negative count adjustment).
begin;
select plan(82);

create function pg_temp.ctx(p_user uuid, p_header text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
  perform set_config('role', 'authenticated', true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create function pg_temp.a() returns uuid language sql as $$ select 'c0000000-0000-4000-8000-000000002026'::uuid $$;
create function pg_temp.admin() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.seller() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.master() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000005'::uuid $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;
create function pg_temp.dot(p_cents bigint) returns text language sql as $$
  select case when p_cents < 0 then '-' else '' end || (abs(p_cents) / 100)::text || '.' || lpad((abs(p_cents) % 100)::text, 2, '0') $$;
create function pg_temp.statement(p_lines text[]) returns text language sql as $$
  select 'data;movimento;descrição;tipo;valor' || E'\n' || array_to_string(p_lines, E';\r\n') || E';\r\n' $$;
create function pg_temp.stmt(p_day date, p_description text, p_cents bigint) returns text language sql as $$
  select to_char(p_day, 'YYYY-MM-DD') || ';Pix enviado;' || p_description || ';Saída;' || pg_temp.dot(p_cents) $$;
-- Reads as the current request (cohort scope from the headers), through the definer functions.
create function pg_temp.ind(p_from date, p_to date) returns jsonb language sql security definer as $$
  select private.compute_management_indicators(p_from, p_to) $$;
create function pg_temp.profit(p_from date, p_to date) returns bigint language sql security definer as $$
  select (private.compute_management_indicators(p_from, p_to) #>> '{totals,operating_profit_cents}')::bigint $$;
create function pg_temp.show(p_from date, p_to date, p_key text) returns bigint language sql security definer as $$
  select (private.compute_management_indicators(p_from, p_to) #>> array['presentation', p_key])::bigint $$;
create function pg_temp.cash() returns text language sql security definer as $$
  select string_agg(account::text || ':' || balance_cents, ',' order by account) from private.finance_account_balances(pg_temp.today()) $$;
create function pg_temp.real() returns bigint language sql security definer as $$
  select sum(balance_cents)::bigint from private.finance_account_balances(pg_temp.today()) where account in ('PICPAY_EMPRESAS', 'COFRINHO_PICPAY', 'DINHEIRO_FISICO') $$;
create function pg_temp.line(p_description text) returns uuid language sql security definer as $$
  select id from public.picpay_statement_lines where description = p_description $$;
create function pg_temp.entry(p_reference text) returns uuid language sql security definer as $$
  select id from cohort_data.finance_manual_entries where reference = p_reference $$;
create function pg_temp.import(p_name text, p_content text, p_scope text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
  perform pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
  v_result := public.import_picpay_file(p_name, p_content, p_scope::public.picpay_import_scope,
    case when p_scope = 'COHORT' then pg_temp.a() end, 'e-' || p_name, gen_random_uuid());
  perform pg_temp.ctx(pg_temp.admin(), pg_temp.a()::text);
  return v_result;
end;
$$;
create function pg_temp.designate(p_counterpart text, p_line text, p_expense text, p_cents bigint, p_key text) returns jsonb language sql as $$
  select public.designate_cutover_counterpart(pg_temp.entry(p_counterpart), pg_temp.line(p_line), pg_temp.entry(p_expense), p_cents,
    'Contrapartida técnica do cutover conferida', p_key, gen_random_uuid()) $$;

-- Setup: native operation starts in two days, so everything below is history (as in the real cutover).
select pg_temp.ctx(pg_temp.admin(), pg_temp.a()::text);
select public.record_finance_opening_position(pg_temp.today() - 40, pg_temp.today() + 2, 0, 0, 0, 0, 'Abertura do teste E', null, null, 'e-open', gen_random_uuid());
create temp table supplier as select public.save_supplier(null, null, 'Fornecedor E', 'Equipe', null, null, null, null, true, 'Fornecedor do teste E', 'e-supplier', gen_random_uuid()) result;
create temp table purchase as select public.create_purchase_order((select (result ->> 'id')::uuid from supplier), pg_temp.today(), null, 0, 0, 'PIX', null, null,
  '[{"productId":"33f00000-0000-4000-8000-000000000001","quantity":2,"unitCostCents":28525}]'::jsonb, 'Compra do teste E', 'e-order', gen_random_uuid()) result;
select public.receive_purchase_order_item((select (result ->> 'id')::uuid from purchase),
  (select id from public.purchase_order_items where order_id = (select (result ->> 'id')::uuid from purchase)), 2, pg_temp.today(),
  'LOTE-E-01', null, null, 'Entrega do teste E', 'e-receipt', gen_random_uuid());
select public.adjust_stock('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001', -2,
  'Ajuste do estoque físico após vendas históricas realizadas no período de cutover', 'e-writeoff', gen_random_uuid());
reset role;
insert into ids select 'writeoff', id from cohort_data.stock_movements where movement_type = 'AJUSTE_NEGATIVO' and reason like 'Ajuste do estoque físico%';
select pg_temp.ctx(pg_temp.admin(), pg_temp.a()::text);
-- Manual entries: Mariana's counterpart (today − 3), a legitimate adjustment income (today − 4), Lucas' expense and three
-- counterparts for it (today − 6).
select public.record_finance_entry('INCOME', 'AJUSTE', 'PICPAY_EMPRESAS', null, 57050, pg_temp.today() - 3,
  'Contrapartida técnica do cutover: payables da Mariana já estavam pagos', 'CUTOVER-MARIANA-PAGO', 'e-m', gen_random_uuid());
select public.record_finance_entry('INCOME', 'AJUSTE', 'PICPAY_EMPRESAS', null, 10000, pg_temp.today() - 4, 'Ajuste legítimo de caixa', 'AJUSTE-LEGITIMO', 'e-legit', gen_random_uuid());
select public.record_finance_entry('EXPENSE', 'MATERIAIS', 'PICPAY_EMPRESAS', null, 100000, pg_temp.today() - 6, 'Pedido do Lucas', 'LUCAS-PEDIDO', 'e-t', gen_random_uuid());
select public.record_finance_entry('INCOME', 'AJUSTE', 'PICPAY_EMPRESAS', null, amount, pg_temp.today() - 6, 'Contrapartida ' || tag, 'CP-' || tag, 'e-cp-' || tag, gen_random_uuid())
from (values ('A', 40000), ('B', 60000), ('C', 100)) counterparts(tag, amount);
-- The PicPay evidence: Mariana's Pix (today − 1) and a bank fee (today − 6), attributed to Turma 2026; a global line.
select pg_temp.import('extrato-e.csv', pg_temp.statement(array[pg_temp.stmt(pg_temp.today() - 1, 'Fornecedor Mariana', -68000),
  pg_temp.stmt(pg_temp.today() - 6, 'Tarifa bancária', -500)]), 'COHORT');
select pg_temp.import('extrato-global.csv', pg_temp.statement(array[pg_temp.stmt(pg_temp.today() - 1, 'Linha sem turma', -700)]), 'GLOBAL');
select public.resolve_picpay_statement_line(pg_temp.line('Fornecedor Mariana'), 'CLASSIFICAR', 'FORNECEDOR', null, null, null, 'e-cl-m', gen_random_uuid());
select public.resolve_picpay_statement_line(pg_temp.line('Tarifa bancária'), 'CLASSIFICAR', 'TAXAS', null, null, null, 'e-cl-t', gen_random_uuid());
-- A manual income of another cohort.
select pg_temp.ctx(pg_temp.master(), 'all');
insert into ids select 'cohort_b', (public.create_cohort('Turma E B', 2036, 'turma-e-b', 'ACTIVE', 'e-create-b', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.ctx(pg_temp.master(), pg_temp.id('cohort_b')::text);
select public.record_finance_entry('INCOME', 'AJUSTE', 'PICPAY_EMPRESAS', null, 5000, pg_temp.today() - 3, 'Receita da turma B', 'B-RECEITA', 'e-b', gen_random_uuid());
select pg_temp.ctx(pg_temp.admin(), pg_temp.a()::text);

-- 1. Historical adjustments ----------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.record_finance_historical_adjustment(public.finance_result_component,public.finance_adjustment_direction,bigint,date,public.finance_category,text,text,public.finance_adjustment_provenance,uuid[],text,uuid)', 'EXECUTE'),
  'anonymous cannot record adjustments');
create temp table cmv_args as select 'CMV de vendas históricas do cutover: 2 unidades baixadas pela contagem sem passar pelo CMV' as justification;
grant select on cmv_args to authenticated;
select pg_temp.ctx(pg_temp.seller(), pg_temp.a()::text);
select throws_ok($$select public.record_finance_historical_adjustment('CMV', 'ACRESCIMO', 57050, pg_temp.today(), null, (select justification from cmv_args),
  null, 'HISTORICO_RECONSTRUIDO', array[pg_temp.id('writeoff')], 'e-adj-seller', gen_random_uuid())$$, '42501', 'FINANCE_MANAGE_REQUIRED', 'a seller cannot adjust the result');
select pg_temp.ctx(pg_temp.master(), 'all');
select throws_ok($$select public.record_finance_historical_adjustment('CMV', 'ACRESCIMO', 57050, pg_temp.today(), null, (select justification from cmv_args),
  null, 'HISTORICO_RECONSTRUIDO', array[pg_temp.id('writeoff')], 'e-adj-all', gen_random_uuid())$$, '22023', 'COHORT_REQUIRED', '"Todas as turmas" cannot adjust');
select pg_temp.ctx(pg_temp.admin(), pg_temp.a()::text);
select throws_ok($$select public.record_finance_historical_adjustment('CMV', 'ACRESCIMO', 57050, pg_temp.today(), null, (select justification from cmv_args),
  null, 'HISTORICO_RECONSTRUIDO', null, 'e-adj-nomov', gen_random_uuid())$$, '22023', 'HISTORICAL_ADJUSTMENT_MOVEMENTS_REQUIRED', 'a cost increase names the movements it recognises');
select throws_ok($$select public.record_finance_historical_adjustment('RECEITA', 'ACRESCIMO', 1000, pg_temp.today(), 'OUTROS', (select justification from cmv_args),
  null, 'HISTORICO_RECONSTRUIDO', array[pg_temp.id('writeoff')], 'e-adj-revmov', gen_random_uuid())$$, '22023', 'HISTORICAL_ADJUSTMENT_MOVEMENTS_REQUIRED', 'revenue never references stock movements');
select throws_ok($$select public.record_finance_historical_adjustment('CMV', 'ACRESCIMO', 57051, pg_temp.today(), null, (select justification from cmv_args),
  null, 'HISTORICO_RECONSTRUIDO', array[pg_temp.id('writeoff')], 'e-adj-over', gen_random_uuid())$$, 'P0001', 'HISTORICAL_ADJUSTMENT_ABOVE_REFERENCED_COST', 'never above the referenced cost');
select throws_ok($$select public.record_finance_historical_adjustment('CMV', 'ACRESCIMO', 57050, pg_temp.today() + 2, null, (select justification from cmv_args),
  null, 'HISTORICO_RECONSTRUIDO', array[pg_temp.id('writeoff')], 'e-adj-native', gen_random_uuid())$$, 'P0001', 'HISTORICAL_ADJUSTMENT_NOT_HISTORICAL', 'only before native operation');
select throws_ok($$select public.record_finance_historical_adjustment('CMV', 'ACRESCIMO', 57050, pg_temp.today() - 1, null, (select justification from cmv_args),
  null, 'HISTORICO_RECONSTRUIDO', array[pg_temp.id('writeoff')], 'e-adj-early', gen_random_uuid())$$, 'P0001', 'HISTORICAL_ADJUSTMENT_BEFORE_MOVEMENT', 'never before the goods left the stock');
create temp table cash_before as select pg_temp.cash() as value;
grant select on cash_before to authenticated;
create temp table adj as select public.record_finance_historical_adjustment('CMV', 'ACRESCIMO', 57050, pg_temp.today(), null, (select justification from cmv_args),
  'CMV-HIST-1', 'HISTORICO_RECONSTRUIDO', array[pg_temp.id('writeoff')], 'e-adj', gen_random_uuid()) as result;
grant select on adj to authenticated;
select is((select (result ->> 'result_effect_cents')::bigint from adj), -57050::bigint, 'a historical CMV of R$ 570,50 lowers the result by R$ 570,50');
select is(pg_temp.cash(), (select value from cash_before), 'and moves no account: no cash, receivable, settlement or transfer');
select is((select jsonb_array_length(result -> 'stock_movements') from adj), 1, 'it references the write-off movement');
select is(public.record_finance_historical_adjustment('CMV', 'ACRESCIMO', 57050, pg_temp.today(), null, (select justification from cmv_args),
  'CMV-HIST-1', 'HISTORICO_RECONSTRUIDO', array[pg_temp.id('writeoff')], 'e-adj', gen_random_uuid()) ->> 'id', (select result ->> 'id' from adj), 'a replay returns the same adjustment');
select throws_ok($$select public.record_finance_historical_adjustment('CMV', 'ACRESCIMO', 100, pg_temp.today(), null, (select justification from cmv_args),
  null, 'HISTORICO_RECONSTRUIDO', array[pg_temp.id('writeoff')], 'e-adj-dup', gen_random_uuid())$$, 'P0001', 'HISTORICAL_ADJUSTMENT_MOVEMENT_ALREADY_COVERED', 'a movement is covered by one active adjustment');
create temp table reversal as select public.reverse_finance_historical_adjustment((select (result ->> 'id')::uuid from adj), 'Valor revisto na conferência', 'e-adj-rev', gen_random_uuid()) as result;
grant select on reversal to authenticated;
select is((select (result ->> 'result_effect_cents')::bigint from reversal), 57050::bigint, 'a reversal undoes the effect');
select is((pg_temp.ind(pg_temp.today() - 40, pg_temp.today()) #>> '{totals,historical_adjustments_cents}')::bigint, 0::bigint, 'original + reversal = nothing');
select throws_ok($$select public.reverse_finance_historical_adjustment((select (result ->> 'id')::uuid from adj), 'Reverter de novo', 'e-adj-rev2', gen_random_uuid())$$,
  'P0001', 'HISTORICAL_ADJUSTMENT_NOT_REVERSIBLE', 'an adjustment is reversed once');
select throws_ok($$select public.reverse_finance_historical_adjustment((select (result ->> 'id')::uuid from reversal), 'Reverter a reversão', 'e-adj-rev3', gen_random_uuid())$$,
  'P0001', 'HISTORICAL_ADJUSTMENT_NOT_REVERSIBLE', 'a reversal is never reversed');
select lives_ok($$select public.record_finance_historical_adjustment('CMV', 'ACRESCIMO', 57050, pg_temp.today(), null, (select justification from cmv_args),
  'CMV-HIST-2', 'HISTORICO_RECONSTRUIDO', array[pg_temp.id('writeoff')], 'e-adj-again', gen_random_uuid())$$, 'after the reversal, the movement can be referenced again');
reset role;
select throws_ok($$update cohort_data.finance_historical_adjustments set amount_cents = 1$$, 'P0001', 'IMMUTABLE_RECORD', 'adjustments are immutable');
select is((select count(*)::integer from cohort_data.inventory_lots where total_cost_cents = 57050), 1, 'the lot is untouched');
select pg_temp.ctx(pg_temp.admin(), pg_temp.a()::text);

-- 2. Mariana: the official result never changes; the presentation reclassifies the pair -----------------------------------
-- Window [today − 3, today]: the counterpart (+570,50), the Pix (−680,00) and the historical CMV (570,50), nothing else.
create temp table before_designation as select pg_temp.profit(pg_temp.today() - 3, pg_temp.today()) as profit,
  pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'operating_revenue_presented_cents') as revenue,
  pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'operating_expenses_presented_cents') as expenses, pg_temp.cash() as cash;
grant select on before_designation to authenticated;
select is((select profit from before_designation), -68000::bigint, 'official result before the designation: 570,50 − 680,00 − 570,50 = −680,00');
select is((select revenue || '/' || expenses from before_designation), '57050/68000', 'before: the counterpart shows as revenue and the Pix as a whole expense');
create temp table mariana as select pg_temp.designate('CUTOVER-MARIANA-PAGO', 'Fornecedor Mariana', null, 57050, 'e-des-m') as result;
grant select on mariana to authenticated;
select is((select result ->> 'status' from mariana), 'ATIVA', 'the designation is active');
select is((select (result ->> 'result_effect_cents')::bigint + (result ->> 'cash_effect_cents')::bigint from mariana), 0::bigint, 'it declares no effect on cash or result');
select is(pg_temp.profit(pg_temp.today() - 3, pg_temp.today()), -68000::bigint, 'official result after the designation: exactly −680,00');
select is(pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'operating_revenue_presented_cents'), 0::bigint, 'operating revenue no longer includes the 570,50');
select is(pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'technical_cutover_counterparts_cents'), 57050::bigint, 'technical cutover adjustments: 570,50 (memo)');
select is(pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'operating_expenses_registered_cents'), 68000::bigint, 'registered operating expense: 680,00');
select is(pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'counterparts_cents'), 57050::bigint, 'technical counterparts: 570,50');
select is(pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'operating_expenses_presented_cents'), 10950::bigint, 'presented operating expense: 109,50');
select is(pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'cogs_cents'), 57050::bigint, 'CMV: 570,50 (the historical adjustment)');
select is(pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'operating_expenses_presented_cents') + pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'cogs_cents'),
  68000::bigint, 'total economic cost: 680,00');
select is(pg_temp.show(pg_temp.today() - 3, pg_temp.today(), 'operating_result_cents'), -68000::bigint, 'presented result = official result');
select is(pg_temp.cash(), (select cash from before_designation), 'cash unchanged');
select is(pg_temp.show(pg_temp.today() - 4, pg_temp.today() - 4, 'operating_revenue_presented_cents'), 10000::bigint,
  'a legitimate undesignated INCOME/AJUSTE stays in operating revenue');
reset role;
select is((select count(*)::integer from cohort_data.finance_manual_entries where reversal_of is not null), 0, 'no entry was reversed or rewritten');
select pg_temp.ctx(pg_temp.admin(), pg_temp.a()::text);

-- 3. Periods: reclassified only when both sides are in the window; presented = official in every window ---------------
select is(pg_temp.show(pg_temp.today() - 3, pg_temp.today() - 1, 'technical_cutover_counterparts_cents'), 57050::bigint, 'both sides in the window: reclassified');
select is(pg_temp.show(pg_temp.today() - 3, pg_temp.today() - 2, 'technical_cutover_counterparts_cents') || '/'
  || pg_temp.show(pg_temp.today() - 3, pg_temp.today() - 2, 'operating_revenue_presented_cents') || '/'
  || pg_temp.show(pg_temp.today() - 3, pg_temp.today() - 2, 'counterparts_outside_window'), '0/57050/1', 'only the counterpart in the window: nothing reclassified, flagged');
select is(pg_temp.show(pg_temp.today() - 1, pg_temp.today(), 'technical_cutover_counterparts_cents') || '/'
  || pg_temp.show(pg_temp.today() - 1, pg_temp.today(), 'operating_expenses_presented_cents') || '/'
  || pg_temp.show(pg_temp.today() - 1, pg_temp.today(), 'counterparts_outside_window'), '0/68000/1', 'only the target in the window: nothing reclassified, flagged');
select is(pg_temp.show(pg_temp.today() - 20, pg_temp.today() - 10, 'technical_cutover_counterparts_cents') || '/'
  || pg_temp.show(pg_temp.today() - 20, pg_temp.today() - 10, 'counterparts_outside_window'), '0/0', 'neither side in the window: no effect');
select is((select count(*)::integer from (values (-3, -1), (-3, -2), (-1, 0), (-20, -10), (-40, 0), (-6, -6), (-4, -4)) windows(f, t)
  where pg_temp.show(pg_temp.today() + f, pg_temp.today() + t, 'operating_result_cents') <> pg_temp.profit(pg_temp.today() + f, pg_temp.today() + t)), 0,
  'presented result = official result in every window');

-- 4. Two counterparts for one target; never beyond it ------------------------------------------------------------------
select lives_ok($$select pg_temp.designate('CP-A', null, 'LUCAS-PEDIDO', 40000, 'e-des-a')$$, 'counterpart A (400,00) neutralizes part of the 1.000,00 expense');
select lives_ok($$select pg_temp.designate('CP-B', null, 'LUCAS-PEDIDO', 60000, 'e-des-b')$$, 'counterpart B (600,00) the rest');
select is(pg_temp.show(pg_temp.today() - 6, pg_temp.today() - 6, 'technical_cutover_counterparts_cents'), 100000::bigint, 'total neutralized: 1.000,00');
select throws_ok($$select pg_temp.designate('CP-C', null, 'LUCAS-PEDIDO', 100, 'e-des-c')$$, 'P0001', 'CUTOVER_TARGET_EXCEEDED', 'never beyond the target');
select is(pg_temp.show(pg_temp.today() - 6, pg_temp.today() - 6, 'operating_result_cents'), pg_temp.profit(pg_temp.today() - 6, pg_temp.today() - 6),
  'presented = official with two counterparts');

-- 5. Refusals ---------------------------------------------------------------------------------------------------------
select throws_ok($$select pg_temp.designate('B-RECEITA', null, 'LUCAS-PEDIDO', 5000, 'e-des-other')$$, 'P0001', 'CUTOVER_COUNTERPART_NOT_ELIGIBLE',
  'a counterpart of another cohort is refused');
select throws_ok($$select pg_temp.designate('CP-C', null, 'AJUSTE-LEGITIMO', 100, 'e-des-income')$$, 'P0001', 'CUTOVER_TARGET_NOT_EXPENSE', 'an income is not a target');
select throws_ok($$select pg_temp.designate('CP-C', 'Tarifa bancária', null, 100, 'e-des-fee')$$, 'P0001', 'CUTOVER_TARGET_NOT_EXPENSE', 'a fee is not an operating expense target');
select throws_ok($$select pg_temp.designate('CP-C', 'Linha sem turma', null, 100, 'e-des-global')$$, 'P0001', 'CUTOVER_TARGET_NOT_IN_COHORT',
  'a PicPay line without cohort is never a target (the designation never attributes it)');
select throws_ok($$select pg_temp.designate('CP-C', 'Fornecedor Mariana', null, 50, 'e-des-amount')$$, 'P0001', 'CUTOVER_COUNTERPART_AMOUNT_MISMATCH',
  'the counterpart is consumed whole');
select throws_ok($$select pg_temp.designate('CUTOVER-MARIANA-PAGO', 'Fornecedor Mariana', null, 57050, 'e-des-dup')$$, 'P0001', 'CUTOVER_COUNTERPART_ALREADY_DESIGNATED',
  'a counterpart has one active designation');
select throws_ok($$select pg_temp.designate('LUCAS-PEDIDO', 'Fornecedor Mariana', null, 100000, 'e-des-expense')$$, 'P0001', 'CUTOVER_COUNTERPART_NOT_ELIGIBLE',
  'an expense is not a counterpart');
select is(pg_temp.designate('CUTOVER-MARIANA-PAGO', 'Fornecedor Mariana', null, 57050, 'e-des-m') ->> 'id', (select result ->> 'id' from mariana), 'a replay returns the same designation');
select pg_temp.ctx(pg_temp.seller(), pg_temp.a()::text);
select throws_ok($$select pg_temp.designate('CP-C', 'Fornecedor Mariana', null, 100, 'e-des-seller')$$, '42501', 'FINANCE_MANAGE_REQUIRED', 'a seller cannot designate');
select pg_temp.ctx(pg_temp.master(), 'all');
select throws_ok($$select pg_temp.designate('CP-C', 'Fornecedor Mariana', null, 100, 'e-des-all')$$, '22023', 'COHORT_REQUIRED', '"Todas as turmas" cannot designate');
select pg_temp.ctx(pg_temp.admin(), pg_temp.a()::text);

-- 6. Revocation: append-only, the presentation goes back, a new designation is allowed --------------------------------
create temp table designation_a as select (select (item ->> 'id')::uuid from jsonb_array_elements(public.list_cutover_counterparts() -> 'items') item
  where item #>> '{counterpart,reference}' = 'CP-A') as id;
grant select on designation_a to authenticated;
select is(public.revoke_cutover_counterpart((select id from designation_a), 'Contrapartida vinculada por engano', 'e-rev-a', gen_random_uuid()) ->> 'status', 'REVOGADA',
  'the designation is revoked');
select is(pg_temp.show(pg_temp.today() - 6, pg_temp.today() - 6, 'technical_cutover_counterparts_cents'), 60000::bigint, 'the presentation goes back for it');
select throws_ok($$select public.revoke_cutover_counterpart((select id from designation_a), 'Revogar de novo', 'e-rev-a2', gen_random_uuid())$$, 'P0001',
  'CUTOVER_COUNTERPART_ALREADY_REVOKED', 'revoked once');
reset role;
select is((select count(*)::integer from cohort_data.finance_cutover_counterparts where id = (select id from designation_a)), 1, 'the original designation is kept');
select ok(exists (select 1 from cohort_data.finance_cutover_counterpart_revocations revocation where revocation.designation_id = (select id from designation_a)
  and revocation.revoked_by = pg_temp.admin() and revocation.reason = 'Contrapartida vinculada por engano'), 'the revocation records who and why');
select pg_temp.ctx(pg_temp.admin(), pg_temp.a()::text);
select lives_ok($$select pg_temp.designate('CP-A', null, 'LUCAS-PEDIDO', 40000, 'e-des-a-again')$$, 'after revocation, a new designation is allowed');

-- 7. A target that changes stops applying (flagged, never netted silently) ---------------------------------------------
select public.reverse_finance_entry(pg_temp.entry('LUCAS-PEDIDO'), 'Pedido estornado no teste', 'e-reverse-t', gen_random_uuid());
select is(pg_temp.show(pg_temp.today() - 6, pg_temp.today() - 6, 'technical_cutover_counterparts_cents') || '/'
  || pg_temp.show(pg_temp.today() - 6, pg_temp.today() - 6, 'invalid_designations'), '0/2', 'a reversed target: the designations stop applying and are flagged');
select is((select count(*)::integer from jsonb_array_elements(public.list_cutover_counterparts() -> 'items') item where item ->> 'status' = 'INVALIDA'), 2,
  'listed as INVALIDA for review');

-- 8. Audit and idempotency ---------------------------------------------------------------------------------------------
reset role;
select is((select count(*)::integer from public.audit_logs where action = 'finance.cutover_counterpart.designated'), 4, 'every designation is audited once');
select is((select count(*)::integer from public.audit_logs where action = 'finance.historical_adjustment.recorded'), 2, 'every adjustment is audited once');
select ok((select bool_and(cohort_id = pg_temp.a()) from public.audit_logs where action like 'finance.cutover_counterpart.%' or action like 'finance.historical_adjustment.%'),
  'the audit belongs to the cohort');
select pg_temp.ctx(pg_temp.admin(), pg_temp.a()::text);

-- 9. Goal: net available resources -------------------------------------------------------------------------------------
create temp table goal as select public.configure_fundraising_goal(1000000, pg_temp.today() - 10, pg_temp.today() + 20, false, true, 'e-goal', gen_random_uuid()) as result;
grant select on goal to authenticated;
select is((select result ->> 'basis' from goal), 'NET_AVAILABLE', 'the goal measures net available resources');
select is((select (result ->> 'committed_cents')::bigint from goal), 57050::bigint, 'the open payable is committed');
select is((select (result ->> 'current_cents')::bigint from goal), pg_temp.real() - 57050, 'net available = real accounts − open payables');
select is((select (result ->> 'accumulated_cents')::bigint from goal), pg_temp.real(), 'accumulated = PicPay free + Cofrinho + physical cash');
select isnt((select result -> 'operating_result_since_cents' from goal), 'null'::jsonb, 'the result since the start is its own indicator');

-- 10. Bridge and overview ----------------------------------------------------------------------------------------------
create temp table overview as select public.finance_overview(pg_temp.today() - 40, pg_temp.today()) as result;
grant select on overview to authenticated;
select is((select (result #>> '{bridge,part_a,residual_cents}')::bigint from overview), 0::bigint, 'the bridge closes with no residual');
select is((select (result #>> '{result,historical_cents}')::bigint from overview), (select (result #>> '{result,totals,operating_profit_cents}')::bigint from overview),
  'before native operation, the whole result is historical');
select is((select (result #>> '{result,native_cents}') from overview), null, 'and nothing is native yet');
select is((select (result #>> '{result,cost_visibility,status}') from overview), 'COMPLETO', 'no sale of unknown cost: COGS complete');
select ok((select jsonb_array_length(result -> 'counterparts') from overview) >= 1, 'the counterparts of the window are listed for the detail');
select throws_ok($$select public.finance_overview(pg_temp.today(), pg_temp.today() - 1)$$, '22023', 'INVALID_FINANCE_OVERVIEW_PERIOD', 'the period must be valid');
select pg_temp.ctx(pg_temp.seller(), pg_temp.a()::text);
select throws_ok($$select public.finance_overview(pg_temp.today() - 1, pg_temp.today())$$, '42501', 'FINANCE_MANAGE_REQUIRED', 'sellers do not read the overview');

-- 11. Another cohort sees none of it --------------------------------------------------------------------------------
select pg_temp.ctx(pg_temp.master(), pg_temp.id('cohort_b')::text);
select is(jsonb_array_length(public.list_cutover_counterparts() -> 'items'), 0, 'cohort B sees no designation of A');
select is(jsonb_array_length(public.list_finance_historical_adjustments() -> 'items'), 0, 'cohort B sees no adjustment of A');
select is((pg_temp.ind(pg_temp.today() - 40, pg_temp.today()) #>> '{totals,historical_adjustments_cents}')::bigint, 0::bigint, 'and no historical adjustment counts in B');

select * from finish();
rollback;
