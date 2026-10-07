-- Spec 5.8 (FIN-007): PicPay Empresas CSV import with preview, validation, immutable lines and review.
begin;
select plan(56);

create function pg_temp.money(p_cents bigint) returns text language sql as $$
  select case when p_cents < 0 then '-' else '' end || (abs(p_cents) / 100)::text || '.' || lpad((abs(p_cents) % 100)::text, 2, '0') $$;
create function pg_temp.csv(p_lines text[]) returns text language sql as $$
  select 'data;movimento;descrição;tipo;valor' || E'\n' || coalesce(string_agg(line || E';\r\n', '' order by ordinality), '')
  from unnest(p_lines) with ordinality line $$;
create function pg_temp.line(p_movement text, p_description text, p_cents bigint) returns text language sql as $$
  select to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD') || ';' || p_movement || ';' || p_description || ';'
    || case when p_cents > 0 then 'Entrada' else 'Saída' end || ';' || pg_temp.money(p_cents) $$;
create function pg_temp.total(p_result jsonb, p_key text) returns bigint language sql as $$
  select coalesce((p_result -> 'totals' ->> p_key)::bigint, 0) $$;
create function pg_temp.account(p_result jsonb, p_account text) returns bigint language sql as $$
  select coalesce((p_result -> 'totals' -> 'by_account' ->> p_account)::bigint, 0) $$;

select ok(not has_function_privilege('anon', 'public.import_picpay_file(text,text,text,uuid)', 'EXECUTE'), 'anonymous cannot import');
-- The statement-only import is gone: files enter only through the PicPay reconciliation.
select ok(to_regprocedure('public.import_picpay_statement(text,text,boolean,text,uuid)') is null, 'the legacy statement import no longer exists');
select ok(to_regprocedure('public.preview_picpay_statement(text)') is null, 'the legacy statement preview no longer exists');
create function pg_temp.statement_import(p_id text) returns jsonb language sql as $$
  select item from jsonb_array_elements(public.list_picpay_statement_imports(null, 50) -> 'items') item where item ->> 'id' = p_id $$;
select ok(not has_function_privilege('authenticated', 'private.parse_picpay_statement(text)', 'EXECUTE'), 'the parser is private');

-- Parser: format, trailing `;`, CRLF, BOM, masking and line errors with their physical line number.
select is((select count(*) from private.parse_picpay_statement(pg_temp.csv(array[
  pg_temp.line('Pix recebido', 'Cliente A', 1000), pg_temp.line('Pix enviado', 'Fornecedor B', -500)])) where error_code is null),
  2::bigint, 'data lines with the extra trailing `;` and CRLF are valid');
select is((select count(*) from private.parse_picpay_statement(chr(65279) || pg_temp.csv(array[pg_temp.line('Pix recebido', 'Cliente A', 1000)]))
  where error_code is null), 1::bigint, 'a UTF-8 byte order mark is accepted');
select is((select description from private.parse_picpay_statement(pg_temp.csv(array[pg_temp.line('Pix recebido', 'Loja 12.345.678 Fulano 123.456.789-00', 1000)]))),
  'Loja [doc] Fulano [doc]', 'document numbers in the description are masked');
select is((select error_code from private.parse_picpay_statement('data,movimento,descricao,tipo,valor' || E'\n' || '2026-09-01,Pix,X,Entrada,1.00')),
  'INVALID_HEADER', 'a different header is rejected');
select is((select error_code from private.parse_picpay_statement('')), 'EMPTY_FILE', 'an empty file is rejected');
select is((select error_code from private.parse_picpay_statement(pg_temp.csv(array[]::text[]))), 'NO_LINES', 'a header without lines is rejected');
select results_eq(
  $$select line_number, error_code from private.parse_picpay_statement(pg_temp.csv(array[
    pg_temp.line('Pix recebido', 'Ok', 1000),
    '2026-02-30;Pix recebido;Data impossível;Entrada;10.00',
    '2999-01-01;Pix recebido;Futuro;Entrada;10.00',
    replace(pg_temp.line('Pix recebido', 'Vírgula', 1000), '10.00', '10,00'),
    replace(pg_temp.line('Pix recebido', 'Sinal', 1000), 'Entrada', 'Saída'),
    pg_temp.line('Pix recebido', 'Campos;demais', 1000),
    pg_temp.line('Pix recebido', 'Zero', 0)])) where error_code is not null order by line_number$$,
  $$values (3, 'INVALID_DATE'), (4, 'FUTURE_DATE'), (5, 'INVALID_AMOUNT'), (6, 'AMOUNT_SIGN_MISMATCH'), (7, 'INVALID_FIELD_COUNT'), (8, 'ZERO_AMOUNT')$$,
  'each invalid line is reported with its line number and reason');
select is((select movement::text from private.parse_picpay_statement(pg_temp.csv(array[pg_temp.line('Dinheiro guardado', 'Cofrinho', 500)]))),
  'DESCONHECIDO', 'a known movement in an unexpected direction is unknown');

-- Sales: one Área Pix sale with a unique amount, two with the same amount, and one refunded.
insert into public.inventory_balances(location_id, product_id)
values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',40,'Estoque extrato PicPay','picpay-csv-stock',gen_random_uuid())$$, 'admin prepares seller stock');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select lives_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000002',0,'picpay-csv-shift',gen_random_uuid())$$, 'seller opens a shift');
create temp table csv_sales(label text primary key, quantity integer, sale_id uuid);
insert into csv_sales select label, quantity, (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
  jsonb_build_array(jsonb_build_object('product_id', '33f00000-0000-4000-8000-000000000001', 'quantity', quantity)),
  'picpay-csv-' || label, gen_random_uuid()) ->> 'sale_id')::uuid
from (values ('unique', 7), ('twin-a', 9), ('twin-b', 9), ('refunded', 5)) sales(label, quantity);
select lives_ok($$select public.confirm_manual_payment(sale_id, 'PIX_AREA', 'PIX-CSV-' || upper(label), null, null, 'picpay-csv-pay-' || label, gen_random_uuid()) from csv_sales$$,
  'the four Área Pix sales are confirmed');
reset role;
create temp table amounts as select label, (select amount_cents from public.payment_attempts where sale_id = csv_sales.sale_id) as cents from csv_sales;
grant select on amounts to authenticated;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.reverse_confirmed_sale((select sale_id from csv_sales where label = 'refunded'), 'Cliente pediu o estorno do Pix', 'EST-PIX-CSV-1', null, 'picpay-csv-refund', gen_random_uuid())$$,
  'finance refunds one Pix sale');

select ok(exists (select 1 from amounts where label = 'unique' and cents <> (select cents from amounts where label = 'twin-a')), 'the unique sale has its own amount');

create temp table baseline as select public.finance_statement(today, today) as statement, public.management_indicators(today, today) as indicators
from (select (now() at time zone 'America/Sao_Paulo')::date as today) period;

-- The file: Cofrinho both ways, receivables, two legitimate identical lines, the sales, the refund, reversals,
-- one outgoing Pix and one unknown movement.
create temp table file as select pg_temp.csv(array[
  pg_temp.line('Dinheiro guardado', 'Cofrinho', -30000),
  pg_temp.line('Dinheiro resgatado', 'Cofrinho', 10000),
  pg_temp.line('Recebíveis de venda', 'Crédito', 4321),
  pg_temp.line('Pix recebido', 'Colega Repetido', 1234),
  pg_temp.line('Pix recebido', 'Colega Repetido', 1234),
  pg_temp.line('Pix recebido', 'Comprador Único', (select cents from amounts where label = 'unique')),
  pg_temp.line('Pix recebido', 'Comprador Gêmeo', (select cents from amounts where label = 'twin-a')),
  pg_temp.line('Pix estornado', 'Comprador Estornado', -(select cents from amounts where label = 'refunded')),
  pg_temp.line('Pix estornado', 'Sem venda interna', -777),
  pg_temp.line('Pix devolvido', 'Fornecedor Devolveu', 2500),
  pg_temp.line('Pix enviado', 'Papelaria', -4000),
  pg_temp.line('Pagamento de boleto', 'Boleto', -1500)
]) as content;

reset role;
create temp table stored_before as select (select count(*) from public.picpay_statement_imports) as imports, (select count(*) from public.picpay_statement_lines) as lines;
set local role authenticated;
create temp table preview as select public.preview_picpay_file((select content from file)) as result;
select is((select (result ->> 'error_count')::integer from preview), 0, 'the preview finds no errors');
select is((select result ->> 'source_type' from preview), 'PICPAY_STATEMENT', 'the preview detects the statement by its header');
select is((select (result ->> 'new_count') || '/' || (result ->> 'known_count') from preview), '12/0',
  'every line is new, the two identical lines included');
reset role;
select is((select count(*) from public.picpay_statement_imports), (select imports from stored_before), 'the preview stores nothing');
set local role authenticated;

-- A partially invalid file is refused whole.
select throws_ok($$select public.import_picpay_file('parcial.csv', (select content from file) || '2026-02-30;Pix recebido;X;Entrada;1.00;' || E'\r\n', 'picpay-csv-partial', gen_random_uuid())$$,
  '22023', 'PICPAY_FILE_INVALID', 'a file with an invalid line is not imported');
reset role;
select is((select count(*) from public.picpay_statement_lines), (select lines from stored_before), 'no line of the invalid file is kept');
set local role authenticated;

create temp table imported as select public.import_picpay_file('C:\fakepath\48789680000109-extrato.csv', (select content from file), 'picpay-csv-import', gen_random_uuid()) as result;
select is((select pg_temp.statement_import(result ->> 'id') ->> 'account' from imported), 'PICPAY_EMPRESAS', 'the import is on the PicPay Empresas account');
select is((select result ->> 'file_name' from imported), '[doc]-extrato.csv', 'the file name keeps no path or document number');
select is((select result ->> 'file_sha256' from imported), encode(sha256(convert_to((select content from file), 'UTF8')), 'hex'), 'the file hash is stored');
reset role;
select is((select count(*) from public.picpay_statement_lines line join imported on line.import_id = (imported.result ->> 'id')::uuid), 12::bigint,
  'every line is stored, each by file and line number');
set local role authenticated;
reset role;
select is((select count(*) from public.picpay_statement_lines where description = 'Colega Repetido'), 2::bigint, 'identical legitimate lines are not deduplicated');
set local role authenticated;
select is((select pg_temp.statement_import(result ->> 'id') -> 'status_counts' from imported),
  '{"TRANSFERENCIA": 3, "CONCILIADA_VENDA": 1, "CONCILIADA_ESTORNO": 1, "CLASSIFICADA": 0, "VINCULADA": 0, "JA_REGISTRADO": 0, "PENDENTE_REVISAO": 6, "PENDENTE_CLASSIFICACAO": 1}'::jsonb,
  'the import applies only the automatic decisions');
reset role;
select is((select status::text from public.payment_attempts where sale_id = (select sale_id from csv_sales where label = 'unique')), 'RECONCILED',
  'the single matching sale is reconciled');
set local role authenticated;
reset role;
select is((select count(*) from public.payment_attempts where sale_id in (select sale_id from csv_sales where label like 'twin-%') and status = 'APPROVED'), 2::bigint,
  'ambiguous sales are left untouched');
set local role authenticated;

-- Replays and the same file again.
select is((select public.import_picpay_file('C:\fakepath\48789680000109-extrato.csv', (select content from file), 'picpay-csv-import', gen_random_uuid()) ->> 'id'),
  (select result ->> 'id' from imported), 'a replay with the same key returns the same import');
select throws_ok($$select public.import_picpay_file('outro-nome.csv', (select content from file), 'picpay-csv-import-again', gen_random_uuid())$$,
  'P0001', 'PICPAY_FILE_ALREADY_IMPORTED', 'the same file is not imported twice');
select is((select result -> 'already_imported' ->> 'number' from (select public.preview_picpay_file((select content from file)) as result) again),
  (select result ->> 'number' from imported), 'the preview warns about the earlier import');
-- An overlapping export needs no confirmation any more: known movements are recognized and only the new one is added.
select is((select (result ->> 'new_count') || '/' || (result ->> 'known_count') from (select public.import_picpay_file('cruzado.csv',
  pg_temp.csv(array[pg_temp.line('Pix recebido', 'Colega Repetido', 1234), pg_temp.line('Pix recebido', 'Outro dia', 999)]),
  'picpay-csv-overlap', gen_random_uuid()) as result) overlap), '1/1', 'an overlapping export adds only what is new');

-- Cofrinho and receivables are transfers: accounts move, revenue, expense and profit do not.
create temp table after_import as select public.finance_statement(today, today) as statement, public.management_indicators(today, today) as indicators
from (select (now() at time zone 'America/Sao_Paulo')::date as today) period;
select is(pg_temp.account((select statement from after_import), 'COFRINHO_PICPAY') - pg_temp.account((select statement from baseline), 'COFRINHO_PICPAY'),
  20000::bigint, 'the Cofrinho holds what was set aside minus what came back');
select is(pg_temp.account((select statement from after_import), 'RECEBIVEIS_PICPAY') - pg_temp.account((select statement from baseline), 'RECEBIVEIS_PICPAY'),
  -4321::bigint - (select cents from amounts where label = 'unique'), 'receivables leave through the settled sale and the PicPay receivables line');
select is(pg_temp.total((select statement from after_import), 'inflow_cents'), pg_temp.total((select statement from baseline), 'inflow_cents'),
  'transfers and reconciliations add no inflow');
select is((select indicators -> 'totals' ->> 'operating_profit_cents' from after_import), (select indicators -> 'totals' ->> 'operating_profit_cents' from baseline),
  'the automatic part of the import does not change profit');

-- Review.
reset role;
create temp table lines as select line.id, line.description from public.picpay_statement_lines line where line.import_id = (select (result ->> 'id')::uuid from imported);
grant select on lines to authenticated;
set local role authenticated;
select throws_ok($$select public.resolve_picpay_statement_line((select id from lines where description = 'Papelaria'), 'CLASSIFICAR', 'VENDA_PDV', null, null, null, 'picpay-csv-sale-category', gen_random_uuid())$$,
  '22023', 'FINANCE_CATEGORY_AUTOMATIC_ONLY', 'an imported line never becomes sale revenue');
select lives_ok($$select public.resolve_picpay_statement_line((select id from lines where description = 'Papelaria'), 'CLASSIFICAR', 'MATERIAIS', null, null, null, 'picpay-csv-paper', gen_random_uuid())$$,
  'the outgoing Pix is classified as an expense');
select lives_ok($$select public.resolve_picpay_statement_line((select id from lines where description = 'Fornecedor Devolveu'), 'CLASSIFICAR', 'FORNECEDOR', null, null, null, 'picpay-csv-returned', gen_random_uuid())$$,
  'the returned Pix undoes a supplier expense');
select lives_ok($$select public.resolve_picpay_statement_line((select id from lines where description = 'Sem venda interna'), 'CLASSIFICAR', 'MENSALIDADES', null, null, null, 'picpay-csv-chargeback', gen_random_uuid())$$,
  'the refunded Pix without an internal sale undoes an income');
select lives_ok($$select public.resolve_picpay_statement_line((select id from lines where description = 'Comprador Gêmeo'), 'CONCILIAR_VENDA', null,
  (select id from public.payment_attempts where sale_id = (select sale_id from csv_sales where label = 'twin-b')), null, null, 'picpay-csv-twin', gen_random_uuid())$$,
  'the ambiguous Pix is reconciled by a person');
reset role;
select is((select status::text from public.payment_attempts where sale_id = (select sale_id from csv_sales where label = 'twin-b')), 'RECONCILED', 'the chosen sale is reconciled');
set local role authenticated;
select throws_ok($$select public.resolve_picpay_statement_line((select id from lines where description = 'Papelaria'), 'JA_REGISTRADO', null, null, null, 'Pago em contas a pagar', 'picpay-csv-twice', gen_random_uuid())$$,
  'P0001', 'STATEMENT_LINE_ALREADY_RESOLVED', 'a reviewed line is not reviewed again');
select throws_ok($$select public.resolve_picpay_statement_line((select id from lines where description = 'Cofrinho' limit 1), 'REABRIR', null, null, null, 'Tentativa de reabrir', 'picpay-csv-reopen-transfer', gen_random_uuid())$$,
  'P0001', 'STATEMENT_LINE_NOT_REOPENABLE', 'an automatic transfer cannot be reopened');

create temp table after_review as select public.finance_statement(today, today) as statement, public.management_indicators(today, today) as indicators
from (select (now() at time zone 'America/Sao_Paulo')::date as today) period;
select is(pg_temp.total((select indicators from after_review), 'operating_expenses_cents') - pg_temp.total((select indicators from baseline), 'operating_expenses_cents'),
  4000::bigint - 2500, 'expenses: the paper purchase minus the returned supplier Pix');
select is(pg_temp.total((select indicators from after_review), 'manual_income_cents') - pg_temp.total((select indicators from baseline), 'manual_income_cents'),
  -777::bigint, 'the refunded Pix lowers income and is never new revenue');
select is(pg_temp.total((select indicators from after_review), 'gross_revenue_cents') - pg_temp.total((select indicators from baseline), 'gross_revenue_cents'),
  -777::bigint, 'no imported line adds revenue');

-- Reopening removes the effect; history stays.
select lives_ok($$select public.resolve_picpay_statement_line((select id from lines where description = 'Papelaria'), 'REABRIR', null, null, null, 'Categoria errada, revisar', 'picpay-csv-reopen', gen_random_uuid())$$,
  'a classification can be reopened with a reason');
select is(pg_temp.total(public.management_indicators((now() at time zone 'America/Sao_Paulo')::date, (now() at time zone 'America/Sao_Paulo')::date), 'operating_expenses_cents')
  - pg_temp.total((select indicators from baseline), 'operating_expenses_cents'), -2500::bigint, 'the reopened line no longer counts');
reset role;
select is((select count(*) from public.picpay_statement_line_resolutions where line_id = (select id from lines where description = 'Papelaria')), 2::bigint,
  'the classification and the reopening are both kept');
set local role authenticated;
select lives_ok($$select public.resolve_picpay_statement_line((select id from lines where description = 'Boleto'), 'JA_REGISTRADO', null, null, null, 'Boleto lançado em contas a pagar', 'picpay-csv-known', gen_random_uuid())$$,
  'an unknown movement can be marked as already recorded');

-- Permissions and immutability.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.preview_picpay_file('x')$$, '42501', 'FINANCE_MANAGE_REQUIRED', 'a seller cannot preview statements');
reset role;
select throws_ok($$update public.picpay_statement_lines set amount_cents = 1 where description = 'Papelaria'$$, null, null, 'imported lines are immutable');

select * from finish();
rollback;
