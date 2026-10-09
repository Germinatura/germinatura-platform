-- Spec 5.8 (FIN-001, FIN-002, FIN-003, FIN-007): PicPay reconciliation across Minhas vendas, Recebíveis and Extrato,
-- with synthetic files only. Dates are relative to today (São Paulo): opening 40 days ago, native operation from 5 days ago.
begin;
select plan(69);

create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;
create function pg_temp.opening_on() returns date language sql as $$ select pg_temp.today() - 40 $$;
create function pg_temp.operating_since() returns date language sql as $$ select pg_temp.today() - 5 $$;
create function pg_temp.h(p_offset integer) returns date language sql as $$ select pg_temp.opening_on() + p_offset $$;
create function pg_temp.br(p_day date) returns text language sql as $$ select to_char(p_day, 'DD/MM/YYYY') $$;
create function pg_temp.brl(p_cents bigint) returns text language sql as $$
  select 'R$ ' || case when p_cents < 0 then '-' else '' end || (abs(p_cents) / 100)::text || ',' || lpad((abs(p_cents) % 100)::text, 2, '0') $$;
create function pg_temp.dot(p_cents bigint) returns text language sql as $$
  select case when p_cents < 0 then '-' else '' end || (abs(p_cents) / 100)::text || '.' || lpad((abs(p_cents) % 100)::text, 2, '0') $$;
create function pg_temp.sales(p_lines text[]) returns text language sql as $$
  select 'Data e hora da venda;Previsão de pagamento;Bandeira;Número do cartão;Forma de pagamento;Solução de captura;Valor da venda;'
    || 'Valor recebido comissão;Valor cancelado;Tarifa;Custo fixo;Taxa de parcelamento;Valor Líquido;Quantidade de parcelas;Status;NSU;'
    || 'Número do terminal;TID;Código de autorização;Número do pedido;Número único da transação;Pagador Picpay;Nome do comprador;Documento;'
    || 'Email;Telefone;Transação recorrente;Split;CNPJ parceiro;Valor bruto pago parceiro;Transação 3DS;ARN;' || E'\n'
    || array_to_string(p_lines, E'\n') || E'\n' $$;
-- A synthetic Minhas vendas line: sold at, forecast, method, capture, gross, fee, installment fee, cancelled, status, terminal, NSU, id.
create function pg_temp.sale(p_sold_at text, p_forecast date, p_method text, p_capture text, p_gross bigint, p_fee bigint,
  p_installment_fee bigint, p_cancelled bigint, p_status text, p_terminal text, p_nsu text, p_ref text) returns text language sql as $$
  select concat_ws(';', p_sold_at, coalesce(pg_temp.br(p_forecast), ''), case when p_method = 'Pix' then 'Pix' else 'Elo' end,
    case when p_method = 'Pix' then '' else '509431******0001' end, p_method, p_capture, pg_temp.brl(p_gross), '', pg_temp.brl(p_cancelled),
    ' ' || pg_temp.brl(p_fee), ' R$ 0,00', case when p_installment_fee > 0 then pg_temp.brl(p_installment_fee) else '' end,
    pg_temp.brl(case when p_status = 'Negada' then 0 else p_gross - p_fee - p_installment_fee - p_cancelled end), '1', p_status, p_nsu,
    p_terminal, '', '', '', p_ref, '-', 'Comprador Sintético', '000.000.000-00', 'sintetico@example.com', '(00) 0000-0000', '-', '-', '-', '-', '-', '-')
  || ';' $$;
create function pg_temp.receivables(p_lines text[]) returns text language sql as $$
  select 'Status;Tipo de Operação;Tipo de Lançamento;Pagador Picpay;Estabelecimento;Data de pagamento;Bandeira;Número da parcela;'
    || 'Quantidade de parcelas;Número do cartão;Número único da transação;Código de autorização;NSU;Valor bruto;Valor descontado;Valor líquido;'
    || 'Solução de captura;Número do terminal;TID;Número do pedido;Nome do comprador;Documento;Email;Telefone;Transação recorrente;'
    || 'Transação 3DS;Split;Valor bruto pago parceiro;' || E'\n' || array_to_string(p_lines, E'\n') || E'\n' $$;
create function pg_temp.receivable(p_payment date, p_ref text, p_gross bigint, p_discount bigint) returns text language sql as $$
  select concat_ws(';', 'Pendente', 'Crédito', 'Crédito parcelado', '-', '0000000', pg_temp.br(p_payment), 'Elo', '1', '1', '509431******0001',
    p_ref, '000000', '000000', pg_temp.brl(p_gross), pg_temp.brl(-p_discount), pg_temp.brl(p_gross - p_discount), 'PicPay Mini', '1000001',
    '-', '-', '-', '-', '-', '-', '-', '-', '-') || ';' $$;
create function pg_temp.statement(p_lines text[]) returns text language sql as $$
  select 'data;movimento;descrição;tipo;valor' || E'\n' || array_to_string(p_lines, E';\r\n') || E';\r\n' $$;
create function pg_temp.stmt(p_day date, p_movement text, p_description text, p_cents bigint) returns text language sql as $$
  select to_char(p_day, 'YYYY-MM-DD') || ';' || p_movement || ';' || p_description || ';' || case when p_cents > 0 then 'Entrada' else 'Saída' end
    || ';' || pg_temp.dot(p_cents) $$;
create function pg_temp.at(p_day date, p_time text) returns text language sql as $$ select pg_temp.br(p_day) || ' ' || p_time $$;
create function pg_temp.balance(p_account text) returns bigint language sql security definer as $$
  select balance_cents from private.finance_account_balances(pg_temp.today()) where account::text = p_account $$;
create function pg_temp.indicator(p_key text) returns bigint language sql security definer as $$
  select (private.compute_management_indicators(pg_temp.opening_on(), pg_temp.today()) -> 'totals' ->> p_key)::bigint $$;
create function pg_temp.resolution(p_movement text, p_day date) returns text language sql security definer as $$
  select string_agg(coalesce(current.resolution::text, 'PENDENTE'), ',' order by import.number, line.line_number)
  from public.picpay_statement_lines line join public.picpay_statement_imports import on import.id = line.import_id
  left join private.picpay_statement_current_resolutions current on current.line_id = line.id
  where line.movement::text = p_movement and line.occurred_on = p_day $$;
create function pg_temp.exceptions(p_type text) returns bigint language sql security definer as $$
  select count(*) from private.picpay_exceptions() where type = p_type and not resolved $$;
create function pg_temp.digest() returns text language sql security definer as $$
  select md5(concat_ws('|', (select count(*) from public.picpay_transactions), (select count(*) from public.picpay_statement_lines),
    (select count(*) from public.picpay_receivable_installments),
    (select string_agg(resolution || ':' || n, ',' order by resolution) from (select current.resolution::text as resolution, count(*) n
      from private.picpay_statement_current_resolutions current group by 1) r),
    (select string_agg(account || ':' || balance_cents, ',' order by account) from private.finance_account_balances(pg_temp.today())),
    (select count(*) from private.picpay_current_links))) $$;

-- Privileges and data minimisation.
select ok(not has_function_privilege('anon', 'public.import_picpay_file(text,text,text,uuid)', 'EXECUTE'), 'anonymous cannot import PicPay files');
select ok(not has_table_privilege('authenticated', 'public.picpay_transaction_observations', 'SELECT'), 'observations are read only through finance functions');
select is((select count(*)::integer from information_schema.columns where table_schema = 'public'
  and table_name in ('picpay_transaction_observations', 'picpay_receivable_observations')
  and column_name ~ '(buyer|name|document|documento|email|phone|telefone|payer|pagador|card_number|tid)'), 0, 'payer, buyer, document, e-mail, phone and full card are never stored');

-- Point-of-sale payments of the native period (today): a Pix, a card with the NSU typed by the seller, and a Pix the acquirer never saw.
insert into public.inventory_balances(location_id, product_id) values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 10, 'Estoque conciliação PicPay', 'picpay-rec-stock', gen_random_uuid())$$,
  'admin prepares seller stock');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table pdv(label text primary key, sale_id uuid, attempt_id uuid, total bigint);
insert into pdv (label, sale_id) select label, (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
  jsonb_build_array(jsonb_build_object('product_id', '33f00000-0000-4000-8000-000000000001', 'quantity', quantity)), 'picpay-rec-' || label, gen_random_uuid()) ->> 'sale_id')::uuid
from (values ('pix', 1), ('card', 1), ('lonely', 2)) sales(label, quantity);
update pdv set attempt_id = (public.confirm_manual_payment(sale_id, case when label = 'card' then 'MAQUININHA' else 'PIX_AREA' end::public.payment_integration_channel,
  case label when 'card' then '987654' when 'pix' then 'PIX-REC-0001' else 'PIX-REC-0002' end,
  case when label = 'card' then 'CREDITO' end::public.card_payment_method, null, 'picpay-rec-pay-' || label, gen_random_uuid()) -> 'payment_attempt' ->> 'attempt_id')::uuid;
reset role;
update pdv set total = (select total_cents from public.sales where id = pdv.sale_id);
grant select on pdv to authenticated;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';

-- Detection and preview.
create temp table files(name text primary key, content text);
grant all on files to authenticated;
insert into files values
  ('history_sales', pg_temp.sales(array[
    pg_temp.sale(pg_temp.at(pg_temp.h(2), '10:00:00'), pg_temp.h(2), 'Pix', 'QR Code PicPay', 1100, 0, 0, 0, 'Aprovada', '', '', 'E0000000000000000000000000000001'),
    pg_temp.sale(pg_temp.at(pg_temp.h(2), '10:05:00'), pg_temp.h(2), 'Pix', 'QR Code PicPay', 1100, 0, 0, 0, 'Aprovada', '', '', 'E0000000000000000000000000000002'),
    pg_temp.sale(pg_temp.at(pg_temp.h(3), '11:00:00'), pg_temp.h(3), 'Pix', 'PicPay Mini', 1500, 0, 0, 1500, 'Devolvida', '', '', 'E0000000000000000000000000000003'),
    pg_temp.sale(pg_temp.at(pg_temp.h(3), '12:00:00'), pg_temp.h(4), 'Crédito', 'PicPay Mini', 1700, 61, 0, 0, 'Aprovada', '1000001', '100001', '1000000000000000001'),
    pg_temp.sale(pg_temp.at(pg_temp.h(3), '12:10:00'), pg_temp.h(4), 'Débito', 'PicPay Mini', 1000, 11, 0, 0, 'Aprovada', '1000002', '100002', '1000000000000000002'),
    pg_temp.sale(pg_temp.at(pg_temp.h(3), '12:20:00'), pg_temp.h(6), 'Crédito', 'PicPay Mini', 2000, 50, 30, 0, 'Aprovada', '1000001', '100003', '1000000000000000003'),
    pg_temp.sale(pg_temp.at(pg_temp.h(3), '12:30:00'), null, 'Crédito Pre-pago', 'PicPay Mini', 500, 0, 0, 0, 'Negada', '1000001', '100004', '1000000000000000004')])),
  ('receivables', pg_temp.receivables(array[pg_temp.receivable(pg_temp.h(6), '1000000000000000003', 2000, 80)])),
  ('statement', pg_temp.statement(array[
    pg_temp.stmt(pg_temp.h(1), 'Dinheiro guardado', 'Cofrinho', -500),
    pg_temp.stmt(pg_temp.h(2), 'Pix recebido', 'Cliente Sintético', 1100),
    pg_temp.stmt(pg_temp.h(2), 'Pix recebido', 'Cliente Sintético', 1100),
    pg_temp.stmt(pg_temp.h(3), 'Pix recebido', 'Cliente Devolvido', 1500),
    pg_temp.stmt(pg_temp.h(3), 'Pix estornado', 'Cliente Devolvido', -1500),
    pg_temp.stmt(pg_temp.h(3), 'Pix enviado', 'Fornecedor Sintético', -300),
    pg_temp.stmt(pg_temp.h(4), 'Recebíveis de venda', 'Recebíveis', 1639),
    pg_temp.stmt(pg_temp.h(4), 'Recebíveis de venda', 'Recebíveis', 989),
    pg_temp.stmt(pg_temp.h(5), 'Dinheiro resgatado', 'Cofrinho', 200)]));
reset role;
insert into files select 'native_sales', pg_temp.sales(array[
  pg_temp.sale(to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS'), pg_temp.today(), 'Pix', 'QR Code PicPay',
    (select total from pdv where label = 'pix'), 0, 0, 0, 'Aprovada', '', '', 'E0000000000000000000000000000010'),
  pg_temp.sale(to_char(now() at time zone 'America/Sao_Paulo' - interval '2 hours', 'DD/MM/YYYY HH24:MI:SS'), pg_temp.today() + 1, 'Crédito', 'PicPay Mini',
    (select total from pdv where label = 'card'), 90, 0, 0, 'Aprovada', '1000001', '987654', '1000000000000000010'),
  pg_temp.sale(to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS'), pg_temp.today(), 'Pix', 'QR Code PicPay', 777, 0, 0, 0,
    'Aprovada', '', '', 'E0000000000000000000000000000011')]);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(public.preview_picpay_file((select content from files where name = 'history_sales')) ->> 'source_type', 'PICPAY_SALES', 'Minhas vendas is detected from its header');
select is(public.preview_picpay_file((select content from files where name = 'receivables')) ->> 'source_type', 'PICPAY_RECEIVABLES', 'Recebíveis is detected from its header');
select is(public.preview_picpay_file((select content from files where name = 'statement')) ->> 'source_type', 'PICPAY_STATEMENT', 'Extrato is detected from its header');
select is((public.preview_picpay_file('coluna;outra' || E'\n' || 'a;b' || E'\n') -> 'errors' -> 0 ->> 'code'), 'UNKNOWN_FILE', 'an unknown CSV is explained');
select throws_ok($$select public.import_picpay_file('qualquer.csv', 'coluna;outra' || E'\n' || 'a;b' || E'\n', 'rec-unknown', gen_random_uuid())$$,
  '22023', 'PICPAY_FILE_UNKNOWN', 'an unknown CSV is refused');
select is((public.preview_picpay_file((select content from files where name = 'history_sales')) -> 'totals' ->> 'refunded')::integer, 1,
  'the preview counts the refunded transactions');
reset role;
select is((select count(*)::integer from public.picpay_transactions), 0, 'a preview writes nothing');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.import_picpay_file('x.csv', (select content from files where name = 'statement'), 'rec-seller', gen_random_uuid())$$,
  '42501', 'FINANCE_MANAGE_REQUIRED', 'a seller cannot import PicPay files');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';

-- Order A: Extrato first, then Recebíveis, then Minhas vendas, opening position last.
reset role;
create temp sequence digest_a;
grant all on sequence digest_a to authenticated;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
savepoint order_a;
select lives_ok($$select public.import_picpay_file('extrato.csv', (select content from files where name = 'statement'), 'rec-a-stmt', gen_random_uuid())$$, 'Extrato before Minhas vendas');
select is(pg_temp.resolution('PIX_RECEBIDO', pg_temp.h(2)), 'PENDENTE,PENDENTE', 'without acquirer evidence and cutover, Pix received waits');
select lives_ok($$select public.import_picpay_file('recebiveis.csv', (select content from files where name = 'receivables'), 'rec-a-recv', gen_random_uuid())$$, 'then Recebíveis');
select lives_ok($$select public.import_picpay_file('vendas.csv', (select content from files where name = 'history_sales'), 'rec-a-sales', gen_random_uuid())$$, 'then Minhas vendas');
select lives_ok($$select public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.operating_since(), 0, 500, 0, 0, 'Abertura sintética', null, null, 'rec-a-open', gen_random_uuid())$$,
  'and the opening position last');
-- A sequence survives the rollback to the savepoint: it carries order A's digest (its first 15 hex digits).
select setval('digest_a', ('x' || lpad(left(pg_temp.digest(), 15), 16, '0'))::bit(64)::bigint);
rollback to savepoint order_a;

-- Order B: opening position, Minhas vendas, Recebíveis, Extrato.
select lives_ok($$select public.record_finance_opening_position(pg_temp.opening_on(), pg_temp.operating_since(), 0, 500, 0, 0, 'Abertura sintética', null, null, 'rec-b-open', gen_random_uuid())$$,
  'opening first');
create temp table imported as select 'sales' as name, public.import_picpay_file('vendas.csv', (select content from files where name = 'history_sales'), 'rec-b-sales', gen_random_uuid()) as result;
grant all on imported to authenticated;
insert into imported select 'receivables', public.import_picpay_file('recebiveis.csv', (select content from files where name = 'receivables'), 'rec-b-recv', gen_random_uuid());
insert into imported select 'statement', public.import_picpay_file('extrato.csv', (select content from files where name = 'statement'), 'rec-b-stmt', gen_random_uuid());
select is((select last_value from digest_a), ('x' || lpad(left(pg_temp.digest(), 15), 16, '0'))::bit(64)::bigint,
  'the order of the files and of the opening position does not change the final state');
select is((select (result ->> 'new_count')::integer from imported where name = 'sales'), 7, 'Minhas vendas: seven new transactions');

-- Pix: the set of a day and amount is reconciled; identical lines stay distinct; the refund is linked to its estorno.
select is(pg_temp.resolution('PIX_RECEBIDO', pg_temp.h(2)), 'CONCILIADA_PICPAY,CONCILIADA_PICPAY', 'two identical Pix received are two reconciled movements');
select is(pg_temp.resolution('PIX_RECEBIDO', pg_temp.h(3)) || '/' || pg_temp.resolution('PIX_ESTORNADO', pg_temp.h(3)), 'CONCILIADA_PICPAY/CONCILIADA_PICPAY',
  'a refunded Pix and its estorno are reconciled');
select is(pg_temp.balance('PENDENTE_LIQUIDACAO'), 0::bigint, 'the Pix clearing account is settled');
-- Cards: settlement aggregated by payment day (two statement lines for two sales), the rest stays receivable.
select is(pg_temp.resolution('RECEBIVEIS_VENDA', pg_temp.h(4)), 'TRANSFERENCIA,TRANSFERENCIA', 'historical receivables settle as a transfer when Minhas vendas explains them');
reset role;
select is((select string_agg(status, ',' order by payment_on) from private.picpay_settlement_days()), 'LIQUIDADO,A_RECEBER', 'one day settled, one still receivable');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(pg_temp.balance('RECEBIVEIS_PICPAY') - (select sum(total) from pdv)::bigint, 1920::bigint,
  'receivables hold exactly the unsettled historical net (20,00 − 0,50 − 0,30), besides the PDV sales still to settle');
select is(pg_temp.balance('COFRINHO_PICPAY'), 800::bigint, 'Cofrinho: 5,00 opening + 5,00 guardado − 2,00 resgatado');
select is(pg_temp.balance('PICPAY_EMPRESAS'), 4228::bigint,
  'free: Pix 11 + 11 + 15 − 15 + settlements 26,28 − 5 guardado + 2 resgatado − 3 Pix enviado (left the bank, still to classify)');
select is(public.finance_balances(pg_temp.today()) -> 'negative_accounts', '[]'::jsonb, 'no account is negative');
-- Revenue once, with the real fees.
select is(pg_temp.indicator('gross_revenue_cents') - pg_temp.indicator('sale_revenue_cents'), 8400::bigint,
  'historical revenue comes once from Minhas vendas: 11 + 11 + 15 + 17 + 10 + 20');
select is(pg_temp.indicator('refunds_cents'), 1500::bigint, 'the Devolvida Pix reverses its revenue');
select is(pg_temp.indicator('fees_cents'), 152::bigint, 'the real PicPay fees: 0,61 + 0,11 + 0,50 + 0,30');
select is(pg_temp.exceptions('EXTRATO_NAO_CLASSIFICADO'), 1::bigint, 'only the Pix enviado waits for a classification');

-- Reimport and overlap.
select throws_ok($$select public.import_picpay_file('vendas-de-novo.csv', (select content from files where name = 'history_sales'), 'rec-again', gen_random_uuid())$$,
  'P0001', 'PICPAY_FILE_ALREADY_IMPORTED', 'the same file is never imported twice');
create temp table overlap as select public.import_picpay_file('extrato-sobreposto.csv', pg_temp.statement(array[
  pg_temp.stmt(pg_temp.h(2), 'Pix recebido', 'Cliente Sintético', 1100),
  pg_temp.stmt(pg_temp.h(2), 'Pix recebido', 'Cliente Sintético', 1100),
  pg_temp.stmt(pg_temp.h(3), 'Pix recebido', 'Cliente Devolvido', 1500)]), 'rec-overlap', gen_random_uuid()) as result;
grant select on overlap to authenticated;
select is((select (result ->> 'new_count')::integer || '/' || (result ->> 'known_count') from overlap), '0/3', 'an overlapping export adds nothing it already knew');
select is((select (public.import_picpay_file('extrato-tres.csv', pg_temp.statement(array[
  pg_temp.stmt(pg_temp.h(2), 'Pix recebido', 'Cliente Sintético', 1100), pg_temp.stmt(pg_temp.h(2), 'Pix recebido', 'Cliente Sintético', 1100),
  pg_temp.stmt(pg_temp.h(2), 'Pix recebido', 'Cliente Sintético', 1100)]), 'rec-three', gen_random_uuid()) ->> 'new_count')::integer), 1,
  'a later export with three identical movements adds exactly one');
select is(pg_temp.resolution('PIX_RECEBIDO', pg_temp.h(2)), 'CONCILIADA_PICPAY,CONCILIADA_PICPAY,PENDENTE',
  'the third identical Pix is not reconciled without a third transaction');
select is((select (public.import_picpay_file('extrato-incompleto.csv', pg_temp.statement(array[
  pg_temp.stmt(pg_temp.h(1), 'Dinheiro guardado', 'Cofrinho', -500), pg_temp.stmt(pg_temp.h(2), 'Pix recebido', 'Cliente Sintético', 1100),
  pg_temp.stmt(pg_temp.h(5), 'Dinheiro resgatado', 'Cofrinho', 200)]), 'rec-fewer', gen_random_uuid()) ->> 'ambiguous_count')::integer), 6,
  'an export missing known movements inside its period (two of the identical Pix among them) is a conflict per movement, not a deletion');
select is(pg_temp.exceptions('DUPLICIDADE'), 6::bigint, 'the conflicts wait for review');
reset role;
select is((select count(*)::integer from public.picpay_statement_lines where movement = 'PIX_RECEBIDO' and occurred_on = pg_temp.h(2)), 3, 'nothing was removed');
select is((select count(*)::integer from private.picpay_statement_line_provenance provenance
  join public.picpay_statement_lines line on line.id = provenance.line_id where line.movement = 'PIX_RECEBIDO' and line.occurred_on = pg_temp.h(2)), 8,
  'provenance tells which exports saw each movement');

-- Lifecycle: an approved transaction later reported as Devolvida.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table lifecycle as select public.import_picpay_file('vendas-devolucao.csv', pg_temp.sales(array[
  pg_temp.sale(pg_temp.at(pg_temp.h(3), '12:00:00'), pg_temp.h(4), 'Crédito', 'PicPay Mini', 1700, 0, 0, 1700, 'Devolvida', '1000001', '100001', '1000000000000000001')]),
  'rec-refund', gen_random_uuid()) as result;
grant select on lifecycle to authenticated;
select is((select (result ->> 'updated_count')::integer || '/' || (result ->> 'new_count') from lifecycle), '1/0', 'the status change is an update, not a new transaction');
reset role;
select is((select status::text || '/' || observation_count from private.picpay_transaction_state where transaction_ref = '1000000000000000001'), 'DEVOLVIDA/2',
  'the transaction keeps both observations and its current state is Devolvida');
select is((select count(*)::integer from public.picpay_transaction_observations observation join public.picpay_transactions tx on tx.id = observation.transaction_id
  where tx.transaction_ref = '1000000000000000001' and observation.status = 'APROVADA'), 1, 'the approved observation is kept');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(pg_temp.indicator('gross_revenue_cents') - pg_temp.indicator('sale_revenue_cents'), 8400::bigint, 'the refund does not create revenue again');
select is(pg_temp.indicator('refunds_cents'), 3200::bigint, 'the refund reverses its revenue once (15 + 17)');
select is(pg_temp.exceptions('LIQUIDACAO_SEM_EXPLICACAO'), 1::bigint, 'the card settlement it no longer explains is reported');
-- Negada never creates revenue, receivable or balance.
reset role;
select ok(not exists (select 1 from private.picpay_acquirer_effects(pg_temp.opening_on(), pg_temp.today()) effect
  join public.picpay_transactions tx on tx.id = effect.source_id where tx.transaction_ref = '1000000000000000004'), 'a denied transaction has no effect');

-- Native operation: PicPay transactions are linked to the PDV sales; the sale stays the only revenue; the real fee joins.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table native as select public.import_picpay_file('vendas-semana.csv', (select content from files where name = 'native_sales'), 'rec-native', gen_random_uuid()) as result;
grant select on native to authenticated;
reset role;
select is((select payment_attempt_id from private.picpay_transactions_view where transaction_ref = 'E0000000000000000000000000000010'),
  (select attempt_id from pdv where label = 'pix'), 'the native Pix is linked to its PDV payment by amount, method and time');
select is((select payment_attempt_id::text || '/' || link_evidence from private.picpay_transactions_view where transaction_ref = '1000000000000000010'),
  (select attempt_id::text from pdv where label = 'card') || '/REFERENCIA', 'the native card is linked by the NSU the seller typed');
select ok(not exists (select 1 from private.picpay_acquirer_effects(pg_temp.opening_on(), pg_temp.today()) where category = 'RECEITA_HISTORICA'
  and source_id in (select transaction_id from private.picpay_transactions_view where not historical)), 'a native transaction never creates revenue');
select is((select sum(amount_cents)::bigint from private.picpay_acquirer_effects(pg_temp.today() - 1, pg_temp.today()) where category = 'TAXAS'
  and account = 'RECEBIVEIS_PICPAY'), -90::bigint, 'the real card fee of the native sale reduces receivables');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(pg_temp.exceptions('PICPAY_SEM_PDV'), 1::bigint, 'a PicPay transaction without a PDV sale is reported');
select is(pg_temp.exceptions('PDV_SEM_PICPAY'), 1::bigint, 'a PDV payment without a PicPay transaction is reported');
select is(pg_temp.indicator('sale_revenue_cents'), (select sum(total) from pdv)::bigint, 'the PDV sales are the native revenue, once');

-- Manual link and exceptions resolved with a reason.
select throws_ok($$select public.link_picpay_transaction(null, (select attempt_id from pdv where label = 'lonely'), 'Vínculo manual de teste', 'rec-link-null', gen_random_uuid())$$,
  '22023', 'INVALID_PICPAY_LINK', 'a link needs a transaction');
reset role;
create temp table lonely_tx as select transaction_id from private.picpay_transactions_view where transaction_ref = 'E0000000000000000000000000000011';
grant select on lonely_tx to authenticated;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.link_picpay_transaction((select transaction_id from lonely_tx), (select attempt_id from pdv where label = 'pix'), 'Vínculo manual de teste', 'rec-link-taken', gen_random_uuid())$$,
  'P0001', 'PICPAY_ALREADY_LINKED', 'a PDV payment is linked to one transaction only');
select lives_ok($$select public.link_picpay_transaction((select transaction_id from lonely_tx), (select attempt_id from pdv where label = 'lonely'), 'Venda conferida com o vendedor', 'rec-link', gen_random_uuid())$$,
  'finance links the remaining pair by hand');
select is(pg_temp.exceptions('VALOR_DIVERGENTE'), 1::bigint, 'the manual link with a different amount is reported');
select is(pg_temp.exceptions('PICPAY_SEM_PDV') + pg_temp.exceptions('PDV_SEM_PICPAY'), 0::bigint, 'nothing is left unpaired');
reset role;
create temp table divergence as select exception_key from private.picpay_exceptions() where type = 'VALOR_DIVERGENTE' limit 1;
grant select on divergence to authenticated;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.resolve_picpay_exception((select exception_key from divergence), 'RESOLVIDA',
  'Diferença explicada pelo desconto', 'rec-resolve', gen_random_uuid())$$, 'an exception is resolved with a reason');
select is(pg_temp.exceptions('VALOR_DIVERGENTE'), 0::bigint, 'and leaves the open list');
select is(public.resolve_picpay_exception((select exception_key from divergence), 'RESOLVIDA',
  'Diferença explicada pelo desconto', 'rec-resolve', gen_random_uuid()) ->> 'action', 'RESOLVIDA', 'resolving is idempotent');
reset role;
select is((select count(*)::integer from cohort_data.audit_logs where action = 'finance.picpay.exception_resolved'), 1, 'the resolution is audited once');

-- Periods: evaluated, then sent back to review by new evidence.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select is(public.close_picpay_period(pg_temp.h(1), pg_temp.h(6), 'Conferência sintética', 'rec-period', gen_random_uuid()) ->> 'status', 'COM_PENDENCIAS',
  'a period with open exceptions is not reconciled');
select lives_ok($$select public.import_picpay_file('extrato-depois.csv', pg_temp.statement(array[pg_temp.stmt(pg_temp.h(3), 'Pix enviado', 'Outro Fornecedor', -700)]),
  'rec-later', gen_random_uuid())$$, 'a later export touches the period');
select is(public.list_picpay_periods(5) -> 0 ->> 'status', 'REVISAR', 'the evaluated period goes back to review');
select is(public.picpay_reconciliation_summary(pg_temp.h(1), pg_temp.h(6)) -> 'receivables' ->> 'snapshot_cents', '1920',
  'the summary shows the receivable snapshot');
reset role;
select is((select count(*)::integer from cohort_data.audit_logs where action = 'finance.picpay.file_imported'), 9, 'every import is audited');

select * from finish();
rollback;
