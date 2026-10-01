-- Spec 5.8 (FIN-007, FIN-003): import of the statement exported by PicPay Empresas as CSV.
--
-- Observed format: `data;movimento;descrição;tipo;valor`, ISO dates, dot decimals signed by direction and one
-- extra empty column at the end of each data line. The import never trusts the client: the database parses
-- the file, hashes it, validates every line and refuses the whole file when any line is invalid, so a corrected
-- file can be imported later without leaving half of the old one behind.
--
-- Identity of an imported line is the file plus its line number. Equal date, description and amount do not
-- make two lines the same transaction: they are kept as distinct lines. Importing the same file again (same
-- SHA-256) is refused; a replay with the same idempotency key returns the stored result.
--
-- Effects, all on the explicit PICPAY_EMPRESAS account:
--   Dinheiro guardado/resgatado   transfer PicPay ↔ Cofrinho; never revenue, expense or profit.
--   Recebíveis de venda           transfer of receivables into PicPay; no fee, NSU, sale or installment invented.
--   Pix recebido                  settles one internal Área Pix sale only when exactly one candidate exists both
--                                 ways (same amount, same São Paulo day, approved and unreconciled); otherwise
--                                 it waits for review.
--   Pix estornado / devolvido     reversals in their real direction: an outflow undoes an earlier inflow, an
--                                 inflow undoes an earlier outflow. Never new revenue.
--   Pix enviado                   waits for review (it may already be a payable settlement or a manual entry).
--   anything else                 PENDENTE_CLASSIFICACAO, without financial effect.
-- Only the movement label, the date, the amount and a masked description are kept; the raw file is not stored.

create type public.picpay_statement_movement as enum (
  'PIX_RECEBIDO', 'PIX_ENVIADO', 'PIX_ESTORNADO', 'PIX_DEVOLVIDO', 'RECEBIVEIS_VENDA', 'COFRINHO_GUARDADO',
  'COFRINHO_RESGATADO', 'DESCONHECIDO'
);
create type public.picpay_statement_resolution as enum (
  'TRANSFERENCIA', 'CONCILIADA_VENDA', 'CONCILIADA_ESTORNO', 'CLASSIFICADA', 'JA_REGISTRADO', 'REABERTA'
);

create table public.picpay_statement_imports (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  account public.finance_account not null default 'PICPAY_EMPRESAS' check (account = 'PICPAY_EMPRESAS'),
  file_name text not null check (char_length(file_name) between 1 and 200 and file_name = btrim(file_name)),
  file_sha256 text not null unique check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size_bytes integer not null check (file_size_bytes > 0),
  line_count integer not null check (line_count > 0),
  period_from date not null,
  period_to date not null,
  inflow_cents bigint not null check (inflow_cents between 0 and 9007199254740991),
  outflow_cents bigint not null check (outflow_cents between 0 and 9007199254740991),
  overlap_accepted boolean not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint picpay_statement_imports_period_valid check (period_to >= period_from)
);
create index picpay_statement_imports_period_idx on public.picpay_statement_imports (period_from, period_to);

create table public.picpay_statement_lines (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.picpay_statement_imports(id) on delete restrict,
  line_number integer not null check (line_number >= 2),
  occurred_on date not null,
  movement public.picpay_statement_movement not null,
  movement_label text not null check (char_length(movement_label) between 1 and 60),
  amount_cents bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 9007199254740991),
  description text check (description is null or char_length(description) <= 140),
  constraint picpay_statement_lines_identity unique (import_id, line_number)
);
create index picpay_statement_lines_day_idx on public.picpay_statement_lines (occurred_on);

create table public.picpay_statement_line_resolutions (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  line_id uuid not null references public.picpay_statement_lines(id) on delete restrict,
  resolution public.picpay_statement_resolution not null,
  category public.finance_category,
  counter_account public.finance_account,
  payment_attempt_id uuid references public.payment_attempts(id) on delete restrict,
  reconciliation_id uuid unique references public.payment_reconciliations(id) on delete restrict,
  refund_entry_id uuid references public.financial_ledger_entries(id) on delete restrict,
  reason text check (reason is null or (char_length(reason) between 3 and 300 and reason = btrim(reason))),
  automatic boolean not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint picpay_statement_line_resolutions_shape_valid check (
    (resolution = 'TRANSFERENCIA' and counter_account is not null and counter_account <> 'PICPAY_EMPRESAS'
      and category is null and payment_attempt_id is null and refund_entry_id is null)
    or (resolution = 'CONCILIADA_VENDA' and payment_attempt_id is not null and reconciliation_id is not null
      and category is null and counter_account is null and refund_entry_id is null)
    or (resolution = 'CONCILIADA_ESTORNO' and refund_entry_id is not null
      and category is null and counter_account is null and payment_attempt_id is null)
    or (resolution = 'CLASSIFICADA' and category is not null and category not in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA')
      and counter_account is null and payment_attempt_id is null and refund_entry_id is null)
    or (resolution in ('JA_REGISTRADO', 'REABERTA') and reason is not null
      and category is null and counter_account is null and payment_attempt_id is null and refund_entry_id is null)
  )
);
create index picpay_statement_line_resolutions_line_idx on public.picpay_statement_line_resolutions (line_id, sequence desc);
create index picpay_statement_line_resolutions_refund_idx on public.picpay_statement_line_resolutions (refund_entry_id)
  where refund_entry_id is not null;

create trigger picpay_statement_imports_immutable before update or delete on public.picpay_statement_imports
for each row execute function private.prevent_immutable_record_change();
create trigger picpay_statement_lines_immutable before update or delete on public.picpay_statement_lines
for each row execute function private.prevent_immutable_record_change();
create trigger picpay_statement_line_resolutions_immutable before update or delete on public.picpay_statement_line_resolutions
for each row execute function private.prevent_immutable_record_change();
alter table public.picpay_statement_imports enable row level security;
alter table public.picpay_statement_lines enable row level security;
alter table public.picpay_statement_line_resolutions enable row level security;
revoke all on public.picpay_statement_imports, public.picpay_statement_lines, public.picpay_statement_line_resolutions
  from public, anon, authenticated, service_role;

-- The latest decision about each line; history stays in the append-only resolutions.
create view private.picpay_statement_current_resolutions as
  select distinct on (line_id) * from public.picpay_statement_line_resolutions order by line_id, sequence desc;
revoke all on private.picpay_statement_current_resolutions from public, anon, authenticated, service_role;

-- Document numbers (CPF, CNPJ, accounts) in free text are masked before anything is stored.
create function private.mask_statement_text(p_value text, p_max integer)
returns text language sql immutable set search_path = '' as $$
  select nullif(left(btrim(regexp_replace(regexp_replace(coalesce(p_value, ''), '[0-9]([./-]?[0-9]){5,}', '[doc]', 'g'),
    '\s+', ' ', 'g')), p_max), '');
$$;

-- Parses the CSV text. File-level errors come back as line 1; line errors carry only the line number and code.
create function private.parse_picpay_statement(p_content text)
returns table (
  line_number integer, occurred_on date, movement public.picpay_statement_movement, movement_label text,
  amount_cents bigint, description text, error_code text
)
language plpgsql stable set search_path = '' as $$
declare
  v_content text := p_content;
  v_lines text[];
  v_fields text[];
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_raw text;
  v_value text;
  v_type text;
  v_label text;
  v_data_lines integer := 0;
begin
  if v_content is not null and left(v_content, 1) = chr(65279) then
    v_content := substr(v_content, 2);
  end if;
  if v_content is null or btrim(v_content, E' \t\r\n') = '' then
    line_number := 1; error_code := 'EMPTY_FILE'; return next; return;
  end if;
  if strpos(v_content, chr(65533)) > 0 then
    line_number := 1; error_code := 'INVALID_ENCODING'; return next; return;
  end if;
  v_lines := string_to_array(v_content, E'\n');
  if array_length(v_lines, 1) > 20001 then
    line_number := 1; error_code := 'TOO_MANY_LINES'; return next; return;
  end if;
  if lower(rtrim(btrim(v_lines[1], E' \t\r'), ';')) not in ('data;movimento;descrição;tipo;valor', 'data;movimento;descricao;tipo;valor') then
    line_number := 1; error_code := 'INVALID_HEADER'; return next; return;
  end if;

  for v_index in 2 .. array_length(v_lines, 1) loop
    v_raw := rtrim(v_lines[v_index], E'\r');
    continue when btrim(v_raw) = '';
    v_data_lines := v_data_lines + 1;
    line_number := v_index; occurred_on := null; movement := null; movement_label := null;
    amount_cents := null; description := null; error_code := null;

    v_fields := string_to_array(v_raw, ';');
    -- PicPay ends each data line with one extra `;`.
    if array_length(v_fields, 1) = 6 and btrim(v_fields[6]) = '' then
      v_fields := v_fields[1:5];
    end if;
    if array_length(v_fields, 1) <> 5 then
      error_code := 'INVALID_FIELD_COUNT';
    end if;

    if error_code is null then
      v_value := btrim(v_fields[1]);
      if v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        error_code := 'INVALID_DATE';
      else
        begin
          occurred_on := v_value::date;
        exception when others then
          error_code := 'INVALID_DATE';
        end;
      end if;
      if error_code is null and occurred_on < date '2020-01-01' then
        error_code := 'INVALID_DATE';
      elsif error_code is null and occurred_on > v_today then
        error_code := 'FUTURE_DATE';
      end if;
    end if;

    if error_code is null then
      v_label := btrim(v_fields[2]);
      if v_label = '' or char_length(v_label) > 60 then
        error_code := 'INVALID_MOVEMENT';
      end if;
    end if;

    if error_code is null then
      v_type := lower(btrim(v_fields[4]));
      if v_type not in ('entrada', 'saída', 'saida') then
        error_code := 'INVALID_TYPE';
      end if;
    end if;

    if error_code is null then
      v_value := btrim(v_fields[5]);
      if v_value !~ '^-?[0-9]{1,13}(\.[0-9]{1,2})?$' then
        error_code := 'INVALID_AMOUNT';
      else
        amount_cents := round(v_value::numeric * 100)::bigint;
        if amount_cents = 0 then
          error_code := 'ZERO_AMOUNT';
        elsif (v_type = 'entrada') <> (amount_cents > 0) then
          error_code := 'AMOUNT_SIGN_MISMATCH';
        end if;
      end if;
    end if;

    if error_code is not null then
      occurred_on := null; amount_cents := null;
      return next;
      continue;
    end if;

    -- A known movement in an unexpected direction is treated as unknown: no automatic effect.
    movement := case lower(v_label)
      when 'pix recebido' then case when amount_cents > 0 then 'PIX_RECEBIDO' end
      when 'pix enviado' then case when amount_cents < 0 then 'PIX_ENVIADO' end
      when 'pix estornado' then 'PIX_ESTORNADO'
      when 'pix devolvido' then 'PIX_DEVOLVIDO'
      when 'recebíveis de venda' then case when amount_cents > 0 then 'RECEBIVEIS_VENDA' end
      when 'recebiveis de venda' then case when amount_cents > 0 then 'RECEBIVEIS_VENDA' end
      when 'dinheiro guardado' then case when amount_cents < 0 then 'COFRINHO_GUARDADO' end
      when 'dinheiro resgatado' then case when amount_cents > 0 then 'COFRINHO_RESGATADO' end
    end::public.picpay_statement_movement;
    movement := coalesce(movement, 'DESCONHECIDO');
    movement_label := coalesce(private.mask_statement_text(v_label, 60), 'Movimento');
    description := private.mask_statement_text(v_fields[3], 140);
    return next;
  end loop;

  if v_data_lines = 0 then
    line_number := 1; occurred_on := null; movement := null; movement_label := null;
    amount_cents := null; description := null; error_code := 'NO_LINES';
    return next;
  end if;
end;
$$;

create type private.picpay_statement_plan_row as (
  line_number integer, occurred_on date, movement public.picpay_statement_movement, movement_label text,
  amount_cents bigint, description text, error_code text, resolution public.picpay_statement_resolution,
  counter_account public.finance_account, payment_attempt_id uuid, refund_entry_id uuid
);

-- What an import would do with each line. A sale or refund is matched only when it is the single candidate of
-- the line and the line is the single claimant of it; zero or several candidates leave the line for review.
create function private.plan_picpay_statement(p_content text)
returns setof private.picpay_statement_plan_row
language sql stable security definer set search_path = '' as $$
  with parsed as (
    select * from private.parse_picpay_statement(p_content)
  ),
  sale_candidates as (
    select line.line_number, attempt.id as attempt_id
    from parsed line
    join public.payment_attempts attempt
      on attempt.integration_channel = 'PIX_AREA' and attempt.status = 'APPROVED' and attempt.amount_cents = line.amount_cents
    where line.error_code is null and line.movement = 'PIX_RECEBIDO'
      and exists (select 1 from public.financial_ledger_entries receipt
        where receipt.payment_attempt_id = attempt.id and receipt.entry_type = 'RECEIVABLE_PICPAY'
          and (receipt.created_at at time zone 'America/Sao_Paulo')::date = line.occurred_on)
      and not exists (select 1 from public.payment_reconciliations reconciliation where reconciliation.payment_attempt_id = attempt.id)
  ),
  sale_match as (
    select candidate.line_number, min(candidate.attempt_id::text)::uuid as attempt_id
    from sale_candidates candidate group by candidate.line_number having count(*) = 1
  ),
  refund_candidates as (
    select line.line_number, refund.id as entry_id
    from parsed line
    join public.financial_ledger_entries refund on refund.entry_type = 'REFUND' and refund.amount_cents = line.amount_cents
    join public.payment_attempts attempt on attempt.id = refund.payment_attempt_id and attempt.integration_channel = 'PIX_AREA'
    where line.error_code is null and line.movement = 'PIX_ESTORNADO' and line.amount_cents < 0
      and coalesce(refund.metadata ->> 'refund_method', '') <> 'CASH_DRAWER'
      and (refund.created_at at time zone 'America/Sao_Paulo')::date = line.occurred_on
      and not exists (select 1 from private.picpay_statement_current_resolutions current
        where current.refund_entry_id = refund.id and current.resolution = 'CONCILIADA_ESTORNO')
  ),
  refund_match as (
    select candidate.line_number, min(candidate.entry_id::text)::uuid as entry_id
    from refund_candidates candidate group by candidate.line_number having count(*) = 1
  )
  select parsed.line_number, parsed.occurred_on, parsed.movement, parsed.movement_label, parsed.amount_cents,
    parsed.description, parsed.error_code,
    case
      when parsed.error_code is not null then null
      when parsed.movement in ('COFRINHO_GUARDADO', 'COFRINHO_RESGATADO', 'RECEBIVEIS_VENDA') then 'TRANSFERENCIA'
      when sale.attempt_id is not null then 'CONCILIADA_VENDA'
      when refund.entry_id is not null then 'CONCILIADA_ESTORNO'
    end::public.picpay_statement_resolution,
    case
      when parsed.error_code is not null then null
      when parsed.movement in ('COFRINHO_GUARDADO', 'COFRINHO_RESGATADO') then 'COFRINHO_PICPAY'
      when parsed.movement = 'RECEBIVEIS_VENDA' then 'RECEBIVEIS_PICPAY'
    end::public.finance_account,
    sale.attempt_id, refund.entry_id
  from parsed
  left join sale_match sale on sale.line_number = parsed.line_number
    and (select count(*) from sale_candidates other where other.attempt_id = sale.attempt_id) = 1
  left join refund_match refund on refund.line_number = parsed.line_number
    and (select count(*) from refund_candidates other where other.entry_id = refund.entry_id) = 1
  order by parsed.line_number;
$$;

create function private.picpay_statement_import_json(p_import_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', import.id, 'number', import.number, 'account', import.account, 'file_name', import.file_name,
    'file_sha256', import.file_sha256, 'file_size_bytes', import.file_size_bytes, 'line_count', import.line_count,
    'period_from', import.period_from, 'period_to', import.period_to, 'inflow_cents', import.inflow_cents,
    'outflow_cents', import.outflow_cents, 'overlap_accepted', import.overlap_accepted,
    'actor_name', coalesce(nullif(btrim(actor.display_name), ''), actor.email), 'created_at', import.created_at,
    'status_counts', (
      select jsonb_build_object(
        'TRANSFERENCIA', count(*) filter (where current.resolution = 'TRANSFERENCIA'),
        'CONCILIADA_VENDA', count(*) filter (where current.resolution = 'CONCILIADA_VENDA'),
        'CONCILIADA_ESTORNO', count(*) filter (where current.resolution = 'CONCILIADA_ESTORNO'),
        'CLASSIFICADA', count(*) filter (where current.resolution = 'CLASSIFICADA'),
        'JA_REGISTRADO', count(*) filter (where current.resolution = 'JA_REGISTRADO'),
        'PENDENTE_REVISAO', count(*) filter (where (current.resolution is null or current.resolution = 'REABERTA')
          and line.movement <> 'DESCONHECIDO'),
        'PENDENTE_CLASSIFICACAO', count(*) filter (where (current.resolution is null or current.resolution = 'REABERTA')
          and line.movement = 'DESCONHECIDO'))
      from public.picpay_statement_lines line
      left join private.picpay_statement_current_resolutions current on current.line_id = line.id
      where line.import_id = import.id)
  )
  from public.picpay_statement_imports import
  join public.profiles actor on actor.id = import.actor_id
  where import.id = p_import_id;
$$;

-- Read-only preview: what the file contains and what importing it would do. Descriptions are not returned.
create function public.preview_picpay_statement(p_content text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_sha256 text;
  v_plan jsonb;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_content is null or char_length(p_content) > 2000000 then
    raise exception using errcode = '22023', message = 'INVALID_STATEMENT_FILE';
  end if;
  v_sha256 := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  v_plan := coalesce((select jsonb_agg(to_jsonb(plan)) from private.plan_picpay_statement(p_content) plan), '[]'::jsonb);
  return (
    with plan as (select * from jsonb_populate_recordset(null::private.picpay_statement_plan_row, v_plan)),
    valid as (select * from plan where error_code is null),
    bounds as (select min(occurred_on) as period_from, max(occurred_on) as period_to from valid)
    select jsonb_build_object(
      'sha256', v_sha256,
      'size_bytes', octet_length(convert_to(p_content, 'UTF8')),
      'line_count', (select count(*) from plan where line_number >= 2),
      'error_count', (select count(*) from plan where error_code is not null),
      'errors', coalesce((select jsonb_agg(jsonb_build_object('line', line_number, 'code', error_code) order by line_number)
        from (select line_number, error_code from plan where error_code is not null order by line_number limit 100) failed), '[]'::jsonb),
      'period_from', (select period_from from bounds),
      'period_to', (select period_to from bounds),
      'inflow_cents', coalesce((select sum(amount_cents) from valid where amount_cents > 0), 0),
      'outflow_cents', coalesce((select -sum(amount_cents) from valid where amount_cents < 0), 0),
      'by_movement', coalesce((select jsonb_agg(jsonb_build_object('movement', movement, 'count', lines, 'amount_cents', total)
        order by movement) from (select movement, count(*) as lines, sum(amount_cents) as total from valid group by movement) grouped), '[]'::jsonb),
      'plan', jsonb_build_object(
        'TRANSFERENCIA', (select count(*) from valid where resolution = 'TRANSFERENCIA'),
        'CONCILIADA_VENDA', (select count(*) from valid where resolution = 'CONCILIADA_VENDA'),
        'CONCILIADA_ESTORNO', (select count(*) from valid where resolution = 'CONCILIADA_ESTORNO'),
        'PENDENTE_REVISAO', (select count(*) from valid where resolution is null and movement <> 'DESCONHECIDO'),
        'PENDENTE_CLASSIFICACAO', (select count(*) from valid where resolution is null and movement = 'DESCONHECIDO')),
      -- Same date, movement, description and amount: kept as distinct lines, shown only so nobody is surprised.
      'repeated_lines', coalesce((select sum(lines) from (
        select count(*) as lines from valid group by occurred_on, movement, movement_label, description, amount_cents
        having count(*) > 1) repeated), 0),
      'already_imported', (select jsonb_build_object('number', import.number, 'created_at', import.created_at)
        from public.picpay_statement_imports import where import.file_sha256 = v_sha256),
      'overlaps', coalesce((select jsonb_agg(jsonb_build_object('number', import.number, 'period_from', import.period_from,
          'period_to', import.period_to) order by import.number)
        from public.picpay_statement_imports import, bounds
        where import.period_from <= bounds.period_to and import.period_to >= bounds.period_from), '[]'::jsonb)
    )
  );
end;
$$;

-- Imports a valid file once, with the automatic effects the plan allows.
create function public.import_picpay_statement(
  p_file_name text, p_content text, p_accept_overlap boolean, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_import_id uuid := gen_random_uuid();
  v_number bigint;
  v_sha256 text;
  v_file_name text;
  v_plan jsonb;
  v_errors integer;
  v_lines integer;
  v_from date;
  v_to date;
  v_inflow bigint;
  v_outflow bigint;
  v_line record;
  v_attempt public.payment_attempts%rowtype;
  v_reconciliation jsonb;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  v_file_name := left(btrim(regexp_replace(regexp_replace(coalesce(p_file_name, ''), '^.*[\\/]', ''), '[0-9]{11,}', '[doc]', 'g')), 200);
  if p_correlation_id is null or p_content is null or char_length(p_content) > 2000000 or v_file_name = '' then
    raise exception using errcode = '22023', message = 'INVALID_STATEMENT_FILE';
  end if;
  v_sha256 := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'import_statement', v_actor_id), p_idempotency_key,
    jsonb_build_object('sha256', v_sha256, 'file_name', v_file_name, 'accept_overlap', coalesce(p_accept_overlap, false)));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  -- Imports run one at a time: the duplicate check and the sale matching see every earlier import.
  perform pg_advisory_xact_lock(hashtextextended('picpay-statement-import', 0));
  if exists (select 1 from public.picpay_statement_imports where file_sha256 = v_sha256) then
    raise exception using errcode = 'P0001', message = 'STATEMENT_ALREADY_IMPORTED';
  end if;

  v_plan := coalesce((select jsonb_agg(to_jsonb(plan)) from private.plan_picpay_statement(p_content) plan), '[]'::jsonb);
  select count(*) filter (where error_code is not null), count(*) filter (where error_code is null),
    min(occurred_on), max(occurred_on),
    coalesce(sum(amount_cents) filter (where error_code is null and amount_cents > 0), 0),
    coalesce(-sum(amount_cents) filter (where error_code is null and amount_cents < 0), 0)
  into v_errors, v_lines, v_from, v_to, v_inflow, v_outflow
  from jsonb_populate_recordset(null::private.picpay_statement_plan_row, v_plan);
  if v_errors > 0 or v_lines = 0 then
    raise exception using errcode = '22023', message = 'STATEMENT_INVALID';
  end if;
  if not coalesce(p_accept_overlap, false) and exists (select 1 from public.picpay_statement_imports
    where period_from <= v_to and period_to >= v_from) then
    raise exception using errcode = 'P0001', message = 'STATEMENT_PERIOD_OVERLAP';
  end if;

  insert into public.picpay_statement_imports (
    id, file_name, file_sha256, file_size_bytes, line_count, period_from, period_to, inflow_cents, outflow_cents,
    overlap_accepted, actor_id, correlation_id
  ) values (
    v_import_id, v_file_name, v_sha256, octet_length(convert_to(p_content, 'UTF8')), v_lines, v_from, v_to, v_inflow, v_outflow,
    coalesce(p_accept_overlap, false), v_actor_id, p_correlation_id
  ) returning number into v_number;
  insert into public.picpay_statement_lines (import_id, line_number, occurred_on, movement, movement_label, amount_cents, description)
  select v_import_id, plan.line_number, plan.occurred_on, plan.movement, plan.movement_label, plan.amount_cents, plan.description
  from jsonb_populate_recordset(null::private.picpay_statement_plan_row, v_plan) plan;

  insert into public.picpay_statement_line_resolutions (line_id, resolution, counter_account, automatic, actor_id, correlation_id)
  select line.id, 'TRANSFERENCIA', plan.counter_account, true, v_actor_id, p_correlation_id
  from jsonb_populate_recordset(null::private.picpay_statement_plan_row, v_plan) plan
  join public.picpay_statement_lines line on line.import_id = v_import_id and line.line_number = plan.line_number
  where plan.resolution = 'TRANSFERENCIA';

  for v_line in
    select line.id, line.line_number, line.amount_cents, plan.resolution, plan.payment_attempt_id, plan.refund_entry_id
    from jsonb_populate_recordset(null::private.picpay_statement_plan_row, v_plan) plan
    join public.picpay_statement_lines line on line.import_id = v_import_id and line.line_number = plan.line_number
    where plan.resolution in ('CONCILIADA_VENDA', 'CONCILIADA_ESTORNO')
    order by line.line_number
  loop
    if v_line.resolution = 'CONCILIADA_VENDA' then
      -- Re-checked under the attempt lock: a concurrent manual reconciliation leaves the line for review.
      select * into v_attempt from public.payment_attempts where id = v_line.payment_attempt_id for update;
      if v_attempt.status = 'APPROVED'
        and not exists (select 1 from public.payment_reconciliations where payment_attempt_id = v_attempt.id) then
        v_reconciliation := public.reconcile_payment_attempt(v_attempt.id, v_line.amount_cents, 0,
          'PICPAY-CSV-' || v_number || '-L' || v_line.line_number, 'IMPORT', 'picpay-statement:' || v_line.id, p_correlation_id);
        insert into public.picpay_statement_line_resolutions (
          line_id, resolution, payment_attempt_id, reconciliation_id, automatic, actor_id, correlation_id
        ) values (
          v_line.id, 'CONCILIADA_VENDA', v_attempt.id, (v_reconciliation ->> 'reconciliation_id')::uuid, true, v_actor_id, p_correlation_id
        );
      end if;
    else
      perform pg_advisory_xact_lock(hashtextextended('picpay-statement-refund:' || v_line.refund_entry_id, 0));
      if not exists (select 1 from private.picpay_statement_current_resolutions
        where refund_entry_id = v_line.refund_entry_id and resolution = 'CONCILIADA_ESTORNO') then
        insert into public.picpay_statement_line_resolutions (line_id, resolution, refund_entry_id, automatic, actor_id, correlation_id)
        values (v_line.id, 'CONCILIADA_ESTORNO', v_line.refund_entry_id, true, v_actor_id, p_correlation_id);
      end if;
    end if;
  end loop;

  v_result := private.picpay_statement_import_json(v_import_id) || jsonb_build_object('correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.statement.imported', v_actor_id, 'picpay_statement_import', v_import_id::text, p_correlation_id,
    jsonb_build_object('number', v_number, 'account', 'PICPAY_EMPRESAS', 'file_sha256', v_sha256, 'line_count', v_lines,
      'period_from', v_from, 'period_to', v_to, 'inflow_cents', v_inflow, 'outflow_cents', v_outflow,
      'overlap_accepted', coalesce(p_accept_overlap, false), 'status_counts', v_result -> 'status_counts'));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.statement.imported', 'picpay_statement_import', v_import_id::text,
    jsonb_build_object('import_id', v_import_id, 'number', v_number, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_statement_import', v_import_id::text);
  return v_result;
end;
$$;

create function public.list_picpay_statement_imports(p_before_number bigint default null, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_STATEMENT_FILTER';
  end if;
  select array_agg(page.id order by page.number desc) into v_ids from (
    select id, number from public.picpay_statement_imports
    where p_before_number is null or number < p_before_number
    order by number desc limit p_limit + 1
  ) page;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.picpay_statement_import_json(id) order by ordinality)
      from unnest(v_ids) with ordinality id where ordinality <= p_limit), '[]'::jsonb),
    'next_before', case when coalesce(array_length(v_ids, 1), 0) > p_limit
      then (select number from public.picpay_statement_imports where id = v_ids[p_limit]) end,
    'pending_total', (select count(*) from public.picpay_statement_lines line
      left join private.picpay_statement_current_resolutions current on current.line_id = line.id
      where current.resolution is null or current.resolution = 'REABERTA'));
end;
$$;

-- Lines of one import with their current decision and, for pending ones, the internal candidates to review.
create function public.list_picpay_statement_lines(
  p_import_id uuid, p_pending_only boolean default false, p_after_line integer default null, p_limit integer default 50
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_lines jsonb;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_import_id is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_STATEMENT_FILTER';
  end if;
  if not exists (select 1 from public.picpay_statement_imports where id = p_import_id) then
    raise exception using errcode = 'P0001', message = 'STATEMENT_IMPORT_NOT_FOUND';
  end if;
  select coalesce(jsonb_agg(item order by (item ->> 'line_number')::integer), '[]'::jsonb) into v_lines from (
    select jsonb_build_object(
      'id', line.id, 'line_number', line.line_number, 'occurred_on', line.occurred_on, 'movement', line.movement,
      'movement_label', line.movement_label, 'amount_cents', line.amount_cents, 'description', line.description,
      'status', case
        when current.resolution is null or current.resolution = 'REABERTA' then
          case when line.movement = 'DESCONHECIDO' then 'PENDENTE_CLASSIFICACAO' else 'PENDENTE_REVISAO' end
        else current.resolution::text end,
      'resolution', case when current.id is null then null else jsonb_build_object(
        'resolution', current.resolution, 'category', current.category, 'counter_account', current.counter_account,
        'payment_attempt_id', current.payment_attempt_id,
        'sale_id', (select attempt.sale_id from public.payment_attempts attempt where attempt.id = current.payment_attempt_id),
        'refund_entry_id', current.refund_entry_id,
        'refund_sale_id', (select refund.sale_id from public.financial_ledger_entries refund where refund.id = current.refund_entry_id),
        'reason', current.reason, 'automatic', current.automatic,
        'actor_name', coalesce(nullif(btrim(actor.display_name), ''), actor.email), 'created_at', current.created_at) end,
      'sale_candidates', case when (current.resolution is null or current.resolution = 'REABERTA') and line.movement = 'PIX_RECEBIDO' then
        coalesce((select jsonb_agg(jsonb_build_object('payment_attempt_id', candidate.id, 'sale_id', candidate.sale_id,
            'amount_cents', candidate.amount_cents, 'channel', candidate.integration_channel, 'approved_at', candidate.approved_at,
            'operator_name', candidate.operator_name) order by candidate.approved_at)
          from (
            select attempt.id, attempt.sale_id, attempt.amount_cents, attempt.integration_channel, receipt.created_at as approved_at,
              coalesce(nullif(btrim(operator.display_name), ''), operator.email) as operator_name
            from public.payment_attempts attempt
            join public.financial_ledger_entries receipt on receipt.payment_attempt_id = attempt.id and receipt.entry_type = 'RECEIVABLE_PICPAY'
            join public.profiles operator on operator.id = attempt.operator_id
            where attempt.status = 'APPROVED' and attempt.amount_cents = line.amount_cents
              and attempt.integration_channel in ('PIX_AREA', 'PAYMENT_LINK', 'CHECKOUT_API', 'PICPAY_WALLET')
              and (receipt.created_at at time zone 'America/Sao_Paulo')::date between line.occurred_on - 1 and line.occurred_on + 1
              and not exists (select 1 from public.payment_reconciliations reconciliation where reconciliation.payment_attempt_id = attempt.id)
            order by receipt.created_at limit 5
          ) candidate), '[]'::jsonb) else '[]'::jsonb end,
      'refund_candidates', case when (current.resolution is null or current.resolution = 'REABERTA')
        and line.movement = 'PIX_ESTORNADO' and line.amount_cents < 0 then
        coalesce((select jsonb_agg(jsonb_build_object('refund_entry_id', candidate.id, 'sale_id', candidate.sale_id,
            'amount_cents', candidate.amount_cents, 'refunded_at', candidate.created_at) order by candidate.created_at)
          from (
            select refund.id, refund.sale_id, refund.amount_cents, refund.created_at
            from public.financial_ledger_entries refund
            where refund.entry_type = 'REFUND' and refund.amount_cents = line.amount_cents
              and coalesce(refund.metadata ->> 'refund_method', '') <> 'CASH_DRAWER'
              and (refund.created_at at time zone 'America/Sao_Paulo')::date between line.occurred_on - 1 and line.occurred_on + 1
              and not exists (select 1 from private.picpay_statement_current_resolutions linked
                where linked.refund_entry_id = refund.id and linked.resolution = 'CONCILIADA_ESTORNO')
            order by refund.created_at limit 5
          ) candidate), '[]'::jsonb) else '[]'::jsonb end
    ) as item
    from public.picpay_statement_lines line
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    left join public.profiles actor on actor.id = current.actor_id
    where line.import_id = p_import_id
      and (p_after_line is null or line.line_number > p_after_line)
      and (not coalesce(p_pending_only, false) or current.resolution is null or current.resolution = 'REABERTA')
    order by line.line_number
    limit p_limit + 1
  ) page;
  return jsonb_build_object(
    'import', private.picpay_statement_import_json(p_import_id),
    'items', coalesce((select jsonb_agg(value order by ordinality) from jsonb_array_elements(v_lines) with ordinality
      where ordinality <= p_limit), '[]'::jsonb),
    'next_after', case when jsonb_array_length(v_lines) > p_limit then (v_lines -> (p_limit - 1) ->> 'line_number')::integer end);
end;
$$;

-- Review of one line: reconcile it with a sale or a refund, classify it, mark it as already recorded, or reopen.
create function public.resolve_picpay_statement_line(
  p_line_id uuid, p_action text, p_category public.finance_category, p_payment_attempt_id uuid, p_refund_entry_id uuid,
  p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_line public.picpay_statement_lines%rowtype;
  v_number bigint;
  v_current public.picpay_statement_line_resolutions%rowtype;
  v_pending boolean;
  v_attempt public.payment_attempts%rowtype;
  v_refund public.financial_ledger_entries%rowtype;
  v_reconciliation jsonb;
  v_resolution public.picpay_statement_resolution;
  v_resolution_id uuid := gen_random_uuid();
  v_reason text := nullif(btrim(p_reason), '');
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_line_id is null
    or p_action not in ('CONCILIAR_VENDA', 'CONCILIAR_ESTORNO', 'CLASSIFICAR', 'JA_REGISTRADO', 'REABRIR')
    or (v_reason is not null and char_length(v_reason) not between 3 and 300)
    or (p_action in ('JA_REGISTRADO', 'REABRIR') and (v_reason is null or char_length(v_reason) < 8))
    or (p_action = 'CONCILIAR_VENDA' and p_payment_attempt_id is null)
    or (p_action = 'CONCILIAR_ESTORNO' and p_refund_entry_id is null)
    or (p_action = 'CLASSIFICAR' and p_category is null) then
    raise exception using errcode = '22023', message = 'INVALID_STATEMENT_RESOLUTION';
  end if;
  if p_action = 'CLASSIFICAR' and p_category in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA') then
    raise exception using errcode = '22023', message = 'FINANCE_CATEGORY_AUTOMATIC_ONLY';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'resolve_statement_line', v_actor_id), p_idempotency_key,
    jsonb_build_object('line_id', p_line_id, 'action', p_action, 'category', p_category, 'payment_attempt_id', p_payment_attempt_id,
      'refund_entry_id', p_refund_entry_id, 'reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  select * into v_line from public.picpay_statement_lines where id = p_line_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_NOT_FOUND';
  end if;
  select number into v_number from public.picpay_statement_imports where id = v_line.import_id;
  select * into v_current from private.picpay_statement_current_resolutions where line_id = v_line.id;
  v_pending := v_current.id is null or v_current.resolution = 'REABERTA';

  if p_action = 'REABRIR' then
    -- Sale reconciliations created ledger entries and automatic transfers follow the movement: neither reopens.
    if v_pending or v_current.resolution not in ('CLASSIFICADA', 'JA_REGISTRADO', 'CONCILIADA_ESTORNO') then
      raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_NOT_REOPENABLE';
    end if;
    v_resolution := 'REABERTA';
    insert into public.picpay_statement_line_resolutions (id, line_id, resolution, reason, automatic, actor_id, correlation_id)
    values (v_resolution_id, v_line.id, v_resolution, v_reason, false, v_actor_id, p_correlation_id);
  else
    if not v_pending then
      raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_ALREADY_RESOLVED';
    end if;
    if p_action = 'CONCILIAR_VENDA' then
      if v_line.movement <> 'PIX_RECEBIDO' then
        raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_ACTION_NOT_ALLOWED';
      end if;
      select * into v_attempt from public.payment_attempts where id = p_payment_attempt_id for update;
      if not found or v_attempt.integration_channel not in ('PIX_AREA', 'PAYMENT_LINK', 'CHECKOUT_API', 'PICPAY_WALLET')
        or v_attempt.status <> 'APPROVED'
        or exists (select 1 from public.payment_reconciliations where payment_attempt_id = v_attempt.id) then
        raise exception using errcode = 'P0001', message = 'STATEMENT_SALE_NOT_RECONCILABLE';
      end if;
      if v_attempt.amount_cents <> v_line.amount_cents then
        raise exception using errcode = 'P0001', message = 'STATEMENT_AMOUNT_MISMATCH';
      end if;
      v_resolution := 'CONCILIADA_VENDA';
      v_reconciliation := public.reconcile_payment_attempt(v_attempt.id, v_line.amount_cents, 0,
        'PICPAY-CSV-' || v_number || '-L' || v_line.line_number, 'IMPORT', 'picpay-statement:' || v_line.id, p_correlation_id);
      insert into public.picpay_statement_line_resolutions (
        id, line_id, resolution, payment_attempt_id, reconciliation_id, reason, automatic, actor_id, correlation_id
      ) values (
        v_resolution_id, v_line.id, v_resolution, v_attempt.id, (v_reconciliation ->> 'reconciliation_id')::uuid, v_reason, false,
        v_actor_id, p_correlation_id
      );
    elsif p_action = 'CONCILIAR_ESTORNO' then
      if v_line.movement <> 'PIX_ESTORNADO' or v_line.amount_cents > 0 then
        raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_ACTION_NOT_ALLOWED';
      end if;
      perform pg_advisory_xact_lock(hashtextextended('picpay-statement-refund:' || p_refund_entry_id, 0));
      select * into v_refund from public.financial_ledger_entries where id = p_refund_entry_id;
      if not found or v_refund.entry_type <> 'REFUND' or coalesce(v_refund.metadata ->> 'refund_method', '') = 'CASH_DRAWER'
        or exists (select 1 from private.picpay_statement_current_resolutions
          where refund_entry_id = v_refund.id and resolution = 'CONCILIADA_ESTORNO') then
        raise exception using errcode = 'P0001', message = 'STATEMENT_REFUND_NOT_LINKABLE';
      end if;
      if v_refund.amount_cents <> v_line.amount_cents then
        raise exception using errcode = 'P0001', message = 'STATEMENT_AMOUNT_MISMATCH';
      end if;
      v_resolution := 'CONCILIADA_ESTORNO';
      insert into public.picpay_statement_line_resolutions (id, line_id, resolution, refund_entry_id, reason, automatic, actor_id, correlation_id)
      values (v_resolution_id, v_line.id, v_resolution, v_refund.id, v_reason, false, v_actor_id, p_correlation_id);
    elsif p_action = 'CLASSIFICAR' then
      if v_line.movement in ('COFRINHO_GUARDADO', 'COFRINHO_RESGATADO', 'RECEBIVEIS_VENDA') then
        raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_ACTION_NOT_ALLOWED';
      end if;
      v_resolution := 'CLASSIFICADA';
      insert into public.picpay_statement_line_resolutions (id, line_id, resolution, category, reason, automatic, actor_id, correlation_id)
      values (v_resolution_id, v_line.id, v_resolution, p_category, v_reason, false, v_actor_id, p_correlation_id);
    else
      v_resolution := 'JA_REGISTRADO';
      insert into public.picpay_statement_line_resolutions (id, line_id, resolution, reason, automatic, actor_id, correlation_id)
      values (v_resolution_id, v_line.id, v_resolution, v_reason, false, v_actor_id, p_correlation_id);
    end if;
  end if;

  v_result := jsonb_build_object('line_id', v_line.id, 'resolution_id', v_resolution_id, 'resolution', v_resolution,
    'category', case when v_resolution = 'CLASSIFICADA' then p_category end, 'correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.statement.line_resolved', v_actor_id, 'picpay_statement_line', v_line.id::text, p_correlation_id,
    jsonb_build_object('import_number', v_number, 'line_number', v_line.line_number, 'movement', v_line.movement,
      'amount_cents', v_line.amount_cents, 'action', p_action, 'resolution', v_resolution,
      'previous_resolution', v_current.resolution, 'category', case when v_resolution = 'CLASSIFICADA' then p_category end,
      'payment_attempt_id', case when v_resolution = 'CONCILIADA_VENDA' then p_payment_attempt_id end,
      'refund_entry_id', case when v_resolution = 'CONCILIADA_ESTORNO' then p_refund_entry_id end));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.statement.line_resolved', 'picpay_statement_line', v_line.id::text,
    jsonb_build_object('line_id', v_line.id, 'resolution', v_resolution, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_statement_line', v_line.id::text);
  return v_result;
end;
$$;

-- Income and expense flows of classified lines, in the shape of manual entries. A reversal (estornado or
-- devolvido) undoes the flow of its real direction: an outflow lowers income, an inflow lowers expense.
create function private.picpay_statement_flows(p_from date, p_to date)
returns table (kind public.finance_manual_entry_kind, category public.finance_category, amount_cents bigint, day date)
language sql stable security definer set search_path = '' as $$
  select
    case
      when line.movement in ('PIX_ESTORNADO', 'PIX_DEVOLVIDO') then case when line.amount_cents < 0 then 'INCOME' else 'EXPENSE' end
      else case when line.amount_cents > 0 then 'INCOME' else 'EXPENSE' end
    end::public.finance_manual_entry_kind,
    current.category,
    case
      when line.movement in ('PIX_ESTORNADO', 'PIX_DEVOLVIDO') then -abs(line.amount_cents)
      else abs(line.amount_cents)
    end,
    line.occurred_on
  from public.picpay_statement_lines line
  join private.picpay_statement_current_resolutions current on current.line_id = line.id
  where current.resolution = 'CLASSIFICADA' and line.occurred_on between p_from and p_to;
$$;

-- The consolidated statement gains the imported PicPay movements that carry an effect of their own: automatic
-- transfers and classified lines. Reconciled lines already appear through the sale ledger.
create or replace function private.finance_statement_rows(p_from date, p_to date)
returns table (
  occurred_on date, source text, source_id uuid, category public.finance_category, account public.finance_account,
  amount_cents bigint, description text, reference text
)
language sql stable security definer set search_path = '' as $$
  with sale_ledger as (
    select entry.*, (entry.created_at at time zone 'America/Sao_Paulo')::date as day,
      case
        when exists (select 1 from public.raffle_numbers number where number.sale_id = entry.sale_id) then 'RIFA'
        when sale.channel = 'PDV' then 'VENDA_PDV'
        when sale.channel = 'PORTAL' then 'VENDA_ONLINE'
        else 'RESERVA'
      end::public.finance_category as revenue_category,
      attempt.integration_channel,
      exists (select 1 from public.financial_ledger_entries settled
        where settled.payment_attempt_id = entry.payment_attempt_id and settled.entry_type = 'SETTLEMENT') as settled
    from public.financial_ledger_entries entry
    join public.sales sale on sale.id = entry.sale_id
    join public.payment_attempts attempt on attempt.id = entry.payment_attempt_id
    where entry.created_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
      and entry.created_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  ),
  imported as (
    select line.id, line.occurred_on, line.movement, line.movement_label, line.amount_cents, import.number, line.line_number,
      current.resolution, current.category, current.counter_account
    from public.picpay_statement_lines line
    join public.picpay_statement_imports import on import.id = line.import_id
    join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where current.resolution in ('TRANSFERENCIA', 'CLASSIFICADA') and line.occurred_on between p_from and p_to
  )
  -- Revenue lands where the money is: PicPay receivables or the physical cash drawer.
  select day, 'SALE', id, revenue_category,
    case when entry_type = 'CASH_RECEIPT' then 'DINHEIRO_FISICO' else 'RECEBIVEIS_PICPAY' end::public.finance_account,
    amount_cents, case when entry_type = 'CASH_RECEIPT' then 'Venda recebida em dinheiro' else 'Venda a receber no PicPay' end,
    sale_id::text
  from sale_ledger where entry_type in ('RECEIVABLE_PICPAY', 'CASH_RECEIPT')
  union all
  select day, 'SALE', id, 'TAXAS', 'RECEBIVEIS_PICPAY', amount_cents, 'Taxa do meio de pagamento', sale_id::text
  from sale_ledger where entry_type = 'FEE'
  union all
  select day, 'SALE', id, 'AJUSTE', 'RECEBIVEIS_PICPAY', amount_cents, 'Divergência de conciliação', sale_id::text
  from sale_ledger where entry_type = 'DIVERGENCE'
  union all
  -- A settlement is a treasury transfer: it leaves the receivables and reaches the PicPay account.
  select day, 'SALE', id, null, 'RECEBIVEIS_PICPAY', -amount_cents, 'Liquidação de recebível', sale_id::text
  from sale_ledger where entry_type = 'SETTLEMENT'
  union all
  select day, 'SALE', id, null, 'PICPAY_EMPRESAS', amount_cents, 'Liquidação de recebível', sale_id::text
  from sale_ledger where entry_type = 'SETTLEMENT'
  union all
  select day, 'SALE', id, 'REEMBOLSO',
    case
      when metadata ->> 'refund_method' = 'CASH_DRAWER' then 'DINHEIRO_FISICO'
      when settled or integration_channel = 'DINHEIRO' then 'PICPAY_EMPRESAS'
      else 'RECEBIVEIS_PICPAY'
    end::public.finance_account,
    amount_cents, 'Estorno de venda', sale_id::text
  from sale_ledger where entry_type = 'REFUND'
  union all
  select settlement.effective_on, 'PAYABLE', settlement.id, 'FORNECEDOR',
    case when settlement.payment_method ilike '%dinheiro%' then 'DINHEIRO_FISICO' else 'PICPAY_EMPRESAS' end::public.finance_account,
    case when settlement.entry_type = 'SETTLEMENT' then -settlement.amount_cents else settlement.amount_cents end,
    case when settlement.entry_type = 'SETTLEMENT' then 'Pagamento a fornecedor' else 'Reversão de pagamento a fornecedor' end,
    settlement.reference
  from public.purchase_payable_settlements settlement
  where settlement.effective_on between p_from and p_to
  union all
  select entry.occurred_on, 'MANUAL', entry.id, entry.category, effect.account,
    case when entry.kind = 'REVERSAL' then -effect.amount_cents else effect.amount_cents end,
    entry.description, entry.reference
  from public.finance_manual_entries entry
  left join public.finance_manual_entries original on original.id = entry.reversal_of
  cross join lateral private.finance_manual_entry_effects(case when entry.kind = 'REVERSAL' then original else entry end) effect
  where entry.occurred_on between p_from and p_to
  union all
  -- Imported lines name the movement, never the counterparty.
  select occurred_on, 'IMPORT', id, category, 'PICPAY_EMPRESAS', amount_cents,
    case movement
      when 'COFRINHO_GUARDADO' then 'Dinheiro guardado no Cofrinho'
      when 'COFRINHO_RESGATADO' then 'Dinheiro resgatado do Cofrinho'
      when 'RECEBIVEIS_VENDA' then 'Recebíveis de venda liquidados'
      else 'Extrato PicPay: ' || movement_label
    end,
    'PICPAY-CSV-' || number || '-L' || line_number
  from imported
  union all
  select occurred_on, 'IMPORT', id, null, counter_account, -amount_cents,
    case movement
      when 'COFRINHO_GUARDADO' then 'Dinheiro guardado no Cofrinho'
      when 'COFRINHO_RESGATADO' then 'Dinheiro resgatado do Cofrinho'
      else 'Recebíveis de venda liquidados'
    end,
    'PICPAY-CSV-' || number || '-L' || line_number
  from imported where resolution = 'TRANSFERENCIA';
$$;

revoke all on function private.mask_statement_text(text, integer) from public, anon, authenticated, service_role;
revoke all on function private.parse_picpay_statement(text) from public, anon, authenticated, service_role;
revoke all on function private.plan_picpay_statement(text) from public, anon, authenticated, service_role;
revoke all on function private.picpay_statement_import_json(uuid) from public, anon, authenticated, service_role;
revoke all on function private.picpay_statement_flows(date, date) from public, anon, authenticated, service_role;
revoke all on function public.preview_picpay_statement(text) from public, anon, authenticated, service_role;
revoke all on function public.import_picpay_statement(text, text, boolean, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_picpay_statement_imports(bigint, integer) from public, anon, authenticated, service_role;
revoke all on function public.list_picpay_statement_lines(uuid, boolean, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.resolve_picpay_statement_line(uuid, text, public.finance_category, uuid, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.preview_picpay_statement(text) to authenticated;
grant execute on function public.import_picpay_statement(text, text, boolean, text, uuid) to authenticated;
grant execute on function public.list_picpay_statement_imports(bigint, integer) to authenticated;
grant execute on function public.list_picpay_statement_lines(uuid, boolean, integer, integer) to authenticated;
grant execute on function public.resolve_picpay_statement_line(uuid, text, public.finance_category, uuid, uuid, text, text, uuid) to authenticated;

comment on function public.import_picpay_statement(text, text, boolean, text, uuid) is
  'Imports a valid PicPay Empresas CSV once (SHA-256), keeping each line by file and line number.';
comment on function public.resolve_picpay_statement_line(uuid, text, public.finance_category, uuid, uuid, text, text, uuid) is
  'Reviews one imported PicPay line: reconcile with a sale or refund, classify, mark as already recorded or reopen.';
