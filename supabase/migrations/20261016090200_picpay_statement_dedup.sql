-- Spec 5.8 (FIN-007): the Extrato across overlapping files, and the single entry point for the three PicPay exports.
--
-- A statement line has no bank id, and two legitimate movements can be identical (same day, movement, description and
-- amount). Deduplication is by multiset: each line has a canonical fingerprint (day, normalized movement, normalized
-- description, signed amount in cents); a file with k lines of a fingerprint already known m times adds only k − m new
-- occurrences and records the other k as observations of the existing ones. Three identical lines stay three; the same
-- three in an overlapping file stay three; a later export with four adds exactly one. A file with fewer occurrences
-- than known for a day strictly inside its period is a duplicate conflict to review, never a silent deletion.
--
-- Every file line becomes an observation of a canonical line, so provenance answers "which exports saw this movement".
-- picpay_statement_lines remains the canonical occurrence (the line's own import is its first observation).

alter table public.picpay_statement_lines
  add column fingerprint text generated always as (
    md5((occurred_on - date '2000-01-01')::text || '|' || lower(movement_label) || '|' || coalesce(lower(description), '') || '|'
      || amount_cents::text)
  ) stored;
create index picpay_statement_lines_fingerprint_idx on public.picpay_statement_lines (fingerprint);

create table public.picpay_statement_line_observations (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.picpay_statement_lines(id) on delete restrict,
  import_id uuid not null references public.picpay_statement_imports(id) on delete restrict,
  file_line_number integer not null check (file_line_number >= 2),
  constraint picpay_statement_line_observations_identity unique (import_id, file_line_number),
  constraint picpay_statement_line_observations_once unique (import_id, line_id)
);
create index picpay_statement_line_observations_line_idx on public.picpay_statement_line_observations (line_id);

create table public.picpay_statement_duplicate_conflicts (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.picpay_statement_imports(id) on delete restrict,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{32}$'),
  occurred_on date not null,
  movement public.picpay_statement_movement not null,
  amount_cents bigint not null,
  known_count integer not null check (known_count > 0),
  observed_count integer not null check (observed_count >= 0),
  created_at timestamptz not null default now(),
  constraint picpay_statement_duplicate_conflicts_identity unique (import_id, fingerprint),
  constraint picpay_statement_duplicate_conflicts_fewer check (observed_count < known_count)
);
create index picpay_statement_duplicate_conflicts_day_idx on public.picpay_statement_duplicate_conflicts (occurred_on);

create trigger picpay_statement_line_observations_immutable before update or delete on public.picpay_statement_line_observations
for each row execute function private.prevent_immutable_record_change();
create trigger picpay_statement_duplicate_conflicts_immutable before update or delete on public.picpay_statement_duplicate_conflicts
for each row execute function private.prevent_immutable_record_change();
alter table public.picpay_statement_line_observations enable row level security;
alter table public.picpay_statement_duplicate_conflicts enable row level security;
revoke all on public.picpay_statement_line_observations, public.picpay_statement_duplicate_conflicts
  from public, anon, authenticated, service_role;

-- Which imports saw each statement line: its own import plus every later observation (no raw file is kept).
create view private.picpay_statement_line_provenance as
  select line.id as line_id, line.import_id, line.line_number as file_line_number from public.picpay_statement_lines line
  union
  select observation.line_id, observation.import_id, observation.file_line_number from public.picpay_statement_line_observations observation;
revoke all on private.picpay_statement_line_provenance from public, anon, authenticated, service_role;

create function private.picpay_statement_fingerprint(p_occurred_on date, p_movement_label text, p_description text, p_amount_cents bigint)
returns text language sql immutable set search_path = '' as $$
  select md5((p_occurred_on - date '2000-01-01')::text || '|' || lower(p_movement_label) || '|' || coalesce(lower(p_description), '') || '|'
    || p_amount_cents::text);
$$;

-- What a statement file would add: each line is matched by fingerprint and order to a known occurrence or is new.
create function private.picpay_statement_file_plan(p_content text)
returns table (
  line_number integer, occurred_on date, movement public.picpay_statement_movement, movement_label text, amount_cents bigint,
  description text, error_code text, resolution public.picpay_statement_resolution, counter_account public.finance_account,
  payment_attempt_id uuid, refund_entry_id uuid, fingerprint text, occurrence integer, known_line_id uuid
)
language sql stable security definer set search_path = '' as $$
  with plan as (
    select plan.*, private.picpay_statement_fingerprint(plan.occurred_on, plan.movement_label, plan.description, plan.amount_cents) as fingerprint
    from private.plan_picpay_statement(p_content) plan
  ),
  ranked as (
    select plan.*, row_number() over (partition by plan.fingerprint order by plan.line_number)::integer as occurrence
    from plan where plan.error_code is null
  ),
  known as (
    select line.id, line.fingerprint,
      row_number() over (partition by line.fingerprint order by import.number, line.line_number)::integer as occurrence
    from public.picpay_statement_lines line
    join public.picpay_statement_imports import on import.id = line.import_id
    where line.fingerprint in (select fingerprint from ranked)
  )
  select ranked.line_number, ranked.occurred_on, ranked.movement, ranked.movement_label, ranked.amount_cents, ranked.description,
    ranked.error_code, ranked.resolution, ranked.counter_account, ranked.payment_attempt_id, ranked.refund_entry_id, ranked.fingerprint,
    ranked.occurrence, known.id
  from ranked
  left join known on known.fingerprint = ranked.fingerprint and known.occurrence = ranked.occurrence
  union all
  select plan.line_number, plan.occurred_on, plan.movement, plan.movement_label, plan.amount_cents, plan.description, plan.error_code,
    null, null, null, null, null, null, null
  from plan where plan.error_code is not null
  order by 1;
$$;

-- Records a statement file with multiset deduplication; returns the import id.
create function private.import_picpay_statement_file(
  p_file_name text, p_content text, p_sha256 text, p_actor_id uuid, p_correlation_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_import_id uuid := gen_random_uuid();
  v_number bigint;
  v_from date;
  v_to date;
  v_lines integer;
  v_inflow bigint;
  v_outflow bigint;
  v_overlap boolean;
  v_line record;
  v_attempt public.payment_attempts%rowtype;
  v_reconciliation jsonb;
begin
  create temporary table picpay_statement_import_plan on commit drop as select * from private.picpay_statement_file_plan(p_content);
  if exists (select 1 from picpay_statement_import_plan where error_code is not null) then
    raise exception using errcode = '22023', message = 'PICPAY_FILE_INVALID';
  end if;
  select count(*), min(occurred_on), max(occurred_on), coalesce(sum(amount_cents) filter (where amount_cents > 0), 0),
    coalesce(-sum(amount_cents) filter (where amount_cents < 0), 0)
  into v_lines, v_from, v_to, v_inflow, v_outflow from picpay_statement_import_plan;
  v_overlap := exists (select 1 from public.picpay_statement_imports where period_from <= v_to and period_to >= v_from);

  insert into public.picpay_statement_imports (
    id, file_name, file_sha256, file_size_bytes, line_count, period_from, period_to, inflow_cents, outflow_cents, overlap_accepted,
    actor_id, correlation_id
  ) values (
    v_import_id, p_file_name, p_sha256, octet_length(convert_to(p_content, 'UTF8')), v_lines, v_from, v_to, v_inflow, v_outflow, v_overlap,
    p_actor_id, p_correlation_id
  ) returning number into v_number;

  -- New occurrences only; known ones are observed below.
  insert into public.picpay_statement_lines (import_id, line_number, occurred_on, movement, movement_label, amount_cents, description)
  select v_import_id, plan.line_number, plan.occurred_on, plan.movement, plan.movement_label, plan.amount_cents, plan.description
  from picpay_statement_import_plan plan where plan.known_line_id is null;
  insert into public.picpay_statement_line_observations (line_id, import_id, file_line_number)
  select coalesce(plan.known_line_id, line.id), v_import_id, plan.line_number
  from picpay_statement_import_plan plan
  left join public.picpay_statement_lines line on line.import_id = v_import_id and line.line_number = plan.line_number;

  -- Fewer occurrences than known on a day strictly inside the file: a conflict to review, nothing is removed.
  insert into public.picpay_statement_duplicate_conflicts (import_id, fingerprint, occurred_on, movement, amount_cents, known_count, observed_count)
  select v_import_id, known.fingerprint, known.occurred_on, known.movement, known.amount_cents, known.known_count, coalesce(seen.observed, 0)
  from (
    select line.fingerprint, min(line.occurred_on) as occurred_on, min(line.movement::text)::public.picpay_statement_movement as movement,
      min(line.amount_cents) as amount_cents, count(*)::integer as known_count
    from public.picpay_statement_lines line
    where line.occurred_on > v_from and line.occurred_on < v_to and line.import_id <> v_import_id
    group by line.fingerprint
  ) known
  left join (select fingerprint, count(*)::integer as observed from picpay_statement_import_plan group by fingerprint) seen
    on seen.fingerprint = known.fingerprint
  where coalesce(seen.observed, 0) < known.known_count;

  -- Automatic decisions of the new occurrences, as in the original import (transfers, unique sale or refund matches).
  insert into public.picpay_statement_line_resolutions (line_id, resolution, counter_account, automatic, actor_id, correlation_id)
  select line.id, 'TRANSFERENCIA', plan.counter_account, true, p_actor_id, p_correlation_id
  from picpay_statement_import_plan plan
  join public.picpay_statement_lines line on line.import_id = v_import_id and line.line_number = plan.line_number
  where plan.known_line_id is null and plan.resolution = 'TRANSFERENCIA';
  for v_line in
    select line.id, line.line_number, line.amount_cents, plan.resolution, plan.payment_attempt_id, plan.refund_entry_id
    from picpay_statement_import_plan plan
    join public.picpay_statement_lines line on line.import_id = v_import_id and line.line_number = plan.line_number
    where plan.known_line_id is null and plan.resolution in ('CONCILIADA_VENDA', 'CONCILIADA_ESTORNO')
    order by line.line_number
  loop
    if v_line.resolution = 'CONCILIADA_VENDA' then
      select * into v_attempt from public.payment_attempts where id = v_line.payment_attempt_id for update;
      if v_attempt.status = 'APPROVED' and not exists (select 1 from public.payment_reconciliations where payment_attempt_id = v_attempt.id) then
        v_reconciliation := public.reconcile_payment_attempt(v_attempt.id, v_line.amount_cents, 0,
          'PICPAY-CSV-' || v_number || '-L' || v_line.line_number, 'IMPORT', 'picpay-statement:' || v_line.id, p_correlation_id);
        insert into public.picpay_statement_line_resolutions (
          line_id, resolution, payment_attempt_id, reconciliation_id, automatic, actor_id, correlation_id
        ) values (
          v_line.id, 'CONCILIADA_VENDA', v_attempt.id, (v_reconciliation ->> 'reconciliation_id')::uuid, true, p_actor_id, p_correlation_id
        );
      end if;
    else
      perform pg_advisory_xact_lock(hashtextextended('picpay-statement-refund:' || v_line.refund_entry_id, 0));
      if not exists (select 1 from private.picpay_statement_current_resolutions
        where refund_entry_id = v_line.refund_entry_id and resolution = 'CONCILIADA_ESTORNO') then
        insert into public.picpay_statement_line_resolutions (line_id, resolution, refund_entry_id, automatic, actor_id, correlation_id)
        values (v_line.id, 'CONCILIADA_ESTORNO', v_line.refund_entry_id, true, p_actor_id, p_correlation_id);
      end if;
    end if;
  end loop;
  drop table picpay_statement_import_plan;
  return v_import_id;
end;
$$;

-- One row per imported PicPay file of any type, with what it added.
create function private.picpay_import_json(p_source_type public.picpay_source_type, p_import_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when p_source_type = 'PICPAY_STATEMENT' then (
    select jsonb_build_object(
      'id', import.id, 'source_type', 'PICPAY_STATEMENT', 'number', import.number, 'file_name', import.file_name, 'file_sha256', import.file_sha256,
      'row_count', import.line_count, 'period_from', import.period_from, 'period_to', import.period_to,
      'new_count', (select count(*) from public.picpay_statement_lines line where line.import_id = import.id),
      'known_count', import.line_count - (select count(*) from public.picpay_statement_lines line where line.import_id = import.id),
      'updated_count', 0,
      'ambiguous_count', (select count(*) from public.picpay_statement_duplicate_conflicts conflict where conflict.import_id = import.id),
      'actor_name', coalesce(nullif(btrim(actor.display_name), ''), actor.email), 'created_at', import.created_at)
    from public.picpay_statement_imports import join public.profiles actor on actor.id = import.actor_id where import.id = p_import_id)
  else (
    select jsonb_build_object(
      'id', import.id, 'source_type', import.source_type, 'number', import.number, 'file_name', import.file_name, 'file_sha256', import.file_sha256,
      'row_count', import.row_count, 'period_from', import.period_from, 'period_to', import.period_to, 'new_count', import.new_count,
      'known_count', import.known_count, 'updated_count', import.updated_count, 'ambiguous_count', 0,
      'actor_name', coalesce(nullif(btrim(actor.display_name), ''), actor.email), 'created_at', import.created_at)
    from public.picpay_source_imports import join public.profiles actor on actor.id = import.actor_id where import.id = p_import_id)
  end;
$$;

-- Read-only preview of any PicPay export: detected type, period, rows, what is new, known, changed or ambiguous, errors.
create function public.preview_picpay_file(p_content text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_type public.picpay_source_type;
  v_sha256 text;
  v_result jsonb;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_content is null or char_length(p_content) > 4000000 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILE';
  end if;
  v_type := private.detect_picpay_source(p_content);
  v_sha256 := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  if v_type is null then
    return jsonb_build_object('source_type', null, 'sha256', v_sha256, 'size_bytes', octet_length(convert_to(p_content, 'UTF8')),
      'row_count', 0, 'error_count', 1, 'errors', jsonb_build_array(jsonb_build_object('line', 1, 'code', 'UNKNOWN_FILE')),
      'period_from', null, 'period_to', null, 'new_count', 0, 'known_count', 0, 'updated_count', 0, 'ambiguous_count', 0,
      'already_imported', null, 'totals', '{}'::jsonb);
  end if;
  if v_type = 'PICPAY_SALES' then
    with parsed as (select * from private.picpay_sales_rows(p_content)),
    valid as (select parsed.*, state.transaction_id, state.status as known_status, state.gross_cents as known_gross, state.net_cents as known_net,
        state.total_fee_cents as known_fee, state.cancelled_cents as known_cancelled
      from parsed left join private.picpay_transaction_state state on state.transaction_ref = parsed.transaction_ref where parsed.error_code is null)
    select jsonb_build_object(
      'row_count', (select count(*) from parsed where line_number >= 2),
      'error_count', (select count(*) from parsed where error_code is not null),
      'errors', coalesce((select jsonb_agg(jsonb_build_object('line', line_number, 'code', error_code) order by line_number)
        from (select line_number, error_code from parsed where error_code is not null order by line_number limit 100) failed), '[]'::jsonb),
      'period_from', (select min((sold_at at time zone 'America/Sao_Paulo')::date) from valid),
      'period_to', (select max((sold_at at time zone 'America/Sao_Paulo')::date) from valid),
      'new_count', (select count(*) from valid where transaction_id is null),
      'known_count', (select count(*) from valid where transaction_id is not null and known_status = status and known_gross = gross_cents
        and known_net = net_cents and known_fee = fee_cents + fixed_cost_cents + installment_fee_cents and known_cancelled = cancelled_cents),
      'updated_count', (select count(*) from valid where transaction_id is not null and not (known_status = status and known_gross = gross_cents
        and known_net = net_cents and known_fee = fee_cents + fixed_cost_cents + installment_fee_cents and known_cancelled = cancelled_cents)),
      'ambiguous_count', 0,
      'totals', jsonb_build_object(
        'approved', (select count(*) from valid where status = 'APROVADA'), 'denied', (select count(*) from valid where status = 'NEGADA'),
        'refunded', (select count(*) from valid where status = 'DEVOLVIDA'), 'pix', (select count(*) from valid where payment_kind = 'PIX'),
        'gross_cents', coalesce((select sum(gross_cents) from valid where status in ('APROVADA', 'DEVOLVIDA')), 0),
        'fee_cents', coalesce((select sum(fee_cents + fixed_cost_cents + installment_fee_cents) from valid where status in ('APROVADA', 'DEVOLVIDA')), 0),
        'net_cents', coalesce((select sum(net_cents) from valid where status in ('APROVADA', 'DEVOLVIDA')), 0)))
    into v_result;
  elsif v_type = 'PICPAY_RECEIVABLES' then
    with parsed as (select * from private.picpay_receivables_rows(p_content)),
    valid as (select parsed.*, state.installment_id, state.net_cents as known_net, state.payment_on as known_payment, state.status_label as known_status
      from parsed left join private.picpay_receivable_state state
        on state.transaction_ref = parsed.transaction_ref and state.installment_number = parsed.installment_number
      where parsed.error_code is null)
    select jsonb_build_object(
      'row_count', (select count(*) from parsed where line_number >= 2),
      'error_count', (select count(*) from parsed where error_code is not null),
      'errors', coalesce((select jsonb_agg(jsonb_build_object('line', line_number, 'code', error_code) order by line_number)
        from (select line_number, error_code from parsed where error_code is not null order by line_number limit 100) failed), '[]'::jsonb),
      'period_from', (select min(payment_on) from valid), 'period_to', (select max(payment_on) from valid),
      'new_count', (select count(*) from valid where installment_id is null),
      'known_count', (select count(*) from valid where installment_id is not null and known_net = net_cents and known_payment = payment_on
        and known_status = status_label),
      'updated_count', (select count(*) from valid where installment_id is not null and not (known_net = net_cents and known_payment = payment_on
        and known_status = status_label)),
      'ambiguous_count', 0,
      'totals', jsonb_build_object('gross_cents', coalesce((select sum(gross_cents) from valid), 0),
        'discount_cents', coalesce((select sum(discount_cents) from valid), 0), 'net_cents', coalesce((select sum(net_cents) from valid), 0)))
    into v_result;
  else
    with plan as (select * from private.picpay_statement_file_plan(p_content)),
    valid as (select * from plan where error_code is null),
    bounds as (select min(occurred_on) as period_from, max(occurred_on) as period_to from valid)
    select jsonb_build_object(
      'row_count', (select count(*) from plan where line_number >= 2),
      'error_count', (select count(*) from plan where error_code is not null),
      'errors', coalesce((select jsonb_agg(jsonb_build_object('line', line_number, 'code', error_code) order by line_number)
        from (select line_number, error_code from plan where error_code is not null order by line_number limit 100) failed), '[]'::jsonb),
      'period_from', (select period_from from bounds), 'period_to', (select period_to from bounds),
      'new_count', (select count(*) from valid where known_line_id is null),
      'known_count', (select count(*) from valid where known_line_id is not null),
      'updated_count', 0,
      'ambiguous_count', (select count(*) from (
        select line.fingerprint from public.picpay_statement_lines line, bounds
        where line.occurred_on > bounds.period_from and line.occurred_on < bounds.period_to
        group by line.fingerprint
        having count(*) > (select count(*) from valid where valid.fingerprint = line.fingerprint)) conflicts),
      'totals', jsonb_build_object(
        'inflow_cents', coalesce((select sum(amount_cents) from valid where amount_cents > 0), 0),
        'outflow_cents', coalesce((select -sum(amount_cents) from valid where amount_cents < 0), 0),
        'by_movement', coalesce((select jsonb_agg(jsonb_build_object('movement', movement, 'count', lines, 'amount_cents', total) order by movement)
          from (select movement, count(*) as lines, sum(amount_cents) as total from valid group by movement) grouped), '[]'::jsonb)))
    into v_result;
  end if;
  return v_result || jsonb_build_object('source_type', v_type, 'sha256', v_sha256, 'size_bytes', octet_length(convert_to(p_content, 'UTF8')),
    'already_imported', coalesce(
      (select jsonb_build_object('number', number, 'created_at', created_at) from public.picpay_source_imports where file_sha256 = v_sha256),
      (select jsonb_build_object('number', number, 'created_at', created_at) from public.picpay_statement_imports where file_sha256 = v_sha256)));
end;
$$;

revoke all on function private.picpay_statement_fingerprint(date, text, text, bigint) from public, anon, authenticated, service_role;
revoke all on function private.picpay_statement_file_plan(text) from public, anon, authenticated, service_role;
revoke all on function private.import_picpay_statement_file(text, text, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.picpay_import_json(public.picpay_source_type, uuid) from public, anon, authenticated, service_role;
revoke all on function public.preview_picpay_file(text) from public, anon, authenticated, service_role;
grant execute on function public.preview_picpay_file(text) to authenticated;

comment on function public.preview_picpay_file(text) is
  'Read-only preview of a PicPay export (Minhas vendas, Recebíveis or Extrato, detected from the header).';
