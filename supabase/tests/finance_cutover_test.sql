-- Spec 5.8 (FIN-002, FIN-003, FIN-007): opening position, the single balance authority, the PicPay cutover
-- (historical revenue, historical receivables, link, already recorded, bulk classification) and the balance check.
-- Dates are relative to today (São Paulo): opening 30 days ago, native operation from 3 days ago.
begin;
select plan(94);

create function pg_temp.money(p_cents bigint) returns text language sql as $$
  select case when p_cents < 0 then '-' else '' end || (abs(p_cents) / 100)::text || '.' || lpad((abs(p_cents) % 100)::text, 2, '0') $$;
create function pg_temp.csv(p_lines text[]) returns text language sql as $$
  select 'data;movimento;descrição;tipo;valor' || E'\n' || coalesce(string_agg(line || E';\r\n', '' order by ordinality), '')
  from unnest(p_lines) with ordinality line $$;
create function pg_temp.opening_on() returns date language sql as $$ select (now() at time zone 'America/Sao_Paulo')::date - 30 $$;
create function pg_temp.operating_since() returns date language sql as $$ select (now() at time zone 'America/Sao_Paulo')::date - 3 $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;
-- A statement line `p_offset` days after the opening day.
create function pg_temp.line(p_offset integer, p_movement text, p_description text, p_cents bigint) returns text language sql as $$
  select to_char(pg_temp.opening_on() + p_offset, 'YYYY-MM-DD') || ';' || p_movement || ';' || p_description || ';'
    || case when p_cents > 0 then 'Entrada' else 'Saída' end || ';' || pg_temp.money(p_cents) $$;
create function pg_temp.balance(p_as_of date, p_key text) returns bigint language sql as $$
  select (public.finance_balances(p_as_of) ->> p_key)::bigint $$;
create function pg_temp.indicator(p_key text) returns bigint language sql as $$
  select (public.management_indicators(pg_temp.opening_on(), pg_temp.today()) -> 'totals' ->> p_key)::bigint $$;

select ok(not has_function_privilege('anon', 'public.record_finance_opening_position(date,date,bigint,bigint,bigint,bigint,text,text,uuid,text,uuid)', 'EXECUTE'),
  'anonymous cannot record the opening position');
select ok(not has_function_privilege('authenticated', 'private.finance_account_balances(date)', 'EXECUTE'), 'the balance authority is private');
select ok(not has_function_privilege('anon', 'public.resolve_picpay_statement_lines_bulk(uuid,public.picpay_statement_movement,date,date,uuid[],public.finance_category,text,integer,bigint,text,text,uuid)', 'EXECUTE'),
  'anonymous cannot classify in bulk');
select ok(not has_function_privilege('anon', 'public.record_finance_balance_check(date,bigint,bigint,text,text,uuid)', 'EXECUTE'),
  'anonymous cannot record a balance check');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.operating_since(), 0, 1178, 0, 0, 'Abertura', null, null, 'open-seller', gen_random_uuid())$$,
  '42501', 'FINANCE_MANAGE_REQUIRED', 'a seller cannot record the opening position');
select throws_ok($$select public.finance_balances(null)$$, '42501', 'FINANCE_MANAGE_REQUIRED', 'a seller cannot read balances');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';

-- Opening position: its own concept, immutable, versioned.
select throws_ok($$select public.record_finance_opening_position(pg_temp.operating_since(), pg_temp.opening_on(), 0, 1178, 0, 0, 'Abertura', null, null, 'open-dates', gen_random_uuid())$$,
  '22023', 'INVALID_OPENING_POSITION', 'native operation must start after the opening day');
select throws_ok($$select public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.operating_since(), -1, 1178, 0, 0, 'Abertura', null, null, 'open-negative', gen_random_uuid())$$,
  '22023', 'INVALID_OPENING_POSITION', 'an opening amount cannot be negative');
create temp table opening as select public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.operating_since(), 0, 1178, 0, 0,
  'Posição de abertura do cutover PicPay', null, null, 'open-v1', gen_random_uuid()) result;
select is((select (result ->> 'version')::integer from opening), 1, 'the first opening position is version 1');
select is((select result -> 'accounts' from opening),
  '{"PICPAY_EMPRESAS": 0, "COFRINHO_PICPAY": 1178, "RECEBIVEIS_PICPAY": 0, "DINHEIRO_FISICO": 0}'::jsonb, 'the opening position records every account');
select is(public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.operating_since(), 0, 1178, 0, 0,
  'Posição de abertura do cutover PicPay', null, null, 'open-v1', gen_random_uuid()) ->> 'id', (select result ->> 'id' from opening),
  'replaying the key returns the same opening position');
select throws_ok($$select public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.operating_since(), 0, 1178, 0, 0, 'Outra abertura', null, null, 'open-again', gen_random_uuid())$$,
  'P0001', 'OPENING_POSITION_ALREADY_RECORDED', 'a second opening position cannot be recorded by accident');
select throws_ok($$select public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.operating_since(), 0, 1178, 0, 0, 'Correção', 'Valor conferido de novo', gen_random_uuid(), 'open-stale', gen_random_uuid())$$,
  'P0001', 'OPENING_POSITION_STALE', 'a correction must supersede the current version');
select throws_ok(format($$select public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.operating_since(), 0, 1178, 0, 0, 'Correção', null, %L, 'open-no-reason', gen_random_uuid())$$,
  (select result ->> 'id' from opening)), '22023', 'INVALID_OPENING_POSITION', 'a correction needs a reason');
reset role;
select throws_ok($$update public.finance_opening_position_lines set amount_cents = 1 where account = 'PICPAY_EMPRESAS'$$,
  'P0001', 'IMMUTABLE_RECORD', 'the opening position is immutable');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';

-- Tests 1 and 2: the opening composes the balance; free R$ 0,00, Cofrinho R$ 11,78.
select is(pg_temp.balance(pg_temp.opening_on(), 'free_balance_cents'), 0::bigint, 'opening day: free balance is zero');
select is(pg_temp.balance(pg_temp.opening_on(), 'vault_balance_cents'), 1178::bigint, 'opening day: Cofrinho holds the opening amount');
select is(pg_temp.balance(pg_temp.opening_on(), 'available_balance_cents'), 1178::bigint, 'available balance is free plus Cofrinho');
select is((select jsonb_agg(row ->> 'nature') from jsonb_array_elements(public.finance_statement(pg_temp.opening_on(), pg_temp.today()) -> 'rows') row
  where row ->> 'source' = 'OPENING'), '["SALDO_ABERTURA"]'::jsonb, 'the statement shows the opening position as such');
select is((public.finance_statement(pg_temp.opening_on(), pg_temp.today()) -> 'totals' ->> 'inflow_cents')::bigint, 0::bigint,
  'the opening position is not an inflow');

-- Test 3: the opening position is not revenue, expense, result or goal progress.
select is(pg_temp.indicator('gross_revenue_cents'), 0::bigint, 'the opening position is not revenue');
select is(pg_temp.indicator('operating_expenses_cents'), 0::bigint, 'the opening position is not an expense');
select is(pg_temp.indicator('operating_profit_cents'), 0::bigint, 'the opening position is not result');
select lives_ok($$select public.configure_fundraising_goal(100000, pg_temp.opening_on(), pg_temp.today() + 30, true, true, 'cut-goal', gen_random_uuid())$$,
  'finance sets a goal counting from the opening day');
select is((public.get_fundraising_goal_admin() ->> 'current_cents')::bigint, 0::bigint, 'the opening position is not goal progress');

-- Historical statement (every line before operating_since).
create temp table hist as select public.import_picpay_statement('extrato-cutover.csv', pg_temp.csv(array[
  pg_temp.line(1, 'Pix recebido', 'Cliente A', 10000),
  pg_temp.line(2, 'Pix recebido', 'Cliente B', 10000),
  pg_temp.line(3, 'Pix recebido', 'Cliente C', 10000),
  pg_temp.line(4, 'Recebíveis de venda', 'Vendas maquininha', 5000),
  pg_temp.line(5, 'Pix enviado', 'Fornecedor X', -4000),
  pg_temp.line(6, 'Pix enviado', 'Gráfica', -2500),
  pg_temp.line(7, 'Pix enviado', 'Transporte', -3000),
  pg_temp.line(8, 'Pix estornado', 'Cliente C', -1000),
  pg_temp.line(9, 'Pix devolvido', 'Fornecedor X', 500),
  pg_temp.line(10, 'Dinheiro guardado', 'Cofrinho', -20000),
  pg_temp.line(11, 'Dinheiro resgatado', 'Cofrinho', 8000)]), false, 'cut-import', gen_random_uuid()) result;
reset role;
create temp table hist_lines as select line.line_number, line.id from public.picpay_statement_lines line
  where line.import_id = (select (result ->> 'id')::uuid from hist);
grant select on hist_lines to authenticated;
set local role authenticated;
create function pg_temp.line_id(p_number integer) returns uuid language sql as $$ select id from hist_lines where line_number = p_number $$;

select is((select (result -> 'status_counts' ->> 'TRANSFERENCIA')::integer from hist), 2, 'only the Cofrinho movements are automatic transfers');
select is((select (result -> 'status_counts' ->> 'PENDENTE_REVISAO')::integer from hist), 9, 'every other historical line waits for review');
select is((select (result ->> 'cutover_lines')::integer from hist), 11, 'every line of the file is cutover history');
-- Test 7: historical receivables are not transferred out of RECEBIVEIS_PICPAY.
reset role;
select is((select count(*) from private.picpay_statement_current_resolutions where line_id = pg_temp.line_id(5)), 0::bigint,
  'historical receivables are not transferred automatically');
set local role authenticated;
select is(pg_temp.balance(pg_temp.today(), 'receivables_balance_cents'), 0::bigint, 'the cutover import leaves no negative receivables');
reset role;
select ok((select bool_and(cutover) from public.picpay_statement_line_resolutions where line_id in (pg_temp.line_id(11), pg_temp.line_id(12))),
  'the automatic Cofrinho transfers are marked as cutover decisions');
set local role authenticated;

-- Cutover rules for one line.
select throws_ok(format($$select public.resolve_picpay_statement_line(%L, 'CONCILIAR_VENDA', null, gen_random_uuid(), null, null, 'cut-sale', gen_random_uuid())$$, pg_temp.line_id(2)),
  'P0001', 'STATEMENT_LINE_IS_CUTOVER_HISTORY', 'history is never reconciled with a sale');
select throws_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'OUTROS', null, null, null, 'cut-recv-other', gen_random_uuid())$$, pg_temp.line_id(5)),
  'P0001', 'STATEMENT_LINE_ACTION_NOT_ALLOWED', 'historical receivables are only historical revenue');
select throws_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'RECEITA_HISTORICA', null, null, null, 'cut-sent-rev', gen_random_uuid())$$, pg_temp.line_id(6)),
  'P0001', 'STATEMENT_HISTORICAL_REVENUE_NOT_ALLOWED', 'an outflow is never historical revenue');
select throws_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'RECEITA_HISTORICA', null, null, null, 'cut-back-rev', gen_random_uuid())$$, pg_temp.line_id(10)),
  'P0001', 'STATEMENT_HISTORICAL_REVENUE_NOT_ALLOWED', 'a returned payment is never historical revenue');
select throws_ok($$select public.record_finance_entry('INCOME', 'RECEITA_HISTORICA', 'PICPAY_EMPRESAS', null, 1000, pg_temp.opening_on() + 1, 'Receita histórica manual', null, 'cut-manual-rev', gen_random_uuid())$$,
  '23514', null, 'historical revenue never comes from a manual entry');

-- Bulk classification: preview, strong confirmation, recomputed under lock.
create temp table bulk_preview as select public.preview_picpay_statement_bulk((select (result ->> 'id')::uuid from hist), 'PIX_RECEBIDO', null, null, null, 'RECEITA_HISTORICA') result;
select is((select (result ->> 'count')::integer from bulk_preview), 3, 'the preview counts the selected pending lines');
select is((select (result ->> 'total_cents')::bigint from bulk_preview), 30000::bigint, 'the preview totals the selected lines');
select is((select result -> 'refusals' from bulk_preview), '[]'::jsonb, 'historical Pix received may be historical revenue');
select is((public.preview_picpay_statement_bulk((select (result ->> 'id')::uuid from hist), 'PIX_ENVIADO', null, null, null, 'RECEITA_HISTORICA')
  -> 'refusals' -> 0 ->> 'count')::integer, 3, 'the preview tells which lines may not take the category');
select is((public.preview_picpay_statement_bulk((select (result ->> 'id')::uuid from hist), 'COFRINHO_GUARDADO', null, null, null, 'OUTROS')
  ->> 'count')::integer, 0, 'automatic Cofrinho transfers are never in a bulk selection');
select throws_ok($$select public.resolve_picpay_statement_lines_bulk((select (result ->> 'id')::uuid from hist), 'PIX_ENVIADO', null, null, null, 'RECEITA_HISTORICA',
  'Cutover: tentativa inválida', 3, -9500, (select public.preview_picpay_statement_bulk((select (result ->> 'id')::uuid from hist), 'PIX_ENVIADO', null, null, null, 'RECEITA_HISTORICA') ->> 'selection_sha256'),
  'cut-bulk-bad', gen_random_uuid())$$, 'P0001', 'STATEMENT_BULK_SELECTION_INELIGIBLE', 'a bulk with an ineligible line is refused whole');
select throws_ok($$select public.resolve_picpay_statement_lines_bulk((select (result ->> 'id')::uuid from hist), 'PIX_RECEBIDO', null, null, null, 'RECEITA_HISTORICA',
  'Cutover: Pix históricos', 2, 30000, (select result ->> 'selection_sha256' from bulk_preview), 'cut-bulk-count', gen_random_uuid())$$,
  'P0001', 'STATEMENT_BULK_SELECTION_CHANGED', 'a bulk whose count differs from the preview is refused');
create temp table bulk_done as select public.resolve_picpay_statement_lines_bulk((select (result ->> 'id')::uuid from hist), 'PIX_RECEBIDO', null, null, null,
  'RECEITA_HISTORICA', 'Cutover: Pix recebidos históricos', 3, 30000, (select result ->> 'selection_sha256' from bulk_preview), 'cut-bulk', gen_random_uuid()) result;
select is((select (result ->> 'count')::integer from bulk_done), 3, 'the bulk classifies the previewed lines');
-- Test 8: the bulk is idempotent.
select is((public.resolve_picpay_statement_lines_bulk((select (result ->> 'id')::uuid from hist), 'PIX_RECEBIDO', null, null, null,
  'RECEITA_HISTORICA', 'Cutover: Pix recebidos históricos', 3, 30000, (select result ->> 'selection_sha256' from bulk_preview), 'cut-bulk', gen_random_uuid())) ->> 'bulk_id',
  (select result ->> 'bulk_id' from bulk_done), 'replaying the bulk returns the same result');
reset role;
select is((select count(*) from public.picpay_statement_line_resolutions where bulk_id = (select (result ->> 'bulk_id')::uuid from bulk_done)), 3::bigint,
  'the replay adds no decision');
set local role authenticated;
select throws_ok($$select public.resolve_picpay_statement_lines_bulk((select (result ->> 'id')::uuid from hist), 'PIX_RECEBIDO', null, null, null, 'RECEITA_HISTORICA',
  'Cutover: Pix recebidos históricos', 3, 30000, (select result ->> 'selection_sha256' from bulk_preview), 'cut-bulk-again', gen_random_uuid())$$,
  'P0001', 'STATEMENT_BULK_SELECTION_CHANGED', 'the same selection cannot be classified twice');
reset role;
select ok((select bool_and(cutover and category = 'RECEITA_HISTORICA' and not automatic) from public.picpay_statement_line_resolutions
  where bulk_id = (select (result ->> 'bulk_id')::uuid from bulk_done)), 'every line keeps its own cutover decision');
select is((select count(*) from public.audit_logs where action = 'finance.statement.lines_bulk_resolved'
  and metadata ->> 'bulk_id' = (select result ->> 'bulk_id' from bulk_done)), 1::bigint, 'the bulk is audited once, with its totals');
set local role authenticated;

-- Historical receivables become historical revenue, keeping their bank origin.
select is((public.resolve_picpay_statement_lines_bulk((select (result ->> 'id')::uuid from hist), null, null, null, array[pg_temp.line_id(5)],
  'RECEITA_HISTORICA', 'Cutover: recebíveis históricos', 1, 5000,
  (select public.preview_picpay_statement_bulk((select (result ->> 'id')::uuid from hist), null, null, null, array[pg_temp.line_id(5)], 'RECEITA_HISTORICA') ->> 'selection_sha256'),
  'cut-bulk-recv', gen_random_uuid()) ->> 'count')::integer, 1, 'historical receivables are classified as historical revenue');
select is((select row ->> 'description' from jsonb_array_elements(public.finance_statement(pg_temp.opening_on(), pg_temp.today()) -> 'rows') row
  where row ->> 'source_id' = pg_temp.line_id(5)::text), 'Recebíveis de venda (histórico do cutover)', 'the statement keeps the receivables origin');

-- Pix enviado: classified, linked to the manual entry that already paid it, or marked as already recorded.
select lives_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'FORNECEDOR', null, null, null, 'cut-sent-classify', gen_random_uuid())$$, pg_temp.line_id(6)),
  'a historical Pix sent is classified as an expense');
create temp table graphic as select public.record_finance_entry('EXPENSE', 'MATERIAIS', 'PICPAY_EMPRESAS', null, 2500, pg_temp.opening_on() + 6,
  'Impressão de rifas', null, 'cut-graphic', gen_random_uuid()) result;
select lives_ok($$select public.record_finance_entry('EXPENSE', 'TRANSPORTE', 'PICPAY_EMPRESAS', null, 3000, pg_temp.opening_on() + 7,
  'Frete do evento', null, 'cut-freight', gen_random_uuid())$$, 'the freight was recorded as a manual entry');
select is((select jsonb_agg(candidate ->> 'id') from jsonb_array_elements(public.list_statement_link_candidates(pg_temp.line_id(7))) candidate),
  jsonb_build_array((select result ->> 'id' from graphic)), 'the link candidates have the same effect on PicPay Empresas');
select throws_ok(format($$select public.link_picpay_statement_line(%L, null, %L, null, 'cut-link-wrong', gen_random_uuid())$$, pg_temp.line_id(8), (select result ->> 'id' from graphic)),
  'P0001', 'STATEMENT_AMOUNT_MISMATCH', 'a link needs the same amount');
select lives_ok(format($$select public.link_picpay_statement_line(%L, null, %L, 'Mesma impressão', 'cut-link', gen_random_uuid())$$, pg_temp.line_id(7), (select result ->> 'id' from graphic)),
  'a Pix sent is linked to the manual entry that already carries it');
select is(public.list_statement_link_candidates(pg_temp.line_id(7)), '[]'::jsonb, 'a linked record is not offered again');
select lives_ok(format($$select public.resolve_picpay_statement_line(%L, 'JA_REGISTRADO', null, null, null, 'Frete lançado manualmente', 'cut-already', gen_random_uuid())$$, pg_temp.line_id(8)),
  'a Pix sent is marked as already recorded');
select lives_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'RECEITA_HISTORICA', null, null, null, 'cut-reversal', gen_random_uuid())$$, pg_temp.line_id(9)),
  'a historical Pix reversal lowers historical revenue');
select lives_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'FORNECEDOR', null, null, null, 'cut-returned', gen_random_uuid())$$, pg_temp.line_id(10)),
  'a returned supplier payment lowers the expense');

-- Test 10: linked and already recorded lines add nothing; their records count once.
select is((select count(*) from jsonb_array_elements(public.finance_statement(pg_temp.opening_on(), pg_temp.today()) -> 'rows') row
  where row ->> 'source_id' in (pg_temp.line_id(7)::text, pg_temp.line_id(8)::text)), 0::bigint, 'linked and already recorded lines have no effect of their own');
select is(pg_temp.indicator('operating_expenses_cents'), 9000::bigint, 'every expense counts once: 25 + 30 manual, 40 − 5 classified');

-- Every line is decided; balances close exactly.
reset role;
select is((select count(*) from hist_lines line left join private.picpay_statement_current_resolutions current on current.line_id = line.id
  where current.id is null or current.resolution = 'REABERTA'), 0::bigint, 'no line is left pending');
set local role authenticated;
select is(pg_temp.balance(pg_temp.today(), 'free_balance_cents'), 13000::bigint, 'free: 300 + 50 − 40 − 25 − 30 − 10 + 5 − 200 + 80');
select is(pg_temp.balance(pg_temp.today(), 'vault_balance_cents'), 13178::bigint, 'Cofrinho: 11,78 + 200 − 80');
select is(pg_temp.balance(pg_temp.today(), 'available_balance_cents'), 26178::bigint, 'available: free plus Cofrinho');
select is(pg_temp.balance(pg_temp.today(), 'receivables_balance_cents'), 0::bigint, 'receivables stay at zero');
select is(public.finance_balances(pg_temp.today()) -> 'negative_accounts', '[]'::jsonb, 'no account is negative');
select is(public.finance_balances(pg_temp.today()) -> 'statement_lines',
  '{"pending": {"count": 0, "net_cents": 0}, "already_recorded": {"count": 1, "net_cents": -3000}, "linked": {"count": 1, "net_cents": -2500}}'::jsonb,
  'the lines without an effect of their own are reported');

-- Tests 4 and 5: guardar and resgatar move money between free and Cofrinho; the total does not change.
select is(pg_temp.balance(pg_temp.opening_on() + 10, 'free_balance_cents') - pg_temp.balance(pg_temp.opening_on() + 9, 'free_balance_cents'), -20000::bigint,
  'guardar lowers the free balance');
select is(pg_temp.balance(pg_temp.opening_on() + 10, 'vault_balance_cents') - pg_temp.balance(pg_temp.opening_on() + 9, 'vault_balance_cents'), 20000::bigint,
  'guardar raises the Cofrinho');
select is(pg_temp.balance(pg_temp.opening_on() + 10, 'available_balance_cents'), pg_temp.balance(pg_temp.opening_on() + 9, 'available_balance_cents'),
  'guardar keeps the total');
select is(pg_temp.balance(pg_temp.opening_on() + 11, 'free_balance_cents') - pg_temp.balance(pg_temp.opening_on() + 10, 'free_balance_cents'), 8000::bigint,
  'resgatar raises the free balance');
select is(pg_temp.balance(pg_temp.opening_on() + 11, 'vault_balance_cents') - pg_temp.balance(pg_temp.opening_on() + 10, 'vault_balance_cents'), -8000::bigint,
  'resgatar lowers the Cofrinho');
select is(pg_temp.balance(pg_temp.opening_on() + 11, 'available_balance_cents'), pg_temp.balance(pg_temp.opening_on() + 10, 'available_balance_cents'),
  'resgatar keeps the total');

-- Test 11 and the goal: historical revenue counts once; transfers and the opening position never.
select is(pg_temp.indicator('gross_revenue_cents'), 34000::bigint, 'historical revenue: 300 + 50 − 10, once');
select is(pg_temp.indicator('operating_profit_cents'), 25000::bigint, 'result: historical revenue minus expenses, no transfer');
select is(pg_temp.indicator('cash_balance_cents'), 25000::bigint, 'the period cash flow ignores transfers and the opening position');
select is((public.get_fundraising_goal_admin() ->> 'current_cents')::bigint, 25000::bigint, 'the goal counts historical revenue once');
select is((select jsonb_object_agg(row ->> 'source_id', row ->> 'nature') from jsonb_array_elements(public.finance_statement(pg_temp.opening_on(), pg_temp.today()) -> 'rows') row
  where row ->> 'source_id' in (pg_temp.line_id(2)::text, pg_temp.line_id(6)::text, pg_temp.line_id(9)::text) or (row ->> 'source_id' = pg_temp.line_id(11)::text and row ->> 'account' = 'COFRINHO_PICPAY')),
  jsonb_build_object(pg_temp.line_id(2)::text, 'RECEITA', pg_temp.line_id(6)::text, 'DESPESA', pg_temp.line_id(9)::text, 'ESTORNO', pg_temp.line_id(11)::text, 'TRANSFERENCIA_INTERNA'),
  'the statement names the nature of each row');

-- Test 12: the balance check compares with the observed position and never adjusts.
select is((public.record_finance_balance_check(pg_temp.today(), 13000, 13178, 'Conferência com o app PicPay', 'cut-check-ok', gen_random_uuid())) ->> 'status',
  'CONCILIADO', 'equal figures are reconciled');
create temp table divergent as select public.record_finance_balance_check(pg_temp.today(), 13001, 13178, null, 'cut-check-diff', gen_random_uuid()) result;
select is((select result ->> 'status' from divergent), 'DIVERGENTE', 'a difference is detected');
select is((select (result ->> 'free_difference_cents')::bigint from divergent), -1::bigint, 'the free difference is computed minus observed');
select is((select (result ->> 'total_difference_cents')::bigint from divergent), -1::bigint, 'the total difference adds both accounts');
reset role;
select is((select count(*) from public.finance_manual_entries), 2::bigint, 'a difference creates no adjustment');
set local role authenticated;

-- Test 9: the same file is never imported twice.
select throws_ok($$select public.import_picpay_statement('extrato-cutover.csv', pg_temp.csv(array[
  pg_temp.line(1, 'Pix recebido', 'Cliente A', 10000), pg_temp.line(2, 'Pix recebido', 'Cliente B', 10000), pg_temp.line(3, 'Pix recebido', 'Cliente C', 10000),
  pg_temp.line(4, 'Recebíveis de venda', 'Vendas maquininha', 5000), pg_temp.line(5, 'Pix enviado', 'Fornecedor X', -4000),
  pg_temp.line(6, 'Pix enviado', 'Gráfica', -2500), pg_temp.line(7, 'Pix enviado', 'Transporte', -3000), pg_temp.line(8, 'Pix estornado', 'Cliente C', -1000),
  pg_temp.line(9, 'Pix devolvido', 'Fornecedor X', 500), pg_temp.line(10, 'Dinheiro guardado', 'Cofrinho', -20000),
  pg_temp.line(11, 'Dinheiro resgatado', 'Cofrinho', 8000)]), true, 'cut-import-again', gen_random_uuid())$$,
  'P0001', 'STATEMENT_ALREADY_IMPORTED', 'the same file is never imported twice');

-- Corrections of the opening position cannot contradict the reviewed history.
select throws_ok(format($$select public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.opening_on() + 2, 0, 1178, 0, 0, 'Correção', 'Data de início revista', %L, 'open-conflict', gen_random_uuid())$$,
  (select result ->> 'id' from opening)), 'P0001', 'OPENING_POSITION_CONFLICTS_WITH_STATEMENT', 'operating_since cannot move before historical revenue');
create temp table opening_v2 as select public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.operating_since(), 0, 1178, 0, 0,
  'Posição de abertura do cutover PicPay', 'Descrição conferida com o extrato', (select (result ->> 'id')::uuid from opening), 'open-v2', gen_random_uuid()) result;
select is((select (result ->> 'version')::integer from opening_v2), 2, 'a correction is a new version');
select is(pg_temp.balance(pg_temp.today(), 'available_balance_cents'), 26178::bigint, 'the balance follows the current version only');

-- After the cutover the normal rules apply: receivables settle receivables, and never become historical revenue.
create temp table native as select public.import_picpay_statement('extrato-operacao.csv', pg_temp.csv(array[
  to_char(pg_temp.operating_since(), 'YYYY-MM-DD') || ';Recebíveis de venda;Vendas maquininha;Entrada;20.00',
  to_char(pg_temp.operating_since(), 'YYYY-MM-DD') || ';Pix recebido;Cliente D;Entrada;7.00']), false, 'cut-native', gen_random_uuid()) result;
reset role;
create temp table native_lines as select line.line_number, line.id from public.picpay_statement_lines line
  where line.import_id = (select (result ->> 'id')::uuid from native);
grant select on native_lines to authenticated;
select is((select resolution::text || '/' || counter_account::text || '/' || cutover::text from private.picpay_statement_current_resolutions
  where line_id = (select id from native_lines where line_number = 2)), 'TRANSFERENCIA/RECEBIVEIS_PICPAY/false', 'native receivables are an automatic transfer');
set local role authenticated;
select is(pg_temp.indicator('gross_revenue_cents'), 34000::bigint, 'settled receivables add no revenue');
select throws_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'RECEITA_HISTORICA', null, null, null, 'native-rev', gen_random_uuid())$$,
  (select id from native_lines where line_number = 3)), 'P0001', 'STATEMENT_HISTORICAL_REVENUE_NOT_ALLOWED', 'a native Pix is never historical revenue');
reset role;
select throws_ok(format($$insert into public.picpay_statement_line_resolutions (line_id, resolution, category, automatic, actor_id, correlation_id)
  values (%L, 'CLASSIFICADA', 'RECEITA_HISTORICA', false, '10000000-0000-4000-8000-000000000001', gen_random_uuid())$$, (select id from native_lines where line_number = 2)),
  '23514', null, 'the database refuses historical revenue on a native line, whatever the path');
select is((select count(*) from public.audit_logs where action = 'finance.opening_position.recorded'), 2::bigint, 'every opening version is audited');

select * from finish();
rollback;
