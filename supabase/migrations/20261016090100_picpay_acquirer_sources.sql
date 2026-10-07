-- Spec 5.8 (FIN-001, FIN-003, FIN-007): the acquirer side of the PicPay reconciliation.
--
-- PicPay Empresas exports three files, each a different truth:
--   Minhas vendas (PICPAY_SALES)       the transaction at the acquirer: method, status, gross, fees, net, payment forecast
--   Recebíveis    (PICPAY_RECEIVABLES) a snapshot of the card money still to be paid, by transaction and installment
--   Extrato       (PICPAY_STATEMENT)   the treasury movements (already modelled by picpay_statement_*)
-- The type of a file comes from its header, never from its name.
--
-- Identity and deduplication:
--   a transaction is its "Número único da transação": it exists once, whatever files bring it; every file that brings it
--   records an observation, so a later file can move it from Aprovada to Devolvida without losing the history.
--   a receivable installment is "Número único da transação" + "Número da parcela"; each Recebíveis file is a snapshot
--   that records one observation per installment it lists. Missing from a later snapshot is never proof of payment.
-- The same file (SHA-256) is refused; observations are immutable; the raw file is never stored.
--
-- Data minimisation: payer, buyer name, document, e-mail, phone, TID and order number are not kept. The card keeps only
-- its last four digits as PicPay masks it; NSU and authorization code are kept to reconcile with the point of sale.

create table public.picpay_source_imports (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  source_type public.picpay_source_type not null check (source_type in ('PICPAY_SALES', 'PICPAY_RECEIVABLES')),
  file_name text not null check (char_length(file_name) between 1 and 200 and file_name = btrim(file_name)),
  file_sha256 text not null unique check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size_bytes integer not null check (file_size_bytes > 0),
  row_count integer not null check (row_count > 0),
  period_from date not null,
  period_to date not null,
  new_count integer not null check (new_count >= 0),
  known_count integer not null check (known_count >= 0),
  updated_count integer not null check (updated_count >= 0),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint picpay_source_imports_period_valid check (period_to >= period_from),
  constraint picpay_source_imports_counts_valid check (new_count + known_count + updated_count = row_count)
);

create table public.picpay_transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_ref text not null unique check (transaction_ref ~ '^[A-Za-z0-9-]{4,64}$'),
  first_import_id uuid not null references public.picpay_source_imports(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.picpay_transaction_observations (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.picpay_source_imports(id) on delete restrict,
  transaction_id uuid not null references public.picpay_transactions(id) on delete restrict,
  line_number integer not null check (line_number >= 2),
  sold_at timestamptz not null,
  expected_payment_on date,
  brand text check (brand is null or char_length(brand) <= 40),
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  payment_label text not null check (char_length(payment_label) between 1 and 60),
  payment_kind public.picpay_payment_kind not null,
  capture_solution text check (capture_solution is null or char_length(capture_solution) <= 60),
  terminal_number text check (terminal_number is null or terminal_number ~ '^[0-9A-Za-z-]{1,32}$'),
  status public.picpay_transaction_status not null,
  status_label text not null check (char_length(status_label) between 1 and 40),
  gross_cents bigint not null check (gross_cents between 0 and 9007199254740991),
  received_commission_cents bigint not null,
  cancelled_cents bigint not null check (cancelled_cents >= 0),
  fee_cents bigint not null check (fee_cents >= 0),
  fixed_cost_cents bigint not null check (fixed_cost_cents >= 0),
  installment_fee_cents bigint not null check (installment_fee_cents >= 0),
  net_cents bigint not null check (net_cents >= 0),
  installments integer not null check (installments between 1 and 99),
  nsu text check (nsu is null or nsu ~ '^[0-9A-Za-z]{1,32}$'),
  authorization_code text check (authorization_code is null or authorization_code ~ '^[0-9A-Za-z]{1,32}$'),
  constraint picpay_transaction_observations_identity unique (import_id, transaction_id),
  -- An approved or refunded transaction explains its net: gross − fee − fixed cost − installment fee − cancelled.
  constraint picpay_transaction_observations_net_valid check (
    status not in ('APROVADA', 'DEVOLVIDA')
    or gross_cents - fee_cents - fixed_cost_cents - installment_fee_cents - cancelled_cents = net_cents
  )
);
create index picpay_transaction_observations_transaction_idx on public.picpay_transaction_observations (transaction_id);
create index picpay_transaction_observations_sold_idx on public.picpay_transaction_observations (sold_at);
create index picpay_transaction_observations_payment_idx on public.picpay_transaction_observations (expected_payment_on)
  where expected_payment_on is not null;
create index picpay_transaction_observations_status_idx on public.picpay_transaction_observations (status);

create table public.picpay_receivable_installments (
  id uuid primary key default gen_random_uuid(),
  transaction_ref text not null check (transaction_ref ~ '^[A-Za-z0-9-]{4,64}$'),
  installment_number integer not null check (installment_number between 1 and 99),
  first_import_id uuid not null references public.picpay_source_imports(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint picpay_receivable_installments_identity unique (transaction_ref, installment_number)
);

create table public.picpay_receivable_observations (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.picpay_source_imports(id) on delete restrict,
  installment_id uuid not null references public.picpay_receivable_installments(id) on delete restrict,
  line_number integer not null check (line_number >= 2),
  status_label text not null check (char_length(status_label) between 1 and 40),
  operation_type text check (operation_type is null or char_length(operation_type) <= 40),
  entry_type text check (entry_type is null or char_length(entry_type) <= 60),
  payment_on date not null,
  brand text check (brand is null or char_length(brand) <= 40),
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  installments_total integer not null check (installments_total between 1 and 99),
  gross_cents bigint not null check (gross_cents >= 0),
  discount_cents bigint not null check (discount_cents >= 0),
  net_cents bigint not null check (net_cents >= 0),
  capture_solution text check (capture_solution is null or char_length(capture_solution) <= 60),
  terminal_number text check (terminal_number is null or terminal_number ~ '^[0-9A-Za-z-]{1,32}$'),
  nsu text check (nsu is null or nsu ~ '^[0-9A-Za-z]{1,32}$'),
  constraint picpay_receivable_observations_identity unique (import_id, installment_id),
  constraint picpay_receivable_observations_net_valid check (gross_cents - discount_cents = net_cents)
);
create index picpay_receivable_observations_installment_idx on public.picpay_receivable_observations (installment_id);
create index picpay_receivable_observations_payment_idx on public.picpay_receivable_observations (payment_on);

create trigger picpay_source_imports_immutable before update or delete on public.picpay_source_imports
for each row execute function private.prevent_immutable_record_change();
create trigger picpay_transactions_immutable before update or delete on public.picpay_transactions
for each row execute function private.prevent_immutable_record_change();
create trigger picpay_transaction_observations_immutable before update or delete on public.picpay_transaction_observations
for each row execute function private.prevent_immutable_record_change();
create trigger picpay_receivable_installments_immutable before update or delete on public.picpay_receivable_installments
for each row execute function private.prevent_immutable_record_change();
create trigger picpay_receivable_observations_immutable before update or delete on public.picpay_receivable_observations
for each row execute function private.prevent_immutable_record_change();
alter table public.picpay_source_imports enable row level security;
alter table public.picpay_transactions enable row level security;
alter table public.picpay_transaction_observations enable row level security;
alter table public.picpay_receivable_installments enable row level security;
alter table public.picpay_receivable_observations enable row level security;
revoke all on public.picpay_source_imports, public.picpay_transactions, public.picpay_transaction_observations,
  public.picpay_receivable_installments, public.picpay_receivable_observations from public, anon, authenticated, service_role;

-- "R$ 1.234,56", "R$ -0,61", " R$ 0,00", "", "-" → cents; null when it is not a Brazilian amount.
create function private.parse_brl_cents(p_value text)
returns bigint language plpgsql immutable set search_path = '' as $$
declare
  v_value text := btrim(replace(replace(replace(coalesce(p_value, ''), 'R$', ''), chr(160), ''), ' ', ''));
begin
  if v_value in ('', '-') then return 0; end if;
  if v_value !~ '^-?[0-9]{1,3}(\.[0-9]{3})*,[0-9]{2}$' and v_value !~ '^-?[0-9]{1,13},[0-9]{2}$' then return null; end if;
  return (case when left(v_value, 1) = '-' then -1 else 1 end) * replace(replace(ltrim(v_value, '-'), '.', ''), ',', '')::bigint;
end;
$$;

-- "dd/mm/yyyy" (and the date part of "dd/mm/yyyy hh:mi:ss") → date; null when invalid.
create function private.parse_br_date(p_value text)
returns date language plpgsql immutable set search_path = '' as $$
declare
  v_parts text[] := regexp_match(btrim(coalesce(p_value, '')), '^([0-9]{2})/([0-9]{2})/([0-9]{4})');
begin
  if v_parts is null then return null; end if;
  return make_date(v_parts[3]::integer, v_parts[2]::integer, v_parts[1]::integer);
exception when others then
  return null;
end;
$$;

-- "dd/mm/yyyy hh:mi:ss" in São Paulo → timestamptz; null when invalid.
create function private.parse_br_timestamp(p_value text)
returns timestamptz language plpgsql immutable set search_path = '' as $$
declare
  v_parts text[] := regexp_match(btrim(coalesce(p_value, '')), '^([0-9]{2})/([0-9]{2})/([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$');
begin
  if v_parts is null then return null; end if;
  return make_timestamp(v_parts[3]::integer, v_parts[2]::integer, v_parts[1]::integer, v_parts[4]::integer, v_parts[5]::integer,
    v_parts[6]::integer) at time zone 'America/Sao_Paulo';
exception when others then
  return null;
end;
$$;

-- The last four digits of a card number already masked by PicPay; never more.
create function private.picpay_card_last4(p_value text)
returns text language sql immutable set search_path = '' as $$
  select (regexp_match(btrim(coalesce(p_value, '')), '^[0-9*]{4,}([0-9]{4})$'))[1];
$$;

create function private.picpay_optional_text(p_value text)
returns text language sql immutable set search_path = '' as $$
  select nullif(nullif(btrim(coalesce(p_value, '')), ''), '-');
$$;

-- The data lines of a PicPay CSV: BOM and CR removed, empty lines skipped, the trailing empty field PicPay adds dropped.
create function private.picpay_csv_lines(p_content text)
returns table (line_number integer, fields text[])
language plpgsql immutable set search_path = '' as $$
declare
  v_content text := p_content;
  v_lines text[];
  v_raw text;
begin
  if v_content is not null and left(v_content, 1) = chr(65279) then v_content := substr(v_content, 2); end if;
  v_lines := string_to_array(coalesce(v_content, ''), E'\n');
  for v_index in 1 .. coalesce(array_length(v_lines, 1), 0) loop
    v_raw := rtrim(v_lines[v_index], E'\r');
    continue when btrim(v_raw) = '';
    line_number := v_index;
    fields := string_to_array(v_raw, ';');
    if array_length(fields, 1) > 1 and btrim(fields[array_length(fields, 1)]) = '' then
      fields := fields[1:array_length(fields, 1) - 1];
    end if;
    return next;
  end loop;
end;
$$;

-- Which export a file is, from its header only.
create function private.detect_picpay_source(p_content text)
returns public.picpay_source_type
language plpgsql immutable set search_path = '' as $$
declare
  v_header text[];
begin
  select array_agg(lower(btrim(field)) order by ordinality) into v_header
  from (select fields from private.picpay_csv_lines(p_content) order by line_number limit 1) first_line,
    unnest(first_line.fields) with ordinality field;
  if v_header is null then return null; end if;
  if v_header = array['data', 'movimento', 'descrição', 'tipo', 'valor'] or v_header = array['data', 'movimento', 'descricao', 'tipo', 'valor'] then
    return 'PICPAY_STATEMENT';
  end if;
  if v_header[1] = 'data e hora da venda' and 'número único da transação' = any (v_header) and 'valor líquido' = any (v_header) then
    return 'PICPAY_SALES';
  end if;
  if v_header[1] = 'status' and 'número único da transação' = any (v_header) and 'número da parcela' = any (v_header)
    and 'valor líquido' = any (v_header) then
    return 'PICPAY_RECEIVABLES';
  end if;
  return null;
end;
$$;

create function private.picpay_column(p_header text[], p_name text)
returns integer language sql immutable set search_path = '' as $$
  select array_position((select array_agg(lower(btrim(field)) order by ordinality) from unnest(p_header) with ordinality field), lower(p_name));
$$;

create function private.picpay_payment_kind_of(p_label text)
returns public.picpay_payment_kind language sql immutable set search_path = '' as $$
  select case
    when lower(btrim(p_label)) = 'pix' then 'PIX'
    when lower(btrim(p_label)) like 'crédito%' or lower(btrim(p_label)) like 'credito%' then 'CREDITO'
    when lower(btrim(p_label)) like 'débito%' or lower(btrim(p_label)) like 'debito%' then 'DEBITO'
    when lower(btrim(p_label)) = 'picpay' then 'PICPAY'
    else 'OUTRO'
  end::public.picpay_payment_kind;
$$;

-- Minhas vendas, line by line. Errors carry only the physical line number and a code; line 1 is a file-level error.
create function private.parse_picpay_sales(p_content text)
returns table (
  line_number integer, transaction_ref text, sold_at timestamptz, expected_payment_on date, brand text, card_last4 text,
  payment_label text, payment_kind public.picpay_payment_kind, capture_solution text, terminal_number text,
  status public.picpay_transaction_status, status_label text, gross_cents bigint, received_commission_cents bigint,
  cancelled_cents bigint, fee_cents bigint, fixed_cost_cents bigint, installment_fee_cents bigint, net_cents bigint,
  installments integer, nsu text, authorization_code text, error_code text
)
language plpgsql stable set search_path = '' as $$
declare
  v_header text[];
  v_line record;
  v_col jsonb;
  v_now timestamptz := now();
  v_data_lines integer := 0;
begin
  if p_content is null or btrim(p_content, E' \t\r\n') = '' then line_number := 1; error_code := 'EMPTY_FILE'; return next; return; end if;
  if strpos(p_content, chr(65533)) > 0 then line_number := 1; error_code := 'INVALID_ENCODING'; return next; return; end if;
  select csv.fields into v_header from private.picpay_csv_lines(p_content) csv order by csv.line_number limit 1;
  if private.detect_picpay_source(p_content) is distinct from 'PICPAY_SALES' then line_number := 1; error_code := 'INVALID_HEADER'; return next; return; end if;
  v_col := jsonb_build_object(
    'sold', private.picpay_column(v_header, 'Data e hora da venda'), 'forecast', private.picpay_column(v_header, 'Previsão de pagamento'),
    'brand', private.picpay_column(v_header, 'Bandeira'), 'card', private.picpay_column(v_header, 'Número do cartão'),
    'method', private.picpay_column(v_header, 'Forma de pagamento'), 'capture', private.picpay_column(v_header, 'Solução de captura'),
    'gross', private.picpay_column(v_header, 'Valor da venda'), 'commission', private.picpay_column(v_header, 'Valor recebido comissão'),
    'cancelled', private.picpay_column(v_header, 'Valor cancelado'), 'fee', private.picpay_column(v_header, 'Tarifa'),
    'fixed', private.picpay_column(v_header, 'Custo fixo'), 'installment_fee', private.picpay_column(v_header, 'Taxa de parcelamento'),
    'net', private.picpay_column(v_header, 'Valor Líquido'), 'installments', private.picpay_column(v_header, 'Quantidade de parcelas'),
    'status', private.picpay_column(v_header, 'Status'), 'nsu', private.picpay_column(v_header, 'NSU'),
    'terminal', private.picpay_column(v_header, 'Número do terminal'), 'authorization', private.picpay_column(v_header, 'Código de autorização'),
    'ref', private.picpay_column(v_header, 'Número único da transação'));
  if exists (select 1 from jsonb_each(v_col) where value = 'null'::jsonb) then line_number := 1; error_code := 'INVALID_HEADER'; return next; return; end if;

  for v_line in select * from private.picpay_csv_lines(p_content) offset 1 loop
    v_data_lines := v_data_lines + 1;
    line_number := v_line.line_number; error_code := null;
    transaction_ref := null; sold_at := null; expected_payment_on := null; brand := null; card_last4 := null; payment_label := null;
    payment_kind := null; capture_solution := null; terminal_number := null; status := null; status_label := null; gross_cents := null;
    received_commission_cents := null; cancelled_cents := null; fee_cents := null; fixed_cost_cents := null; installment_fee_cents := null;
    net_cents := null; installments := null; nsu := null; authorization_code := null;
    begin
      if array_length(v_line.fields, 1) < array_length(v_header, 1) - 1 or array_length(v_line.fields, 1) > array_length(v_header, 1) then
        error_code := 'INVALID_FIELD_COUNT';
      else
        transaction_ref := btrim(v_line.fields[(v_col ->> 'ref')::integer]);
        sold_at := private.parse_br_timestamp(v_line.fields[(v_col ->> 'sold')::integer]);
        expected_payment_on := private.parse_br_date(v_line.fields[(v_col ->> 'forecast')::integer]);
        brand := left(private.picpay_optional_text(v_line.fields[(v_col ->> 'brand')::integer]), 40);
        card_last4 := private.picpay_card_last4(v_line.fields[(v_col ->> 'card')::integer]);
        payment_label := left(btrim(coalesce(v_line.fields[(v_col ->> 'method')::integer], '')), 60);
        payment_kind := private.picpay_payment_kind_of(payment_label);
        capture_solution := left(private.picpay_optional_text(v_line.fields[(v_col ->> 'capture')::integer]), 60);
        terminal_number := private.picpay_optional_text(v_line.fields[(v_col ->> 'terminal')::integer]);
        status_label := left(btrim(coalesce(v_line.fields[(v_col ->> 'status')::integer], '')), 40);
        status := case lower(status_label) when 'aprovada' then 'APROVADA' when 'negada' then 'NEGADA' when 'devolvida' then 'DEVOLVIDA'
          else 'OUTRO' end::public.picpay_transaction_status;
        gross_cents := private.parse_brl_cents(v_line.fields[(v_col ->> 'gross')::integer]);
        received_commission_cents := private.parse_brl_cents(v_line.fields[(v_col ->> 'commission')::integer]);
        cancelled_cents := abs(private.parse_brl_cents(v_line.fields[(v_col ->> 'cancelled')::integer]));
        fee_cents := abs(private.parse_brl_cents(v_line.fields[(v_col ->> 'fee')::integer]));
        fixed_cost_cents := abs(private.parse_brl_cents(v_line.fields[(v_col ->> 'fixed')::integer]));
        installment_fee_cents := abs(private.parse_brl_cents(v_line.fields[(v_col ->> 'installment_fee')::integer]));
        net_cents := private.parse_brl_cents(v_line.fields[(v_col ->> 'net')::integer]);
        installments := coalesce(nullif(btrim(coalesce(v_line.fields[(v_col ->> 'installments')::integer], '')), '')::integer, 1);
        nsu := private.picpay_optional_text(v_line.fields[(v_col ->> 'nsu')::integer]);
        authorization_code := private.picpay_optional_text(v_line.fields[(v_col ->> 'authorization')::integer]);
        if transaction_ref is null or transaction_ref !~ '^[A-Za-z0-9-]{4,64}$' then error_code := 'INVALID_TRANSACTION_REF';
        elsif sold_at is null then error_code := 'INVALID_DATE';
        elsif sold_at > v_now then error_code := 'FUTURE_DATE';
        elsif payment_label = '' or status_label = '' then error_code := 'INVALID_FIELD';
        elsif gross_cents is null or received_commission_cents is null or cancelled_cents is null or fee_cents is null
          or fixed_cost_cents is null or installment_fee_cents is null or net_cents is null or gross_cents < 0 or net_cents < 0 then
          error_code := 'INVALID_AMOUNT';
        elsif installments not between 1 and 99 then error_code := 'INVALID_FIELD';
        elsif (terminal_number is not null and terminal_number !~ '^[0-9A-Za-z-]{1,32}$') or (nsu is not null and nsu !~ '^[0-9A-Za-z]{1,32}$')
          or (authorization_code is not null and authorization_code !~ '^[0-9A-Za-z]{1,32}$') then error_code := 'INVALID_FIELD';
        elsif status in ('APROVADA', 'DEVOLVIDA')
          and gross_cents - fee_cents - fixed_cost_cents - installment_fee_cents - cancelled_cents <> net_cents then
          error_code := 'AMOUNTS_INCONSISTENT';
        end if;
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      error_code := 'INVALID_FIELD';
    end;
    return next;
  end loop;
  if v_data_lines = 0 then line_number := 1; error_code := 'NO_LINES'; return next; end if;
end;
$$;

-- Minhas vendas with the file-level checks: a transaction listed twice in the same file is an error of both lines.
create function private.picpay_sales_rows(p_content text)
returns table (
  line_number integer, transaction_ref text, sold_at timestamptz, expected_payment_on date, brand text, card_last4 text,
  payment_label text, payment_kind public.picpay_payment_kind, capture_solution text, terminal_number text,
  status public.picpay_transaction_status, status_label text, gross_cents bigint, received_commission_cents bigint,
  cancelled_cents bigint, fee_cents bigint, fixed_cost_cents bigint, installment_fee_cents bigint, net_cents bigint,
  installments integer, nsu text, authorization_code text, error_code text
)
language sql stable set search_path = '' as $$
  select parsed.line_number, parsed.transaction_ref, parsed.sold_at, parsed.expected_payment_on, parsed.brand, parsed.card_last4,
    parsed.payment_label, parsed.payment_kind, parsed.capture_solution, parsed.terminal_number, parsed.status, parsed.status_label,
    parsed.gross_cents, parsed.received_commission_cents, parsed.cancelled_cents, parsed.fee_cents, parsed.fixed_cost_cents,
    parsed.installment_fee_cents, parsed.net_cents, parsed.installments, parsed.nsu, parsed.authorization_code,
    case when parsed.error_code is null and parsed.transaction_ref is not null
      and count(*) over (partition by parsed.transaction_ref) > 1 then 'DUPLICATE_TRANSACTION' else parsed.error_code end
  from private.parse_picpay_sales(p_content) parsed
  order by parsed.line_number;
$$;

-- Recebíveis, line by line.
create function private.parse_picpay_receivables(p_content text)
returns table (
  line_number integer, transaction_ref text, installment_number integer, installments_total integer, status_label text,
  operation_type text, entry_type text, payment_on date, brand text, card_last4 text, gross_cents bigint, discount_cents bigint,
  net_cents bigint, capture_solution text, terminal_number text, nsu text, error_code text
)
language plpgsql stable set search_path = '' as $$
declare
  v_header text[];
  v_line record;
  v_col jsonb;
  v_data_lines integer := 0;
  v_discount bigint;
begin
  if p_content is null or btrim(p_content, E' \t\r\n') = '' then line_number := 1; error_code := 'EMPTY_FILE'; return next; return; end if;
  if strpos(p_content, chr(65533)) > 0 then line_number := 1; error_code := 'INVALID_ENCODING'; return next; return; end if;
  select csv.fields into v_header from private.picpay_csv_lines(p_content) csv order by csv.line_number limit 1;
  if private.detect_picpay_source(p_content) is distinct from 'PICPAY_RECEIVABLES' then line_number := 1; error_code := 'INVALID_HEADER'; return next; return; end if;
  v_col := jsonb_build_object(
    'status', private.picpay_column(v_header, 'Status'), 'operation', private.picpay_column(v_header, 'Tipo de Operação'),
    'entry', private.picpay_column(v_header, 'Tipo de Lançamento'), 'payment', private.picpay_column(v_header, 'Data de pagamento'),
    'brand', private.picpay_column(v_header, 'Bandeira'), 'installment', private.picpay_column(v_header, 'Número da parcela'),
    'installments', private.picpay_column(v_header, 'Quantidade de parcelas'), 'card', private.picpay_column(v_header, 'Número do cartão'),
    'ref', private.picpay_column(v_header, 'Número único da transação'), 'nsu', private.picpay_column(v_header, 'NSU'),
    'gross', private.picpay_column(v_header, 'Valor bruto'), 'discount', private.picpay_column(v_header, 'Valor descontado'),
    'net', private.picpay_column(v_header, 'Valor líquido'), 'capture', private.picpay_column(v_header, 'Solução de captura'),
    'terminal', private.picpay_column(v_header, 'Número do terminal'));
  if exists (select 1 from jsonb_each(v_col) where value = 'null'::jsonb) then line_number := 1; error_code := 'INVALID_HEADER'; return next; return; end if;

  for v_line in select * from private.picpay_csv_lines(p_content) offset 1 loop
    v_data_lines := v_data_lines + 1;
    line_number := v_line.line_number; error_code := null;
    transaction_ref := null; installment_number := null; installments_total := null; status_label := null; operation_type := null;
    entry_type := null; payment_on := null; brand := null; card_last4 := null; gross_cents := null; discount_cents := null;
    net_cents := null; capture_solution := null; terminal_number := null; nsu := null;
    begin
      if array_length(v_line.fields, 1) < array_length(v_header, 1) - 1 or array_length(v_line.fields, 1) > array_length(v_header, 1) then
        error_code := 'INVALID_FIELD_COUNT';
      else
        transaction_ref := btrim(v_line.fields[(v_col ->> 'ref')::integer]);
        installment_number := coalesce(nullif(btrim(coalesce(v_line.fields[(v_col ->> 'installment')::integer], '')), '')::integer, 1);
        installments_total := coalesce(nullif(btrim(coalesce(v_line.fields[(v_col ->> 'installments')::integer], '')), '')::integer, 1);
        status_label := left(btrim(coalesce(v_line.fields[(v_col ->> 'status')::integer], '')), 40);
        operation_type := left(private.picpay_optional_text(v_line.fields[(v_col ->> 'operation')::integer]), 40);
        entry_type := left(private.picpay_optional_text(v_line.fields[(v_col ->> 'entry')::integer]), 60);
        payment_on := private.parse_br_date(v_line.fields[(v_col ->> 'payment')::integer]);
        brand := left(private.picpay_optional_text(v_line.fields[(v_col ->> 'brand')::integer]), 40);
        card_last4 := private.picpay_card_last4(v_line.fields[(v_col ->> 'card')::integer]);
        gross_cents := private.parse_brl_cents(v_line.fields[(v_col ->> 'gross')::integer]);
        v_discount := private.parse_brl_cents(v_line.fields[(v_col ->> 'discount')::integer]);
        discount_cents := abs(v_discount);
        net_cents := private.parse_brl_cents(v_line.fields[(v_col ->> 'net')::integer]);
        capture_solution := left(private.picpay_optional_text(v_line.fields[(v_col ->> 'capture')::integer]), 60);
        terminal_number := private.picpay_optional_text(v_line.fields[(v_col ->> 'terminal')::integer]);
        nsu := private.picpay_optional_text(v_line.fields[(v_col ->> 'nsu')::integer]);
        if transaction_ref is null or transaction_ref !~ '^[A-Za-z0-9-]{4,64}$' then error_code := 'INVALID_TRANSACTION_REF';
        elsif installment_number not between 1 and 99 or installments_total not between 1 and 99 or installment_number > installments_total then
          error_code := 'INVALID_FIELD';
        elsif payment_on is null then error_code := 'INVALID_DATE';
        elsif status_label = '' then error_code := 'INVALID_FIELD';
        elsif gross_cents is null or v_discount is null or net_cents is null or gross_cents < 0 or net_cents < 0 then error_code := 'INVALID_AMOUNT';
        elsif gross_cents - discount_cents <> net_cents then error_code := 'AMOUNTS_INCONSISTENT';
        elsif (terminal_number is not null and terminal_number !~ '^[0-9A-Za-z-]{1,32}$') or (nsu is not null and nsu !~ '^[0-9A-Za-z]{1,32}$') then
          error_code := 'INVALID_FIELD';
        end if;
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      error_code := 'INVALID_FIELD';
    end;
    return next;
  end loop;
  if v_data_lines = 0 then line_number := 1; error_code := 'NO_LINES'; return next; end if;
end;
$$;

create function private.picpay_receivables_rows(p_content text)
returns table (
  line_number integer, transaction_ref text, installment_number integer, installments_total integer, status_label text,
  operation_type text, entry_type text, payment_on date, brand text, card_last4 text, gross_cents bigint, discount_cents bigint,
  net_cents bigint, capture_solution text, terminal_number text, nsu text, error_code text
)
language sql stable set search_path = '' as $$
  select parsed.line_number, parsed.transaction_ref, parsed.installment_number, parsed.installments_total, parsed.status_label,
    parsed.operation_type, parsed.entry_type, parsed.payment_on, parsed.brand, parsed.card_last4, parsed.gross_cents,
    parsed.discount_cents, parsed.net_cents, parsed.capture_solution, parsed.terminal_number, parsed.nsu,
    case when parsed.error_code is null and parsed.transaction_ref is not null
      and count(*) over (partition by parsed.transaction_ref, parsed.installment_number) > 1 then 'DUPLICATE_INSTALLMENT' else parsed.error_code end
  from private.parse_picpay_receivables(p_content) parsed
  order by parsed.line_number;
$$;

-- The current state of each transaction, derived from all its observations and independent of import order:
-- Devolvida supersedes Aprovada, Aprovada supersedes Negada, and among equal statuses the latest import wins.
create view private.picpay_transaction_state as
  select distinct on (observation.transaction_id)
    observation.transaction_id, transaction.transaction_ref, observation.id as observation_id, observation.import_id,
    observation.sold_at, (observation.sold_at at time zone 'America/Sao_Paulo')::date as sold_on, observation.expected_payment_on,
    observation.brand, observation.card_last4, observation.payment_label, observation.payment_kind, observation.capture_solution,
    observation.terminal_number, observation.status, observation.status_label, observation.gross_cents, observation.cancelled_cents,
    observation.fee_cents, observation.fixed_cost_cents, observation.installment_fee_cents,
    observation.fee_cents + observation.fixed_cost_cents + observation.installment_fee_cents as total_fee_cents,
    observation.net_cents, observation.installments, observation.nsu, observation.authorization_code,
    exists (select 1 from public.picpay_transaction_observations other where other.transaction_id = observation.transaction_id and other.status = 'NEGADA')
      and exists (select 1 from public.picpay_transaction_observations other where other.transaction_id = observation.transaction_id
        and other.status in ('APROVADA', 'DEVOLVIDA')) as status_conflict,
    (select count(distinct other.gross_cents) from public.picpay_transaction_observations other where other.transaction_id = observation.transaction_id) > 1
      as amount_conflict,
    (select count(*) from public.picpay_transaction_observations other where other.transaction_id = observation.transaction_id) as observation_count
  from public.picpay_transaction_observations observation
  join public.picpay_transactions transaction on transaction.id = observation.transaction_id
  join public.picpay_source_imports import on import.id = observation.import_id
  order by observation.transaction_id,
    case observation.status when 'DEVOLVIDA' then 3 when 'APROVADA' then 2 when 'NEGADA' then 1 else 0 end desc, import.number desc;
revoke all on private.picpay_transaction_state from public, anon, authenticated, service_role;

-- The latest observation of each receivable installment (the latest snapshot that listed it).
create view private.picpay_receivable_state as
  select distinct on (observation.installment_id)
    observation.installment_id, installment.transaction_ref, installment.installment_number, observation.import_id,
    import.number as import_number, observation.status_label, observation.operation_type, observation.entry_type, observation.payment_on,
    observation.brand, observation.card_last4, observation.installments_total, observation.gross_cents, observation.discount_cents,
    observation.net_cents, observation.terminal_number,
    (select count(*) from public.picpay_receivable_observations other where other.installment_id = observation.installment_id) as snapshot_count
  from public.picpay_receivable_observations observation
  join public.picpay_receivable_installments installment on installment.id = observation.installment_id
  join public.picpay_source_imports import on import.id = observation.import_id
  order by observation.installment_id, import.number desc;
revoke all on private.picpay_receivable_state from public, anon, authenticated, service_role;

-- Records Minhas vendas: one transaction per "Número único da transação", one observation per file.
create function private.import_picpay_sales_file(
  p_file_name text, p_content text, p_sha256 text, p_actor_id uuid, p_correlation_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_import_id uuid := gen_random_uuid();
  v_new integer;
  v_known integer;
  v_updated integer;
  v_rows integer;
  v_from date;
  v_to date;
begin
  create temporary table picpay_sales_import_rows on commit drop as select * from private.picpay_sales_rows(p_content);
  if exists (select 1 from picpay_sales_import_rows where error_code is not null) then
    raise exception using errcode = '22023', message = 'PICPAY_FILE_INVALID';
  end if;
  select count(*), min((sold_at at time zone 'America/Sao_Paulo')::date), max((sold_at at time zone 'America/Sao_Paulo')::date)
  into v_rows, v_from, v_to from picpay_sales_import_rows;
  -- Compared with what is already known: new transaction, same observation, or a change (status or amounts).
  select
    count(*) filter (where state.transaction_id is null),
    count(*) filter (where state.transaction_id is not null and state.status = parsed.status and state.gross_cents = parsed.gross_cents
      and state.net_cents = parsed.net_cents and state.cancelled_cents = parsed.cancelled_cents
      and state.total_fee_cents = parsed.fee_cents + parsed.fixed_cost_cents + parsed.installment_fee_cents),
    count(*) filter (where state.transaction_id is not null and not (state.status = parsed.status and state.gross_cents = parsed.gross_cents
      and state.net_cents = parsed.net_cents and state.cancelled_cents = parsed.cancelled_cents
      and state.total_fee_cents = parsed.fee_cents + parsed.fixed_cost_cents + parsed.installment_fee_cents))
  into v_new, v_known, v_updated
  from picpay_sales_import_rows parsed
  left join private.picpay_transaction_state state on state.transaction_ref = parsed.transaction_ref;

  insert into public.picpay_source_imports (
    id, source_type, file_name, file_sha256, file_size_bytes, row_count, period_from, period_to, new_count, known_count, updated_count,
    actor_id, correlation_id
  ) values (
    v_import_id, 'PICPAY_SALES', p_file_name, p_sha256, octet_length(convert_to(p_content, 'UTF8')), v_rows, v_from, v_to,
    v_new, v_known, v_updated, p_actor_id, p_correlation_id
  );
  insert into public.picpay_transactions (transaction_ref, first_import_id)
  select transaction_ref, v_import_id from picpay_sales_import_rows
  on conflict (transaction_ref) do nothing;
  insert into public.picpay_transaction_observations (
    import_id, transaction_id, line_number, sold_at, expected_payment_on, brand, card_last4, payment_label, payment_kind,
    capture_solution, terminal_number, status, status_label, gross_cents, received_commission_cents, cancelled_cents, fee_cents,
    fixed_cost_cents, installment_fee_cents, net_cents, installments, nsu, authorization_code
  )
  select v_import_id, transaction.id, parsed.line_number, parsed.sold_at, parsed.expected_payment_on, parsed.brand, parsed.card_last4,
    parsed.payment_label, parsed.payment_kind, parsed.capture_solution, parsed.terminal_number, parsed.status, parsed.status_label,
    parsed.gross_cents, parsed.received_commission_cents, parsed.cancelled_cents, parsed.fee_cents, parsed.fixed_cost_cents,
    parsed.installment_fee_cents, parsed.net_cents, parsed.installments, parsed.nsu, parsed.authorization_code
  from picpay_sales_import_rows parsed
  join public.picpay_transactions transaction on transaction.transaction_ref = parsed.transaction_ref;
  drop table picpay_sales_import_rows;
  return v_import_id;
end;
$$;

-- Records a Recebíveis snapshot: one installment per transaction + installment, one observation per snapshot.
create function private.import_picpay_receivables_file(
  p_file_name text, p_content text, p_sha256 text, p_actor_id uuid, p_correlation_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_import_id uuid := gen_random_uuid();
  v_new integer;
  v_known integer;
  v_updated integer;
  v_rows integer;
  v_from date;
  v_to date;
begin
  create temporary table picpay_receivables_import_rows on commit drop as select * from private.picpay_receivables_rows(p_content);
  if exists (select 1 from picpay_receivables_import_rows where error_code is not null) then
    raise exception using errcode = '22023', message = 'PICPAY_FILE_INVALID';
  end if;
  select count(*), min(payment_on), max(payment_on) into v_rows, v_from, v_to from picpay_receivables_import_rows;
  select
    count(*) filter (where state.installment_id is null),
    count(*) filter (where state.installment_id is not null and state.net_cents = parsed.net_cents and state.payment_on = parsed.payment_on
      and state.status_label = parsed.status_label),
    count(*) filter (where state.installment_id is not null and not (state.net_cents = parsed.net_cents and state.payment_on = parsed.payment_on
      and state.status_label = parsed.status_label))
  into v_new, v_known, v_updated
  from picpay_receivables_import_rows parsed
  left join private.picpay_receivable_state state
    on state.transaction_ref = parsed.transaction_ref and state.installment_number = parsed.installment_number;

  insert into public.picpay_source_imports (
    id, source_type, file_name, file_sha256, file_size_bytes, row_count, period_from, period_to, new_count, known_count, updated_count,
    actor_id, correlation_id
  ) values (
    v_import_id, 'PICPAY_RECEIVABLES', p_file_name, p_sha256, octet_length(convert_to(p_content, 'UTF8')), v_rows, v_from, v_to,
    v_new, v_known, v_updated, p_actor_id, p_correlation_id
  );
  insert into public.picpay_receivable_installments (transaction_ref, installment_number, first_import_id)
  select transaction_ref, installment_number, v_import_id from picpay_receivables_import_rows
  on conflict (transaction_ref, installment_number) do nothing;
  insert into public.picpay_receivable_observations (
    import_id, installment_id, line_number, status_label, operation_type, entry_type, payment_on, brand, card_last4, installments_total,
    gross_cents, discount_cents, net_cents, capture_solution, terminal_number, nsu
  )
  select v_import_id, installment.id, parsed.line_number, parsed.status_label, parsed.operation_type, parsed.entry_type, parsed.payment_on,
    parsed.brand, parsed.card_last4, parsed.installments_total, parsed.gross_cents, parsed.discount_cents, parsed.net_cents,
    parsed.capture_solution, parsed.terminal_number, parsed.nsu
  from picpay_receivables_import_rows parsed
  join public.picpay_receivable_installments installment
    on installment.transaction_ref = parsed.transaction_ref and installment.installment_number = parsed.installment_number;
  drop table picpay_receivables_import_rows;
  return v_import_id;
end;
$$;

revoke all on function private.parse_brl_cents(text) from public, anon, authenticated, service_role;
revoke all on function private.parse_br_date(text) from public, anon, authenticated, service_role;
revoke all on function private.parse_br_timestamp(text) from public, anon, authenticated, service_role;
revoke all on function private.picpay_card_last4(text) from public, anon, authenticated, service_role;
revoke all on function private.picpay_optional_text(text) from public, anon, authenticated, service_role;
revoke all on function private.picpay_csv_lines(text) from public, anon, authenticated, service_role;
revoke all on function private.detect_picpay_source(text) from public, anon, authenticated, service_role;
revoke all on function private.picpay_column(text[], text) from public, anon, authenticated, service_role;
revoke all on function private.picpay_payment_kind_of(text) from public, anon, authenticated, service_role;
revoke all on function private.parse_picpay_sales(text) from public, anon, authenticated, service_role;
revoke all on function private.picpay_sales_rows(text) from public, anon, authenticated, service_role;
revoke all on function private.parse_picpay_receivables(text) from public, anon, authenticated, service_role;
revoke all on function private.picpay_receivables_rows(text) from public, anon, authenticated, service_role;
revoke all on function private.import_picpay_sales_file(text, text, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.import_picpay_receivables_file(text, text, text, uuid, uuid) from public, anon, authenticated, service_role;

comment on table public.picpay_transactions is
  'PicPay transactions (Minhas vendas), one per "Número único da transação"; every file that lists one adds an observation.';
comment on table public.picpay_receivable_installments is
  'PicPay card receivables by transaction and installment; every Recebíveis snapshot that lists one adds an observation.';
