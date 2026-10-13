-- ADR 0011, E0 (PicPay cohort attribution foundation): PicPay evidence is global and counts in a cohort only through an
-- explicit, structural attribution (the file declaration, a person deciding inside a cohort, a cohort record it is tied
-- to, or ADMIN_MASTER's assignment). With isolation on, unassigned evidence counts nowhere and only ADMIN_MASTER sees it.
-- Two cohorts: A (Turma 2026, the default) and B. Synthetic files only; dates relative to today (São Paulo).
begin;
select plan(78);

create function pg_temp.ctx(p_user uuid, p_header text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
  perform set_config('role', 'authenticated', true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create function pg_temp.sys() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.headers', '', true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create function pg_temp.a() returns uuid language sql as $$ select 'c0000000-0000-4000-8000-000000002026'::uuid $$;
create function pg_temp.b() returns uuid language sql as $$ select id from ids where name = 'cohort_b' $$;
create function pg_temp.master() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000005'::uuid $$;
create function pg_temp.admin_a() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.admin_b() returns uuid language sql as $$ select 'e0000000-0000-4000-8000-0000000000b1'::uuid $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;
create function pg_temp.br(p_day date) returns text language sql as $$ select to_char(p_day, 'DD/MM/YYYY') $$;
create function pg_temp.brl(p_cents bigint) returns text language sql as $$
  select 'R$ ' || case when p_cents < 0 then '-' else '' end || (abs(p_cents) / 100)::text || ',' || lpad((abs(p_cents) % 100)::text, 2, '0') $$;
create function pg_temp.dot(p_cents bigint) returns text language sql as $$
  select case when p_cents < 0 then '-' else '' end || (abs(p_cents) / 100)::text || '.' || lpad((abs(p_cents) % 100)::text, 2, '0') $$;
create function pg_temp.statement(p_lines text[]) returns text language sql as $$
  select 'data;movimento;descrição;tipo;valor' || E'\n' || array_to_string(p_lines, E';\r\n') || E';\r\n' $$;
create function pg_temp.stmt(p_day date, p_movement text, p_description text, p_cents bigint) returns text language sql as $$
  select to_char(p_day, 'YYYY-MM-DD') || ';' || p_movement || ';' || p_description || ';' || case when p_cents > 0 then 'Entrada' else 'Saída' end
    || ';' || pg_temp.dot(p_cents) $$;
create function pg_temp.sales(p_lines text[]) returns text language sql as $$
  select 'Data e hora da venda;Previsão de pagamento;Bandeira;Número do cartão;Forma de pagamento;Solução de captura;Valor da venda;'
    || 'Valor recebido comissão;Valor cancelado;Tarifa;Custo fixo;Taxa de parcelamento;Valor Líquido;Quantidade de parcelas;Status;NSU;'
    || 'Número do terminal;TID;Código de autorização;Número do pedido;Número único da transação;Pagador Picpay;Nome do comprador;Documento;'
    || 'Email;Telefone;Transação recorrente;Split;CNPJ parceiro;Valor bruto pago parceiro;Transação 3DS;ARN;' || E'\n'
    || array_to_string(p_lines, E'\n') || E'\n' $$;
create function pg_temp.sale(p_sold_at text, p_forecast date, p_method text, p_capture text, p_gross bigint, p_fee bigint,
  p_installment_fee bigint, p_cancelled bigint, p_status text, p_terminal text, p_nsu text, p_ref text) returns text language sql as $$
  select concat_ws(';', p_sold_at, coalesce(pg_temp.br(p_forecast), ''), case when p_method = 'Pix' then 'Pix' else 'Elo' end,
    case when p_method = 'Pix' then '' else '509431******0001' end, p_method, p_capture, pg_temp.brl(p_gross), '', pg_temp.brl(p_cancelled),
    ' ' || pg_temp.brl(p_fee), ' R$ 0,00', case when p_installment_fee > 0 then pg_temp.brl(p_installment_fee) else '' end,
    pg_temp.brl(p_gross - p_cancelled - p_fee - p_installment_fee), case when p_method = 'Pix' then '' else '1' end, p_status, p_nsu,
    p_terminal, '', '', '', p_ref, '-', 'Comprador Sintético', '000.000.000-00', 'sintetico@example.com', '(00) 0000-0000', '-', '-', '-', '-', '-', '-')
  || ';' $$;
-- Books and lists as the current request sees them.
create function pg_temp.balance(p_account text) returns bigint language sql security definer as $$
  select balance_cents from private.finance_account_balances(pg_temp.today()) where account::text = p_account $$;
create function pg_temp.indicator(p_key text) returns bigint language sql security definer as $$
  select (private.compute_management_indicators(pg_temp.today() - 40, pg_temp.today()) -> 'totals' ->> p_key)::bigint $$;
create function pg_temp.line(p_description text) returns uuid language sql security definer as $$
  select id from public.picpay_statement_lines where description = p_description $$;
create function pg_temp.line_cohort(p_description text) returns uuid language sql security definer as $$
  select cohort_id from private.picpay_line_cohorts where line_id = pg_temp.line(p_description) $$;
create function pg_temp.resolution_cohort(p_description text) returns uuid language sql security definer as $$
  select resolution.cohort_id from cohort_data.picpay_statement_line_resolutions resolution
  where resolution.line_id = pg_temp.line(p_description) order by resolution.sequence desc limit 1 $$;
create function pg_temp.import(p_name text, p_content text, p_scope text, p_cohort uuid) returns jsonb language sql as $$
  select public.import_picpay_file(p_name, p_content, p_scope::public.picpay_import_scope, p_cohort, 'e0-' || p_name, gen_random_uuid()) $$;

-- People: ADMIN of A (seed), ADMIN of B only.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'e0000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated',
  'e0.admin.b@institutojef.org.br', extensions.crypt('Turmas123!', extensions.gen_salt('bf')), now(), '{}',
  jsonb_build_object('name', 'Admin E0 B', 'username', 'e0.admin.b'), now(), now());
select pg_temp.ctx(pg_temp.master(), 'all');
insert into ids select 'cohort_b', (public.create_cohort('Turma E0 B', 2035, 'turma-e0-b', 'ACTIVE', 'e0-create-b', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select public.set_cohort_membership(pg_temp.admin_b(), true, 'Entrada na turma B', gen_random_uuid());
select public.set_user_access(pg_temp.admin_b(), array['ADMIN', 'CONSUMIDOR'], true, gen_random_uuid());
select pg_temp.sys();
delete from cohort_data.user_roles where cohort_id = pg_temp.a() and user_id = pg_temp.admin_b();
delete from public.user_cohorts where cohort_id = pg_temp.a() and user_id = pg_temp.admin_b();

-- Openings: A has Cofrinho 5,00; B starts empty. Native operation from 5 days ago in both.
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
select public.record_finance_opening_position(pg_temp.today() - 40, pg_temp.today() - 5, 0, 500, 0, 0, 'Abertura A', null, null, 'e0-open-a', gen_random_uuid());
select pg_temp.ctx(pg_temp.admin_b(), pg_temp.b()::text);
select public.record_finance_opening_position(pg_temp.today() - 40, pg_temp.today() - 5, 0, 0, 0, 0, 'Abertura B', null, null, 'e0-open-b', gen_random_uuid());

-- 1. Importing is ADMIN_MASTER's, inside a concrete cohort, with a declaration that names that cohort.
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
select throws_ok($$select pg_temp.import('a.csv', pg_temp.statement(array[pg_temp.stmt(pg_temp.today() - 3, 'Pix enviado', 'X', -100)]), 'COHORT', pg_temp.a())$$,
  '42501', 'ADMIN_MASTER_REQUIRED', 'a cohort ADMIN cannot import the shared account evidence');
select pg_temp.ctx(pg_temp.master(), 'all');
select throws_ok($$select pg_temp.import('a.csv', pg_temp.statement(array[pg_temp.stmt(pg_temp.today() - 3, 'Pix enviado', 'X', -100)]), 'GLOBAL', null)$$,
  '22023', 'COHORT_REQUIRED', 'not in "Todas as turmas": the import runs inside a cohort');
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select throws_ok($$select pg_temp.import('a.csv', pg_temp.statement(array[pg_temp.stmt(pg_temp.today() - 3, 'Pix enviado', 'X', -100)]), 'COHORT', pg_temp.b())$$,
  '22023', 'PICPAY_DECLARATION_COHORT_MISMATCH', 'the declared cohort must be the cohort of the request, named explicitly');

-- 2. File 1, declared "integralmente da Turma A": a pending Pix and a Cofrinho transfer.
select lives_ok($$select pg_temp.import('extrato-a.csv', pg_temp.statement(array[
  pg_temp.stmt(pg_temp.today() - 3, 'Pix enviado', 'Fornecedor A', -1000),
  pg_temp.stmt(pg_temp.today() - 3, 'Pix enviado', 'Pendente A', -100),
  pg_temp.stmt(pg_temp.today() - 3, 'Dinheiro guardado', 'Guardado A', -2000)]), 'COHORT', pg_temp.a())$$, 'file 1 is imported as Turma A''s');
-- File 2, MISTO/GLOBAL: a pending Pix, a Cofrinho transfer and an expense B will claim.
select lives_ok($$select pg_temp.import('extrato-global.csv', pg_temp.statement(array[
  pg_temp.stmt(pg_temp.today() - 2, 'Pix enviado', 'Fornecedor global', -700),
  pg_temp.stmt(pg_temp.today() - 2, 'Dinheiro guardado', 'Guardado global', -300),
  pg_temp.stmt(pg_temp.today() - 2, 'Pix enviado', 'Despesa B', -450)]), 'GLOBAL', null)$$, 'file 2 is imported as mixed/global');
-- File 3, Minhas vendas, MISTO/GLOBAL: two historical sales (Pix and credit card) of 20 days ago.
select lives_ok($$select pg_temp.import('vendas-historico.csv', pg_temp.sales(array[
  pg_temp.sale(pg_temp.br(pg_temp.today() - 20) || ' 10:00:00', pg_temp.today() - 20, 'Pix', 'QR Code PicPay', 1100, 0, 0, 0, 'Aprovada', '', '', 'E0E0000000000000000000000000001'),
  pg_temp.sale(pg_temp.br(pg_temp.today() - 20) || ' 11:00:00', pg_temp.today() + 10, 'Crédito', 'PicPay Mini', 1700, 61, 0, 0, 'Aprovada', '1000001', '200001', '2000000000000000001')]),
  'GLOBAL', null)$$, 'file 3 (Minhas vendas) is imported as mixed/global');
reset role;
insert into ids select 'statement_a', id from public.picpay_statement_imports where file_name = 'extrato-a.csv';
insert into ids select 'statement_global', id from public.picpay_statement_imports where file_name = 'extrato-global.csv';
insert into ids select 'sales_global', id from public.picpay_source_imports where file_name = 'vendas-historico.csv';

select is(pg_temp.line_cohort('Fornecedor A'), pg_temp.a(), 'the declaration attributes file 1''s lines to A');
select is((select scope::text || ':' || declared_cohort_id from public.picpay_import_declarations where statement_import_id = pg_temp.id('statement_a')),
  'COHORT:' || pg_temp.a(), 'the declaration is recorded with its cohort');
select is(pg_temp.line_cohort('Guardado A'), pg_temp.a(), 'the automatically resolved Cofrinho transfer counts in the declared cohort');
select ok(pg_temp.line_cohort('Fornecedor global') is null and pg_temp.resolution_cohort('Guardado global') is null,
  'a mixed file''s lines stay unassigned, including the automatic Cofrinho transfer (no origin, no cohort)');
select is((select count(*)::integer from cohort_data.picpay_evidence_attributions where transaction_id is not null), 0,
  'the mixed Minhas vendas file attributes no transaction');

-- 3. Isolation off (the deploy state): every read behaves as before, so B still inherits A's evidence.
select pg_temp.ctx(pg_temp.admin_b(), pg_temp.b()::text);
reset role;
select is(pg_temp.balance('PICPAY_EMPRESAS'), -4550::bigint, 'isolation off: B still reads every line (legacy behaviour, the reason for the switch)');

-- 4. Isolation is activated once by ADMIN_MASTER, with a reason and audit; it never goes back.
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
select throws_ok($$select public.activate_picpay_attribution_isolation('Isolamento ativado no teste', 'e0-on-admin', gen_random_uuid())$$,
  '42501', 'ADMIN_MASTER_REQUIRED', 'a cohort ADMIN cannot activate isolation');
select pg_temp.ctx(pg_temp.master(), 'all');
select throws_ok($$select public.activate_picpay_attribution_isolation('curto', 'e0-on-short', gen_random_uuid())$$,
  '22023', 'INVALID_PICPAY_ISOLATION', 'activation needs a reason');
select is((select (result ->> 'active') || '/' || (result ->> 'activated_now') from (select public.activate_picpay_attribution_isolation(
  'Isolamento ativado no teste', 'e0-on', gen_random_uuid()) as result) activated), 'true/true', 'ADMIN_MASTER activates isolation');
select is((select (result ->> 'active') || '/' || (result ->> 'activated_now') || '/' || (result ->> 'reason') from (select public.activate_picpay_attribution_isolation(
  'Ativando de novo no teste', 'e0-on-again', gen_random_uuid()) as result) again), 'true/false/Isolamento ativado no teste',
  'activating again changes nothing and keeps the original reason');
reset role;
select is((select count(*)::integer || ':' || coalesce(min(cohort_id::text), 'GLOBAL') from public.audit_logs where action = 'finance.picpay.isolation_activated'),
  '1:GLOBAL', 'the activation is audited once, as a global operation');
select ok(to_regprocedure('public.set_picpay_attribution_enforcement(boolean,text,text,uuid)') is null
  and not exists (select 1 from pg_proc where proname ~ '(deactivate|disable).*picpay'), 'there is no RPC to turn isolation off');
select throws_ok($$update private.picpay_attribution_settings set enforced = false where id$$, 'P0001', 'PICPAY_ISOLATION_IRREVERSIBLE',
  'not even a direct update turns it off');
select throws_ok($$delete from private.picpay_attribution_settings$$, 'P0001', 'PICPAY_ISOLATION_IRREVERSIBLE', 'nor removes the setting');

-- 5. Books with isolation on: each cohort counts only its own evidence; unassigned evidence counts nowhere.
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
reset role;
select is(pg_temp.balance('PICPAY_EMPRESAS'), -3100::bigint, 'A: its pending Pix lines and its transfer move PicPay Empresas; the global lines do not');
select is(pg_temp.balance('COFRINHO_PICPAY'), 2500::bigint, 'A: Cofrinho = opening 5,00 + its own transfer 20,00 (the global transfer is not A''s)');
select is(pg_temp.indicator('gross_revenue_cents'), 0::bigint, 'A: the unassigned Minhas vendas revenue is not A''s historical revenue');
select is(pg_temp.balance('RECEBIVEIS_PICPAY'), 0::bigint, 'A: nor its receivables');
select is((private.compute_management_indicators(pg_temp.today() - 40, pg_temp.today()) -> 'pending' ->> 'statement_lines_pending')::integer, 2,
  'A: two pending statement lines (its own)');
select pg_temp.ctx(pg_temp.admin_b(), pg_temp.b()::text);
reset role;
select is(pg_temp.balance('PICPAY_EMPRESAS'), 0::bigint, 'B: zero on PicPay Empresas');
select is(pg_temp.balance('COFRINHO_PICPAY'), 0::bigint, 'B: zero on the Cofrinho');
select is(pg_temp.balance('RECEBIVEIS_PICPAY') + pg_temp.balance('PENDENTE_LIQUIDACAO'), 0::bigint, 'B: zero receivables');
select is(pg_temp.indicator('gross_revenue_cents'), 0::bigint, 'B: zero historical revenue');
select is((private.compute_management_indicators(pg_temp.today() - 40, pg_temp.today()) -> 'pending' ->> 'statement_lines_pending')::integer, 0,
  'B: no pending statement line');

-- 6. Lists: the cohort's own; ADMIN_MASTER also the unassigned; nobody another cohort's.
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
select is((select jsonb_agg(item ->> 'file_name') from jsonb_array_elements(public.list_picpay_statement_imports(null, 50) -> 'items') item),
  '["extrato-a.csv"]'::jsonb, 'A''s ADMIN sees only the file with A''s lines');
select is(jsonb_array_length(public.list_picpay_transactions(pg_temp.today() - 40, pg_temp.today(), null, false, 100)), 0,
  'A''s ADMIN sees no unassigned Minhas vendas transaction');
select pg_temp.ctx(pg_temp.admin_b(), pg_temp.b()::text);
select is(jsonb_array_length(public.list_picpay_statement_imports(null, 50) -> 'items'), 0, 'B''s ADMIN sees no file');
select throws_ok(format($$select public.list_picpay_statement_lines(%L, false, null, 100)$$, pg_temp.id('statement_a')),
  'P0001', 'STATEMENT_IMPORT_NOT_FOUND', 'B''s ADMIN cannot open A''s file');
select is((select count(*)::integer from jsonb_array_elements(public.list_picpay_exceptions(pg_temp.today() - 40, pg_temp.today(), 'EXTRATO_NAO_CLASSIFICADO', false))), 0,
  'B''s ADMIN sees no unclassified line exception of A or of the global evidence');
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select is(jsonb_array_length(public.list_picpay_statement_imports(null, 50) -> 'items'), 2, 'ADMIN_MASTER sees both statement files');
select is((select count(*)::integer from jsonb_array_elements(public.list_picpay_statement_lines(pg_temp.id('statement_global'), false, null, 100) -> 'items') item
  where item ->> 'cohort_id' is null), 3, 'ADMIN_MASTER sees the global lines, labelled without a cohort');
select is(jsonb_array_length(public.list_picpay_transactions(pg_temp.today() - 40, pg_temp.today(), null, false, 100)), 2,
  'ADMIN_MASTER sees the unassigned transactions');
select is((select (status -> 'unassigned' ->> 'statement_lines') || '/' || (status -> 'unassigned' ->> 'statement_net_cents') || '/'
    || (status -> 'unassigned' ->> 'transactions') from (select public.picpay_attribution_status() as status) s),
  '3/-1450/2', 'the status shows what would leave the books: 3 lines (−14,50) and 2 transactions');

-- 7. Manual decisions: inside a concrete cohort, on the cohort's evidence; they attribute what was unassigned.
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
select throws_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'FORNECEDOR', null, null, null, 'e0-admin-global', gen_random_uuid())$$,
  pg_temp.line('Fornecedor global')), '42501', 'PICPAY_EVIDENCE_NOT_ATTRIBUTED', 'a cohort ADMIN cannot decide about unassigned evidence');
select lives_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'FORNECEDOR', null, null, null, 'e0-classify-a', gen_random_uuid())$$,
  pg_temp.line('Fornecedor A')), 'A''s ADMIN classifies A''s line');
select is(pg_temp.resolution_cohort('Fornecedor A'), pg_temp.a(), 'the classification records cohort A');
select pg_temp.ctx(pg_temp.admin_b(), pg_temp.b()::text);
select throws_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'FORNECEDOR', null, null, null, 'e0-b-classify', gen_random_uuid())$$,
  pg_temp.line('Pendente A')), '42501', 'PICPAY_EVIDENCE_ATTRIBUTED_TO_ANOTHER_COHORT', 'B''s ADMIN cannot touch A''s line');
select pg_temp.ctx(pg_temp.master(), 'all');
select throws_ok(format($$select public.resolve_picpay_statement_line(%L, 'CLASSIFICAR', 'FORNECEDOR', null, null, null, 'e0-all', gen_random_uuid())$$,
  pg_temp.line('Fornecedor global')), '22023', 'COHORT_REQUIRED', '"Todas as turmas" cannot classify');

-- 8. A resolution tied to a cohort record inherits it: B's manual expense, linked by ADMIN_MASTER inside B.
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
insert into ids select 'entry_b', (public.record_finance_entry('EXPENSE', 'MATERIAIS', 'PICPAY_EMPRESAS', null, 450, pg_temp.today() - 2,
  'Material da turma B', null, 'e0-entry-b', gen_random_uuid()) ->> 'id')::uuid;
select lives_ok(format($$select public.link_picpay_statement_line(%L, null, %L, null, 'e0-link-b', gen_random_uuid())$$,
  pg_temp.line('Despesa B'), pg_temp.id('entry_b')), 'the global line is linked to B''s expense');
select is(pg_temp.resolution_cohort('Despesa B'), pg_temp.b(), 'the link inherits cohort B from the record');
select is(pg_temp.line_cohort('Guardado global'), null::uuid, 'a global line without origin stays global');
select pg_temp.ctx(pg_temp.admin_b(), pg_temp.b()::text);
select is((select (item ->> 'line_count') || '/' || (item ->> 'outflow_cents') from jsonb_array_elements(public.list_picpay_statement_imports(null, 50) -> 'items') item),
  '1/450', 'B''s ADMIN now sees the mixed file, with only B''s line in its figures');
reset role;
select is(pg_temp.balance('PICPAY_EMPRESAS'), -450::bigint, 'B: only its own expense (the linked line adds nothing)');

-- 9. ADMIN_MASTER attributes unassigned evidence: preview, confirm, idempotent, never to a second cohort.
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select is((select (preview ->> 'count') || '/' || (preview ->> 'total_cents') from (select public.preview_picpay_assignment(null, array[pg_temp.line('Fornecedor global')], null) as preview) p),
  '1/-700', 'the preview shows one line of −7,00');
select throws_ok(format($$select public.assign_picpay_evidence(null, array[%L]::uuid[], null, 'Pix da turma A no arquivo misto', 2, -700, 'e0-assign-wrong', gen_random_uuid())$$,
  pg_temp.line('Fornecedor global')), 'P0001', 'PICPAY_ASSIGNMENT_CHANGED', 'a confirmation that does not match the preview is refused');
create temp table assigned as select public.assign_picpay_evidence(null, array[pg_temp.line('Fornecedor global')], null,
  'Pix da turma A no arquivo misto', 1, -700, 'e0-assign-line', gen_random_uuid()) as result;
grant select on assigned to authenticated;
select is(pg_temp.line_cohort('Fornecedor global'), pg_temp.a(), 'the line is now A''s');
select is(public.assign_picpay_evidence(null, array[pg_temp.line('Fornecedor global')], null, 'Pix da turma A no arquivo misto', 1, -700,
  'e0-assign-line', gen_random_uuid()) ->> 'batch_id', (select result ->> 'batch_id' from assigned), 'replaying the same key returns the same batch');
reset role;
select is((select cohort_id from public.audit_logs where action = 'finance.picpay.evidence_assigned'), pg_temp.a(),
  'the assignment is audited in the cohort that received it');
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
reset role;
select is(pg_temp.balance('PICPAY_EMPRESAS'), -3800::bigint, 'A: the attributed Pix now moves A''s PicPay Empresas');
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select throws_ok(format($$select public.assign_picpay_evidence(null, array[%L]::uuid[], null, 'Tentativa de mover para B', 1, -700, 'e0-assign-b', gen_random_uuid())$$,
  pg_temp.line('Fornecedor global')), '42501', 'PICPAY_EVIDENCE_ATTRIBUTED_TO_ANOTHER_COHORT', 'an attribution never moves from A to B');

-- 10. Historical revenue in bulk: the whole Minhas vendas file, to A.
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select is((select (preview ->> 'count') || '/' || (preview ->> 'total_cents') from (select public.preview_picpay_assignment(pg_temp.id('sales_global'), null, null) as preview) p),
  '2/2800', 'the bulk preview covers the file''s two unassigned transactions');
select lives_ok(format($$select public.assign_picpay_evidence(%L, null, null, 'Histórico de Minhas vendas da Turma A', 2, 2800, 'e0-assign-sales', gen_random_uuid())$$,
  pg_temp.id('sales_global')), 'ADMIN_MASTER attributes the file to A in one operation');
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
reset role;
select is(pg_temp.indicator('gross_revenue_cents'), 2800::bigint, 'A: the historical revenue of the file counts in A');
select is(pg_temp.balance('RECEBIVEIS_PICPAY'), 1639::bigint, 'A: the card sale reaches A''s receivables, net of the real fee');
select is(pg_temp.balance('PENDENTE_LIQUIDACAO'), 1100::bigint, 'A: the Pix reaches A''s Pix in transit');
select pg_temp.ctx(pg_temp.admin_b(), pg_temp.b()::text);
reset role;
select is(pg_temp.indicator('gross_revenue_cents') + pg_temp.balance('RECEBIVEIS_PICPAY'), 0::bigint, 'B: still no revenue and no receivables');
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select throws_ok(format($$select public.assign_picpay_evidence(%L, null, null, 'Tentativa de mover para B', 0, 0, 'e0-sales-b', gen_random_uuid())$$,
  pg_temp.id('sales_global')), '22023', 'INVALID_PICPAY_ASSIGNMENT', 'nothing is left to attribute in that file');
select is((public.preview_picpay_assignment(pg_temp.id('sales_global'), null, null) ->> 'other_cohort')::integer, 2,
  'the preview in B shows the file already counts in another cohort');

-- 11. A declaration contradicted by the evidence is refused: a file "of A" carrying B's line.
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select throws_ok($$select pg_temp.import('extrato-a-2.csv', pg_temp.statement(array[
  pg_temp.stmt(pg_temp.today() - 2, 'Pix enviado', 'Despesa B', -450),
  pg_temp.stmt(pg_temp.today() - 1, 'Pix enviado', 'Outra despesa', -50)]), 'COHORT', pg_temp.a())$$,
  'P0001', 'PICPAY_DECLARATION_CONFLICT', 'a file declared as A''s cannot carry evidence that counts in B');

-- 12. A mixed file never takes the cohort of the screen: no match against the request cohort's sales, no engine link of
--     an unassigned transaction; both wait for an explicit attribution.
reset role;
insert into public.inventory_balances(location_id, product_id) values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 5, 'Estoque E0', 'e0-stock', gen_random_uuid());
select pg_temp.ctx('10000000-0000-4000-8000-000000000002', pg_temp.a()::text);
insert into ids select 'sale_a', (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
  jsonb_build_array(jsonb_build_object('product_id', '33f00000-0000-4000-8000-000000000001', 'quantity', 1)), 'e0-sale', gen_random_uuid()) ->> 'sale_id')::uuid;
insert into ids select 'attempt_a', (public.confirm_manual_payment(pg_temp.id('sale_a'), 'PIX_AREA', 'PIX-E0-0001', null, null, 'e0-pay', gen_random_uuid())
  -> 'payment_attempt' ->> 'attempt_id')::uuid;
reset role;
create temp table sale_total as select total_cents from public.sales where id = pg_temp.id('sale_a');
grant select on sale_total to authenticated;
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select lives_ok($$select pg_temp.import('extrato-misto-venda.csv', pg_temp.statement(array[
  pg_temp.stmt(pg_temp.today(), 'Pix recebido', 'Pix da venda A', (select total_cents from sale_total))]), 'GLOBAL', null)$$,
  'a mixed statement with a Pix that matches a sale of the screen''s cohort');
reset role;
select is(pg_temp.line_cohort('Pix da venda A'), null::uuid, 'the line is not matched to the sale of the screen''s cohort: it stays unassigned');
select is((select count(*)::integer from private.picpay_statement_current_resolutions where line_id = pg_temp.line('Pix da venda A')), 0,
  'and stays pending, waiting for an explicit decision');
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select lives_ok($$select pg_temp.import('vendas-misto-nativo.csv', pg_temp.sales(array[
  pg_temp.sale(to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS'), pg_temp.today(), 'Pix', 'QR Code PicPay',
    (select total_cents from sale_total), 0, 0, 0, 'Aprovada', '', '', 'E0E0000000000000000000000000009')]), 'GLOBAL', null)$$,
  'a mixed Minhas vendas file with the same native Pix');
reset role;
insert into ids select 'native_tx', id from public.picpay_transactions where transaction_ref = 'E0E0000000000000000000000000009';
select ok((select cohort_id is null from private.picpay_transaction_cohorts where transaction_id = pg_temp.id('native_tx'))
  and not exists (select 1 from private.picpay_current_links where transaction_id = pg_temp.id('native_tx')),
  'the engine does not link the unassigned transaction to the screen cohort''s payment');
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select lives_ok(format($$select public.assign_picpay_evidence(null, null, array[%L]::uuid[], 'Venda nativa da turma A', 1, %s, 'e0-assign-native', gen_random_uuid())$$,
  pg_temp.id('native_tx'), (select total_cents from sale_total)), 'after the explicit attribution to A');
select lives_ok($$select public.run_picpay_reconciliation(gen_random_uuid())$$, 'the engine runs again');
reset role;
select is((select payment_attempt_id from private.picpay_current_links where transaction_id = pg_temp.id('native_tx')), pg_temp.id('attempt_a'),
  'the transaction is linked to A''s payment, inside its own cohort');

-- 13. Isolation and nothing else: no default cohort fallback (A is the default cohort and never receives global lines).
reset role;
select is((select count(*)::integer from private.picpay_line_cohorts where cohort_id is null), 2,
  'two lines remain global (the Cofrinho transfer and the Pix of the mixed files)');
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
reset role;
select is(pg_temp.balance('COFRINHO_PICPAY'), 2500::bigint, 'the default cohort A does not receive the global Cofrinho transfer');
select is((select count(*)::integer from cohort_data.picpay_evidence_attributions where origin = 'ASSIGNMENT'), 4,
  'four items were attributed by ADMIN_MASTER (one line, three transactions)');
select throws_ok($$update cohort_data.picpay_evidence_attributions set cohort_id = cohort_id$$, 'P0001', 'IMMUTABLE_RECORD',
  'an attribution is immutable');
select ok(private.picpay_attribution_enforced(), 'isolation is still active at the end');

select * from finish();
rollback;
