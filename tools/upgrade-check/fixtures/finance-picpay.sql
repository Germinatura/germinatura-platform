-- Upgrade check fixture (local only): finance and PicPay evidence on top of the rich synthetic dataset, so the
-- upgrade check also covers the opening position, the three PicPay sources, the automatic reconciliation, a manual
-- entry and a balance check. Synthetic values only; runs through the public RPCs as the local admin fixture.
begin;

create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;
create function pg_temp.br(p_day date) returns text language sql as $$ select to_char(p_day, 'DD/MM/YYYY') $$;
create function pg_temp.brl(p_cents bigint) returns text language sql as $$
  select 'R$ ' || case when p_cents < 0 then '-' else '' end || (abs(p_cents) / 100)::text || ',' || lpad((abs(p_cents) % 100)::text, 2, '0') $$;
create function pg_temp.dot(p_cents bigint) returns text language sql as $$
  select case when p_cents < 0 then '-' else '' end || (abs(p_cents) / 100)::text || '.' || lpad((abs(p_cents) % 100)::text, 2, '0') $$;
create function pg_temp.sales_file(p_lines text[]) returns text language sql as $$
  select 'Data e hora da venda;Previsão de pagamento;Bandeira;Número do cartão;Forma de pagamento;Solução de captura;Valor da venda;'
    || 'Valor recebido comissão;Valor cancelado;Tarifa;Custo fixo;Taxa de parcelamento;Valor Líquido;Quantidade de parcelas;Status;NSU;'
    || 'Número do terminal;TID;Código de autorização;Número do pedido;Número único da transação;Pagador Picpay;Nome do comprador;Documento;'
    || 'Email;Telefone;Transação recorrente;Split;CNPJ parceiro;Valor bruto pago parceiro;Transação 3DS;ARN;' || E'\n'
    || array_to_string(p_lines, E'\n') || E'\n' $$;
create function pg_temp.sale(p_sold_at text, p_forecast date, p_method text, p_gross bigint, p_fee bigint, p_terminal text, p_nsu text, p_ref text)
returns text language sql as $$
  select concat_ws(';', p_sold_at, pg_temp.br(p_forecast), case when p_method = 'Pix' then 'Pix' else 'Elo' end,
    case when p_method = 'Pix' then '' else '509431******0001' end, p_method, case when p_method = 'Pix' then 'QR Code PicPay' else 'PicPay Mini' end,
    pg_temp.brl(p_gross), '', pg_temp.brl(0), ' ' || pg_temp.brl(p_fee), ' R$ 0,00', '', pg_temp.brl(p_gross - p_fee), '1', 'Aprovada', p_nsu,
    p_terminal, '', '', '', p_ref, '-', 'Comprador Sintético', '000.000.000-00', 'sintetico@example.com', '(00) 0000-0000', '-', '-', '-', '-', '-', '-')
  || ';' $$;
create function pg_temp.receivables_file(p_lines text[]) returns text language sql as $$
  select 'Status;Tipo de Operação;Tipo de Lançamento;Pagador Picpay;Estabelecimento;Data de pagamento;Bandeira;Número da parcela;'
    || 'Quantidade de parcelas;Número do cartão;Número único da transação;Código de autorização;NSU;Valor bruto;Valor descontado;Valor líquido;'
    || 'Solução de captura;Número do terminal;TID;Número do pedido;Nome do comprador;Documento;Email;Telefone;Transação recorrente;'
    || 'Transação 3DS;Split;Valor bruto pago parceiro;' || E'\n' || array_to_string(p_lines, E'\n') || E'\n' $$;
create function pg_temp.receivable(p_payment date, p_ref text, p_gross bigint, p_discount bigint) returns text language sql as $$
  select concat_ws(';', 'Pendente', 'Crédito', 'Crédito parcelado', '-', '0000000', pg_temp.br(p_payment), 'Elo', '1', '1', '509431******0001',
    p_ref, '000000', '000000', pg_temp.brl(p_gross), pg_temp.brl(-p_discount), pg_temp.brl(p_gross - p_discount), 'PicPay Mini', '1000001',
    '-', '-', '-', '-', '-', '-', '-', '-', '-') || ';' $$;
create function pg_temp.statement_file(p_lines text[]) returns text language sql as $$
  select 'data;movimento;descrição;tipo;valor' || E'\n' || array_to_string(p_lines, E';\r\n') || E';\r\n' $$;
create function pg_temp.stmt(p_day date, p_movement text, p_description text, p_cents bigint) returns text language sql as $$
  select to_char(p_day, 'YYYY-MM-DD') || ';' || p_movement || ';' || p_description || ';' || case when p_cents > 0 then 'Entrada' else 'Saída' end
    || ';' || pg_temp.dot(p_cents) $$;

-- The native period starts 3 days ago; the history goes back 30 days. Native Minhas vendas lines mirror seeded Pix and
-- card payments of the native period, so the reconciliation links some of them and leaves others as exceptions.
create temp table native_payments as
select attempt.id, attempt.amount_cents, attempt.integration_channel, attempt.proof_reference,
  coalesce(attempt.confirmed_at, attempt.created_at) at time zone 'America/Sao_Paulo' as paid_at,
  row_number() over (order by attempt.created_at, attempt.id) as n
from public.payment_attempts attempt
where attempt.status in ('APPROVED', 'RECONCILED')
  and attempt.integration_channel in ('PIX_AREA', 'MAQUININHA')
  and coalesce(attempt.confirmed_at, attempt.created_at) >= (pg_temp.today() - 3)::timestamp at time zone 'America/Sao_Paulo'
order by attempt.created_at, attempt.id
limit 12;

create temp table files (name text primary key, content text);
insert into files values
  ('history_sales', pg_temp.sales_file(array[
    pg_temp.sale(pg_temp.br(pg_temp.today() - 20) || ' 10:00:00', pg_temp.today() - 20, 'Pix', 1100, 0, '', '', 'E0000000000000000000000000000901'),
    pg_temp.sale(pg_temp.br(pg_temp.today() - 19) || ' 12:00:00', pg_temp.today() - 18, 'Crédito', 1700, 61, '1000001', '900001', '1000000000000000901'),
    pg_temp.sale(pg_temp.br(pg_temp.today() - 19) || ' 12:10:00', pg_temp.today() - 15, 'Crédito', 2000, 80, '1000001', '900002', '1000000000000000902')])),
  ('receivables', pg_temp.receivables_file(array[pg_temp.receivable(pg_temp.today() - 15, '1000000000000000902', 2000, 80)])),
  ('statement', pg_temp.statement_file(array[
    pg_temp.stmt(pg_temp.today() - 25, 'Dinheiro guardado', 'Cofrinho', -500),
    pg_temp.stmt(pg_temp.today() - 20, 'Pix recebido', 'Cliente Sintético', 1100),
    pg_temp.stmt(pg_temp.today() - 18, 'Recebíveis de venda', 'Recebíveis', 1639),
    pg_temp.stmt(pg_temp.today() - 15, 'Recebíveis de venda', 'Recebíveis', 1920),
    pg_temp.stmt(pg_temp.today() - 10, 'Pix enviado', 'Fornecedor Sintético', -300),
    pg_temp.stmt(pg_temp.today() - 8, 'Dinheiro resgatado', 'Cofrinho', 200)]
    || coalesce((select array_agg(pg_temp.stmt(paid_at::date, 'Pix recebido', 'Cliente Sintético', amount_cents) order by n)
       from native_payments where integration_channel = 'PIX_AREA'), array[]::text[])));
insert into files
select 'native_sales', pg_temp.sales_file(array_agg(pg_temp.sale(
  to_char(paid_at, 'DD/MM/YYYY HH24:MI:SS'), paid_at::date + case when integration_channel = 'PIX_AREA' then 0 else 1 end,
  case when integration_channel = 'PIX_AREA' then 'Pix' else 'Crédito' end, amount_cents,
  case when integration_channel = 'PIX_AREA' then 0 else greatest(1, amount_cents * 3 / 100) end,
  case when integration_channel = 'PIX_AREA' then '' else '1000001' end,
  case when integration_channel = 'PIX_AREA' then '' else '7' || lpad(n::text, 5, '0') end,
  case when integration_channel = 'PIX_AREA' then 'E' || lpad(n::text, 31, '0') else '20000000000000' || lpad(n::text, 5, '0') end) order by n))
from native_payments
having count(*) > 0;
grant select on files to authenticated;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.record_finance_opening_position(pg_temp.today() - 30, pg_temp.today() - 3, 0, 500, 0, 0,
  'Abertura do teste de upgrade', null, null, 'upgrade-check-opening', gen_random_uuid());
select public.import_picpay_file('extrato.csv', (select content from files where name = 'statement'), 'upgrade-check-statement', gen_random_uuid());
select public.import_picpay_file('recebiveis.csv', (select content from files where name = 'receivables'), 'upgrade-check-receivables', gen_random_uuid());
select public.import_picpay_file('vendas-historico.csv', (select content from files where name = 'history_sales'), 'upgrade-check-history', gen_random_uuid());
select public.import_picpay_file('vendas-nativo.csv', content, 'upgrade-check-native', gen_random_uuid()) from files where name = 'native_sales';
select public.run_picpay_reconciliation(gen_random_uuid());
select public.record_finance_entry('EXPENSE', 'FORNECEDOR', 'PICPAY_EMPRESAS', null, 300, pg_temp.today() - 10,
  'Despesa do teste de upgrade', 'UPG-0001', 'upgrade-check-expense', gen_random_uuid());
select public.record_finance_entry('TRANSFER', null, 'PICPAY_EMPRESAS', 'DINHEIRO_FISICO', 150, pg_temp.today() - 2,
  'Transferência do teste de upgrade', 'UPG-0002', 'upgrade-check-transfer', gen_random_uuid());
select public.record_finance_balance_check(pg_temp.today() - 1, 100000, 300, 'Checagem do teste de upgrade',
  'upgrade-check-balance', gen_random_uuid());
reset role;

commit;
