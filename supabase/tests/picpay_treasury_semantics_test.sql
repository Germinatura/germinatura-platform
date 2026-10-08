-- Spec 5.8 (FIN-002, FIN-003, FIN-007): treasury is separate from classification. A canonical PicPay statement line
-- moves the bank account exactly once, from the import on; classifying, linking or marking it as already recorded never
-- counts the same money twice. Synthetic files only, dates relative to today (São Paulo).
begin;
select plan(34);

create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;
create function pg_temp.day(p_offset integer) returns date language sql as $$ select pg_temp.today() + p_offset $$;
create function pg_temp.csv(p_lines text[]) returns text language sql as $$
  select 'data;movimento;descrição;tipo;valor' || E'\n' || array_to_string(p_lines, E';\r\n') || E';\r\n' $$;
create function pg_temp.stmt(p_day date, p_movement text, p_description text, p_cents bigint) returns text language sql as $$
  select to_char(p_day, 'YYYY-MM-DD') || ';' || p_movement || ';' || p_description || ';' || case when p_cents > 0 then 'Entrada' else 'Saída' end
    || ';' || case when p_cents < 0 then '-' else '' end || (abs(p_cents) / 100)::text || '.' || lpad((abs(p_cents) % 100)::text, 2, '0') $$;
create function pg_temp.balance(p_account text) returns bigint language sql security definer as $$
  select balance_cents from private.finance_account_balances(pg_temp.today()) where account::text = p_account $$;
create function pg_temp.indicator(p_key text) returns bigint language sql security definer as $$
  select (private.compute_management_indicators(pg_temp.day(-40), pg_temp.today()) -> 'totals' ->> p_key)::bigint $$;
create function pg_temp.line_id(p_description text) returns uuid language sql security definer as $$
  select id from public.picpay_statement_lines where description = p_description order by line_number limit 1 $$;
create function pg_temp.entry_id(p_description text) returns uuid language sql security definer as $$
  select id from public.finance_manual_entries where description = p_description $$;
create function pg_temp.import(p_name text, p_lines text[]) returns jsonb language sql as $$
  select public.import_picpay_file(p_name, pg_temp.csv(p_lines), 'treasury-' || p_name, gen_random_uuid()) $$;
create temp table snapshot(label text primary key, free bigint, vault bigint);
create function pg_temp.snap(p_label text) returns void language sql security definer as $$
  insert into snapshot values (p_label, pg_temp.balance('PICPAY_EMPRESAS'), pg_temp.balance('COFRINHO_PICPAY')) $$;
create function pg_temp.free_since(p_label text) returns bigint language sql security definer as $$
  select pg_temp.balance('PICPAY_EMPRESAS') - free from snapshot where label = p_label $$;
grant all on snapshot to authenticated;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';

-- 1. Opening: free 0, Cofrinho 111,78; native operation from 30 days ago.
select lives_ok($$select public.record_finance_opening_position(pg_temp.day(-40), pg_temp.day(-30), 0, 11178, 0, 0,
  'Abertura sintética', null, null, 'treasury-opening', gen_random_uuid())$$, 'the opening position is recorded');
select is(pg_temp.balance('PICPAY_EMPRESAS'), 0::bigint, 'free balance starts at zero');
select is(pg_temp.balance('COFRINHO_PICPAY'), 11178::bigint, 'the Cofrinho starts at 111,78');

-- 2. A Pix sent, still unclassified, already left the bank.
select pg_temp.snap('start');
select lives_ok($$select pg_temp.import('pix-enviado.csv', array[pg_temp.stmt(pg_temp.day(-3), 'Pix enviado', 'Papelaria Tesouraria', -10000)])$$,
  'a Pix sent is imported');
select is(pg_temp.free_since('start'), -10000::bigint, 'the unclassified Pix sent moves the free balance by −100,00');
select is(pg_temp.indicator('operating_expenses_cents'), 0::bigint, 'and is not an expense yet');

-- 3. Classifying it changes the reason, never the balance.
select pg_temp.snap('before-classify');
select lives_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'MATERIAIS', null, null, null, 'treasury-classify', gen_random_uuid())$$,
  pg_temp.line_id('Papelaria Tesouraria')), 'the Pix sent is classified as materials');
select is(pg_temp.free_since('before-classify'), 0::bigint, 'classifying does not move the balance');
select is(pg_temp.indicator('operating_expenses_cents'), 10000::bigint, 'the classification makes it a 100,00 expense');

-- 4. A line linked to the record that already carries the money counts once.
select lives_ok($$select public.record_finance_entry('EXPENSE', 'TRANSPORTE', 'PICPAY_EMPRESAS', null, 5000, pg_temp.day(-2),
  'Frete pago pela comissão', null, 'treasury-entry', gen_random_uuid())$$, 'a manual expense is recorded from the PicPay account');
select pg_temp.snap('before-link');
select lives_ok($$select pg_temp.import('frete.csv', array[pg_temp.stmt(pg_temp.day(-2), 'Pix enviado', 'Frete Tesouraria', -5000)])$$,
  'its bank line arrives');
select is(pg_temp.free_since('before-link'), -5000::bigint, 'until linked, the bank line moves the account like any unclassified line');
select lives_ok(format($$select public.link_picpay_statement_line(%L, null, pg_temp.entry_id('Frete pago pela comissão'),
  'Mesmo frete do lançamento manual', 'treasury-link', gen_random_uuid())$$, pg_temp.line_id('Frete Tesouraria')), 'the line is linked to the manual expense');
select is(pg_temp.free_since('before-link'), 0::bigint, 'linked: the payment counts exactly once (the manual entry carries it)');

-- 5. Already recorded: the record elsewhere carries it, the line adds nothing on top.
select lives_ok($$select public.record_finance_entry('EXPENSE', 'OUTROS', 'PICPAY_EMPRESAS', null, 3000, pg_temp.day(-2),
  'Taxa bancária registrada', null, 'treasury-entry-2', gen_random_uuid())$$, 'another expense is recorded from the PicPay account');
select pg_temp.snap('before-known');
select lives_ok($$select pg_temp.import('taxa.csv', array[pg_temp.stmt(pg_temp.day(-2), 'Pix enviado', 'Taxa Tesouraria', -3000)])$$, 'its bank line arrives');
select lives_ok(format($$select public.resolve_picpay_statement_line(%L, 'JA_REGISTRADO', null, null, null, 'Lançada como taxa bancária', 'treasury-known', gen_random_uuid())$$,
  pg_temp.line_id('Taxa Tesouraria')), 'the line is marked as already recorded');
select is(pg_temp.free_since('before-known'), 0::bigint, 'already recorded: no second outflow');

-- 6 and 7. A returned Pix comes back to the bank before and after its classification.
select pg_temp.snap('before-return');
select lives_ok($$select pg_temp.import('devolvido.csv', array[pg_temp.stmt(pg_temp.day(-1), 'Pix devolvido', 'Fornecedor Tesouraria', 2000)])$$, 'a returned Pix arrives');
select is(pg_temp.free_since('before-return'), 2000::bigint, 'the returned Pix is +20,00 in the bank before any category');
select lives_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'FORNECEDOR', null, null, null, 'treasury-return', gen_random_uuid())$$,
  pg_temp.line_id('Fornecedor Tesouraria')), 'the returned Pix is classified');
select is(pg_temp.free_since('before-return'), 2000::bigint, 'and stays +20,00 after the classification');

-- 8 and 9. Internal transfers stay neutral; settled receivables are not revenue again.
select pg_temp.snap('before-transfers');
create temp table revenue_before as select pg_temp.indicator('gross_revenue_cents') as cents;
select lives_ok($$select pg_temp.import('transferencias.csv', array[pg_temp.stmt(pg_temp.day(-1), 'Dinheiro guardado', 'Cofrinho', -500),
  pg_temp.stmt(pg_temp.day(-1), 'Recebíveis de venda', 'Recebíveis', 900)])$$, 'a Cofrinho deposit and a receivables settlement arrive');
select is((select pg_temp.balance('PICPAY_EMPRESAS') + pg_temp.balance('COFRINHO_PICPAY') - free - vault from snapshot where label = 'before-transfers'),
  900::bigint, 'free + Cofrinho moves only by the settlement: the Cofrinho deposit is neutral');
select is(pg_temp.indicator('gross_revenue_cents'), (select cents from revenue_before), 'the receivables settlement is not new revenue');

-- 10 to 12. Overlapping exports and legitimate identical lines.
select pg_temp.snap('before-twins');
select lives_ok($$select pg_temp.import('gemeos.csv', array[pg_temp.stmt(pg_temp.day(-1), 'Pix enviado', 'Gêmeo Tesouraria', -700),
  pg_temp.stmt(pg_temp.day(-1), 'Pix enviado', 'Gêmeo Tesouraria', -700)])$$, 'two identical Pix sent arrive');
select is(pg_temp.free_since('before-twins'), -1400::bigint, 'two legitimate identical lines count twice');
select is((select (result ->> 'new_count')::integer from (select pg_temp.import('gemeos-sobreposto.csv', array[
  pg_temp.stmt(pg_temp.day(-1), 'Pix enviado', 'Gêmeo Tesouraria', -700), pg_temp.stmt(pg_temp.day(-1), 'Pix enviado', 'Gêmeo Tesouraria', -700),
  pg_temp.stmt(pg_temp.day(-1), 'Dinheiro guardado', 'Cofrinho', -500)]) as result) overlap), 0, 'an overlapping export brings nothing new');
select is(pg_temp.free_since('before-twins'), -1400::bigint, 'the reimport keeps two, never four, and moves nothing');

-- Items: an unclassified line is treated by reviewing it, never silenced; old decisions stay history only.
select throws_ok(format($$select public.resolve_picpay_exception(%L, 'RESOLVIDA', 'Silenciar a linha', 'treasury-silence', gen_random_uuid())$$,
  'EXTRATO_NAO_CLASSIFICADO:' || pg_temp.line_id('Gêmeo Tesouraria')), 'P0001', 'PICPAY_EXCEPTION_REQUIRES_LINE_REVIEW',
  'an unclassified statement line cannot be resolved without reviewing it');
reset role;
-- A decision recorded before this rule (history, as production may hold) no longer hides the open line.
insert into public.picpay_exception_resolutions (exception_key, action, reason, actor_id, correlation_id)
values ('EXTRATO_NAO_CLASSIFICADO:' || pg_temp.line_id('Gêmeo Tesouraria'), 'RESOLVIDA', 'Decisão anterior à regra',
  '10000000-0000-4000-8000-000000000001', gen_random_uuid());
select ok((select not resolved from private.picpay_exceptions() where exception_key = 'EXTRATO_NAO_CLASSIFICADO:' || pg_temp.line_id('Gêmeo Tesouraria')),
  'an earlier manual decision does not hide a line still waiting for review');
set local role authenticated;

-- Status: a line waiting for review keeps the period open, and items outside the period are reported.
select is((public.picpay_reconciliation_summary(pg_temp.day(-1), pg_temp.day(-1)) ->> 'status'), 'COM_PENDENCIAS',
  'a period with a line waiting for review is never CONCILIADO');
reset role;
create temp table pending_before_today as select count(*)::integer as lines from public.picpay_statement_lines line
  left join private.picpay_statement_current_resolutions current on current.line_id = line.id
  where (current.id is null or current.resolution = 'REABERTA') and line.occurred_on < pg_temp.today();
grant select on pending_before_today to authenticated;
set local role authenticated;
select ok((select lines from pending_before_today) >= 2, 'lines are waiting for review before today');
select is((public.picpay_reconciliation_summary(pg_temp.today(), pg_temp.today()) -> 'statement' ->> 'pending_outside_period')::integer,
  (select lines from pending_before_today), 'every line waiting for review outside the period is reported');

select * from finish();
rollback;
