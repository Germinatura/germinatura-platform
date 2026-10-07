-- Spec 5.8 (FIN-003, FIN-007): review of imported PicPay statements across the cutover.
--
-- Cutover history: a line dated before the current opening position's operating_since never acts as native
-- operation. It is not matched to sales or refunds and Recebíveis de venda is not transferred out of
-- RECEBIVEIS_PICPAY (no internal receivable exists for it, so the transfer would create an impossible negative
-- balance). Such lines wait for review, where inflows may be classified as RECEITA_HISTORICA. From
-- operating_since on, everything follows the normal rules: Recebíveis de venda is an automatic transfer and never
-- historical revenue. Dinheiro guardado/resgatado stays an automatic transfer on both sides of the cutover.
--
-- The `cutover` flag of each decision is set by the database (trigger) from the line date and the current
-- opening position, and the shape constraint makes the rules structural:
--   RECEITA_HISTORICA only on cutover lines; receivable transfers and sale/refund reconciliations never on them.
--
-- Link (VINCULADA): the line's effect is already in an existing supplier payment or manual entry of the PicPay
-- Empresas account with exactly the same signed amount; the line adds nothing. A record is linked to one line.
--
-- Bulk classification: the server recomputes the selection under lock and applies it only when it is exactly the
-- one previewed (count, total and SHA-256 of the line ids); every line keeps its own decision.

-- Historical revenue comes only from reviewed statement lines, never from a manual entry.
alter table public.finance_manual_entries add constraint finance_manual_entries_no_historical_revenue
  check (category is null or category <> 'RECEITA_HISTORICA');

alter table public.picpay_statement_line_resolutions
  add column payable_settlement_id uuid references public.purchase_payable_settlements(id) on delete restrict,
  add column manual_entry_id uuid references public.finance_manual_entries(id) on delete restrict,
  add column bulk_id uuid,
  add column cutover boolean not null default false;

-- The current-decision view lists its columns at creation; it is recreated to carry the new ones.
create or replace view private.picpay_statement_current_resolutions as
  select distinct on (line_id) * from public.picpay_statement_line_resolutions order by line_id, sequence desc;
revoke all on private.picpay_statement_current_resolutions from public, anon, authenticated, service_role;

alter table public.picpay_statement_line_resolutions drop constraint picpay_statement_line_resolutions_shape_valid;
alter table public.picpay_statement_line_resolutions add constraint picpay_statement_line_resolutions_shape_valid check (
  (resolution = 'TRANSFERENCIA' and counter_account is not null and counter_account <> 'PICPAY_EMPRESAS'
    and category is null and payment_attempt_id is null and refund_entry_id is null
    and payable_settlement_id is null and manual_entry_id is null
    and not (cutover and counter_account = 'RECEBIVEIS_PICPAY'))
  or (resolution = 'CONCILIADA_VENDA' and payment_attempt_id is not null and reconciliation_id is not null
    and category is null and counter_account is null and refund_entry_id is null
    and payable_settlement_id is null and manual_entry_id is null and not cutover)
  or (resolution = 'CONCILIADA_ESTORNO' and refund_entry_id is not null
    and category is null and counter_account is null and payment_attempt_id is null
    and payable_settlement_id is null and manual_entry_id is null and not cutover)
  or (resolution = 'CLASSIFICADA' and category is not null and category not in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA')
    and counter_account is null and payment_attempt_id is null and refund_entry_id is null
    and payable_settlement_id is null and manual_entry_id is null
    and (category <> 'RECEITA_HISTORICA' or cutover))
  or (resolution = 'VINCULADA' and num_nonnulls(payable_settlement_id, manual_entry_id) = 1
    and category is null and counter_account is null and payment_attempt_id is null and refund_entry_id is null)
  or (resolution in ('JA_REGISTRADO', 'REABERTA') and reason is not null
    and category is null and counter_account is null and payment_attempt_id is null and refund_entry_id is null
    and payable_settlement_id is null and manual_entry_id is null)
);
create index picpay_statement_line_resolutions_settlement_idx on public.picpay_statement_line_resolutions (payable_settlement_id)
  where payable_settlement_id is not null;
create index picpay_statement_line_resolutions_manual_idx on public.picpay_statement_line_resolutions (manual_entry_id)
  where manual_entry_id is not null;
create index picpay_statement_line_resolutions_bulk_idx on public.picpay_statement_line_resolutions (bulk_id)
  where bulk_id is not null;

-- Whether a statement day is cutover history under the current opening position.
create function private.is_statement_cutover_day(p_day date)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p_day < position.operating_since from private.current_finance_opening_position() position), false);
$$;

create function private.set_statement_resolution_cutover()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.cutover := private.is_statement_cutover_day((select occurred_on from public.picpay_statement_lines where id = new.line_id));
  return new;
end;
$$;
create trigger picpay_statement_line_resolutions_cutover before insert on public.picpay_statement_line_resolutions
for each row execute function private.set_statement_resolution_cutover();

-- Why a line may not be classified under a category; null when it may. The single rule for one line and bulk.
create function private.statement_classification_refusal(
  p_movement public.picpay_statement_movement, p_amount_cents bigint, p_occurred_on date, p_category public.finance_category
)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when p_category is null then 'INVALID_STATEMENT_RESOLUTION'
    when p_category in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA') then 'FINANCE_CATEGORY_AUTOMATIC_ONLY'
    when p_movement in ('COFRINHO_GUARDADO', 'COFRINHO_RESGATADO') then 'STATEMENT_LINE_ACTION_NOT_ALLOWED'
    when p_category = 'RECEITA_HISTORICA' and not private.is_statement_cutover_day(p_occurred_on) then 'STATEMENT_HISTORICAL_REVENUE_NOT_ALLOWED'
    -- Historical revenue is money that came in (or a reversal of it), never an outflow or the return of an expense.
    when p_category = 'RECEITA_HISTORICA' and not (
      (p_movement in ('PIX_RECEBIDO', 'RECEBIVEIS_VENDA', 'DESCONHECIDO') and p_amount_cents > 0)
      or (p_movement = 'PIX_ESTORNADO' and p_amount_cents < 0)) then 'STATEMENT_HISTORICAL_REVENUE_NOT_ALLOWED'
    -- Recebíveis de venda is a transfer of existing receivables; only cutover history may be revenue.
    when p_movement = 'RECEBIVEIS_VENDA' and p_category <> 'RECEITA_HISTORICA' then 'STATEMENT_LINE_ACTION_NOT_ALLOWED'
  end;
$$;

-- The automatic plan, now aware of the cutover: history is never matched to sales or refunds and its
-- receivables are never transferred out of RECEBIVEIS_PICPAY.
create or replace function private.plan_picpay_statement(p_content text)
returns setof private.picpay_statement_plan_row
language sql stable security definer set search_path = '' as $$
  with parsed as (
    select parsed.*, private.is_statement_cutover_day(parsed.occurred_on) as history
    from private.parse_picpay_statement(p_content) parsed
  ),
  sale_candidates as (
    select line.line_number, attempt.id as attempt_id
    from parsed line
    join public.payment_attempts attempt
      on attempt.integration_channel = 'PIX_AREA' and attempt.status = 'APPROVED' and attempt.amount_cents = line.amount_cents
    where line.error_code is null and line.movement = 'PIX_RECEBIDO' and not line.history
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
    where line.error_code is null and line.movement = 'PIX_ESTORNADO' and line.amount_cents < 0 and not line.history
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
      when parsed.movement in ('COFRINHO_GUARDADO', 'COFRINHO_RESGATADO') then 'TRANSFERENCIA'
      when parsed.movement = 'RECEBIVEIS_VENDA' and not parsed.history then 'TRANSFERENCIA'
      when sale.attempt_id is not null then 'CONCILIADA_VENDA'
      when refund.entry_id is not null then 'CONCILIADA_ESTORNO'
    end::public.picpay_statement_resolution,
    case
      when parsed.error_code is not null then null
      when parsed.movement in ('COFRINHO_GUARDADO', 'COFRINHO_RESGATADO') then 'COFRINHO_PICPAY'
      when parsed.movement = 'RECEBIVEIS_VENDA' and not parsed.history then 'RECEBIVEIS_PICPAY'
    end::public.finance_account,
    sale.attempt_id, refund.entry_id
  from parsed
  left join sale_match sale on sale.line_number = parsed.line_number
    and (select count(*) from sale_candidates other where other.attempt_id = sale.attempt_id) = 1
  left join refund_match refund on refund.line_number = parsed.line_number
    and (select count(*) from refund_candidates other where other.entry_id = refund.entry_id) = 1
  order by parsed.line_number;
$$;

create or replace function private.picpay_statement_import_json(p_import_id uuid)
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
        'VINCULADA', count(*) filter (where current.resolution = 'VINCULADA'),
        'JA_REGISTRADO', count(*) filter (where current.resolution = 'JA_REGISTRADO'),
        'PENDENTE_REVISAO', count(*) filter (where (current.resolution is null or current.resolution = 'REABERTA')
          and line.movement <> 'DESCONHECIDO'),
        'PENDENTE_CLASSIFICACAO', count(*) filter (where (current.resolution is null or current.resolution = 'REABERTA')
          and line.movement = 'DESCONHECIDO'))
      from public.picpay_statement_lines line
      left join private.picpay_statement_current_resolutions current on current.line_id = line.id
      where line.import_id = import.id),
    'cutover_lines', (select count(*) from public.picpay_statement_lines line
      where line.import_id = import.id and private.is_statement_cutover_day(line.occurred_on))
  )
  from public.picpay_statement_imports import
  join public.profiles actor on actor.id = import.actor_id
  where import.id = p_import_id;
$$;

-- Read-only preview, now also telling how many lines are cutover history and how many precede the opening.
create or replace function public.preview_picpay_statement(p_content text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_sha256 text;
  v_plan jsonb;
  v_position public.finance_opening_positions%rowtype;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_content is null or char_length(p_content) > 2000000 then
    raise exception using errcode = '22023', message = 'INVALID_STATEMENT_FILE';
  end if;
  v_sha256 := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  v_plan := coalesce((select jsonb_agg(to_jsonb(plan)) from private.plan_picpay_statement(p_content) plan), '[]'::jsonb);
  select * into v_position from private.current_finance_opening_position();
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
      'cutover', case when v_position.id is null then null else jsonb_build_object(
        'as_of', v_position.as_of, 'operating_since', v_position.operating_since,
        'history_lines', (select count(*) from valid where occurred_on < v_position.operating_since),
        'before_opening_lines', (select count(*) from valid where occurred_on < v_position.as_of)) end,
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

-- The effect of a linkable record on the PicPay Empresas account; null when it does not touch it or cannot be
-- linked (a reversed record, a reversal entry or a record dated before the opening position).
create function private.statement_link_record_effect(p_payable_settlement_id uuid, p_manual_entry_id uuid)
returns table (amount_cents bigint, occurred_on date, label text)
language sql stable security definer set search_path = '' as $$
  select case when settlement.entry_type = 'SETTLEMENT' then -settlement.amount_cents else settlement.amount_cents end,
    settlement.effective_on,
    case when settlement.entry_type = 'SETTLEMENT' then 'Pagamento a fornecedor' else 'Reversão de pagamento a fornecedor' end
  from public.purchase_payable_settlements settlement
  where settlement.id = p_payable_settlement_id and p_manual_entry_id is null
    and settlement.payment_method not ilike '%dinheiro%'
    and not exists (select 1 from public.purchase_payable_settlements reversal where reversal.reversal_of = settlement.id)
    and settlement.effective_on >= coalesce((select as_of from private.current_finance_opening_position()), date '2020-01-01')
  union all
  select sum(effect.amount_cents)::bigint, entry.occurred_on, entry.description
  from public.finance_manual_entries entry
  cross join lateral private.finance_manual_entry_effects(entry) effect
  where entry.id = p_manual_entry_id and p_payable_settlement_id is null
    and entry.kind in ('EXPENSE', 'INCOME', 'TRANSFER') and effect.account = 'PICPAY_EMPRESAS'
    and not exists (select 1 from public.finance_manual_entries reversal where reversal.reversal_of = entry.id)
    and entry.occurred_on >= coalesce((select as_of from private.current_finance_opening_position()), date '2020-01-01')
  group by entry.id, entry.occurred_on, entry.description;
$$;

create function private.statement_record_is_linked(p_payable_settlement_id uuid, p_manual_entry_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.picpay_statement_current_resolutions current
    where current.resolution = 'VINCULADA'
      and (current.payable_settlement_id = p_payable_settlement_id or current.manual_entry_id = p_manual_entry_id));
$$;

-- Records that may explain a pending line: same signed effect on PicPay Empresas, not linked to another line.
create function public.list_statement_link_candidates(p_line_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_line public.picpay_statement_lines%rowtype;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  select * into v_line from public.picpay_statement_lines where id = p_line_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_NOT_FOUND';
  end if;
  return coalesce((select jsonb_agg(candidate order by abs(candidate.occurred_on - v_line.occurred_on), candidate.occurred_on)
    from (
      select 'PAYABLE_SETTLEMENT' as kind, settlement.id, effect.amount_cents, effect.occurred_on, effect.label
      from public.purchase_payable_settlements settlement
      cross join lateral private.statement_link_record_effect(settlement.id, null) effect
      where effect.amount_cents = v_line.amount_cents and not private.statement_record_is_linked(settlement.id, null)
      union all
      select 'MANUAL_ENTRY', entry.id, effect.amount_cents, effect.occurred_on, effect.label
      from public.finance_manual_entries entry
      cross join lateral private.statement_link_record_effect(null, entry.id) effect
      where effect.amount_cents = v_line.amount_cents and not private.statement_record_is_linked(null, entry.id)
    ) candidate), '[]'::jsonb);
end;
$$;

-- Links a pending line to the existing record that already carries its effect.
create function public.link_picpay_statement_line(
  p_line_id uuid, p_payable_settlement_id uuid, p_manual_entry_id uuid, p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_line public.picpay_statement_lines%rowtype;
  v_current public.picpay_statement_line_resolutions%rowtype;
  v_number bigint;
  v_effect bigint;
  v_resolution_id uuid := gen_random_uuid();
  v_reason text := nullif(btrim(p_reason), '');
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_line_id is null or num_nonnulls(p_payable_settlement_id, p_manual_entry_id) <> 1
    or (v_reason is not null and char_length(v_reason) not between 3 and 300) then
    raise exception using errcode = '22023', message = 'INVALID_STATEMENT_RESOLUTION';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'link_statement_line', v_actor_id), p_idempotency_key,
    jsonb_build_object('line_id', p_line_id, 'payable_settlement_id', p_payable_settlement_id,
      'manual_entry_id', p_manual_entry_id, 'reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  -- One link per record: concurrent links of the same record wait for each other.
  perform pg_advisory_xact_lock(hashtextextended('picpay-statement-link:' || coalesce(p_payable_settlement_id, p_manual_entry_id), 0));
  select * into v_line from public.picpay_statement_lines where id = p_line_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_NOT_FOUND';
  end if;
  select * into v_current from private.picpay_statement_current_resolutions where line_id = v_line.id;
  if v_current.id is not null and v_current.resolution <> 'REABERTA' then
    raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_ALREADY_RESOLVED';
  end if;
  if v_line.movement in ('COFRINHO_GUARDADO', 'COFRINHO_RESGATADO', 'RECEBIVEIS_VENDA') then
    raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_ACTION_NOT_ALLOWED';
  end if;
  select amount_cents into v_effect from private.statement_link_record_effect(p_payable_settlement_id, p_manual_entry_id);
  if v_effect is null or private.statement_record_is_linked(p_payable_settlement_id, p_manual_entry_id) then
    raise exception using errcode = 'P0001', message = 'STATEMENT_LINK_RECORD_NOT_LINKABLE';
  end if;
  if v_effect <> v_line.amount_cents then
    raise exception using errcode = 'P0001', message = 'STATEMENT_AMOUNT_MISMATCH';
  end if;
  select number into v_number from public.picpay_statement_imports where id = v_line.import_id;

  insert into public.picpay_statement_line_resolutions (
    id, line_id, resolution, payable_settlement_id, manual_entry_id, reason, automatic, actor_id, correlation_id
  ) values (
    v_resolution_id, v_line.id, 'VINCULADA', p_payable_settlement_id, p_manual_entry_id, v_reason, false, v_actor_id, p_correlation_id
  );
  v_result := jsonb_build_object('line_id', v_line.id, 'resolution_id', v_resolution_id, 'resolution', 'VINCULADA',
    'payable_settlement_id', p_payable_settlement_id, 'manual_entry_id', p_manual_entry_id, 'correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.statement.line_linked', v_actor_id, 'picpay_statement_line', v_line.id::text, p_correlation_id,
    jsonb_build_object('import_number', v_number, 'line_number', v_line.line_number, 'movement', v_line.movement,
      'amount_cents', v_line.amount_cents, 'previous_resolution', v_current.resolution,
      'payable_settlement_id', p_payable_settlement_id, 'manual_entry_id', p_manual_entry_id));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.statement.line_resolved', 'picpay_statement_line', v_line.id::text,
    jsonb_build_object('line_id', v_line.id, 'resolution', 'VINCULADA', 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_statement_line', v_line.id::text);
  return v_result;
end;
$$;

-- Review of one line, now aware of the cutover: history is never reconciled with sales or refunds, classification
-- follows private.statement_classification_refusal, and linked lines may be reopened.
create or replace function public.resolve_picpay_statement_line(
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
  v_refusal text;
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
    if v_pending or v_current.resolution not in ('CLASSIFICADA', 'JA_REGISTRADO', 'CONCILIADA_ESTORNO', 'VINCULADA') then
      raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_NOT_REOPENABLE';
    end if;
    v_resolution := 'REABERTA';
    insert into public.picpay_statement_line_resolutions (id, line_id, resolution, reason, automatic, actor_id, correlation_id)
    values (v_resolution_id, v_line.id, v_resolution, v_reason, false, v_actor_id, p_correlation_id);
  else
    if not v_pending then
      raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_ALREADY_RESOLVED';
    end if;
    if p_action in ('CONCILIAR_VENDA', 'CONCILIAR_ESTORNO') and private.is_statement_cutover_day(v_line.occurred_on) then
      raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_IS_CUTOVER_HISTORY';
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
      v_refusal := private.statement_classification_refusal(v_line.movement, v_line.amount_cents, v_line.occurred_on, p_category);
      if v_refusal is not null then
        raise exception using errcode = 'P0001', message = v_refusal;
      end if;
      v_resolution := 'CLASSIFICADA';
      insert into public.picpay_statement_line_resolutions (id, line_id, resolution, category, reason, automatic, actor_id, correlation_id)
      values (v_resolution_id, v_line.id, v_resolution, p_category, v_reason, false, v_actor_id, p_correlation_id);
    else
      if v_line.movement in ('COFRINHO_GUARDADO', 'COFRINHO_RESGATADO') then
        raise exception using errcode = 'P0001', message = 'STATEMENT_LINE_ACTION_NOT_ALLOWED';
      end if;
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
      'refund_entry_id', case when v_resolution = 'CONCILIADA_ESTORNO' then p_refund_entry_id end,
      'cutover', private.is_statement_cutover_day(v_line.occurred_on)));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.statement.line_resolved', 'picpay_statement_line', v_line.id::text,
    jsonb_build_object('line_id', v_line.id, 'resolution', v_resolution, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_statement_line', v_line.id::text);
  return v_result;
end;
$$;

-- Pending lines of one import selected by movement, São Paulo period and/or explicit ids, in line order.
create function private.picpay_statement_bulk_selection(
  p_import_id uuid, p_movement public.picpay_statement_movement, p_from date, p_to date, p_line_ids uuid[]
)
returns setof public.picpay_statement_lines
language sql stable security definer set search_path = '' as $$
  select line.* from public.picpay_statement_lines line
  left join private.picpay_statement_current_resolutions current on current.line_id = line.id
  where line.import_id = p_import_id
    and (current.resolution is null or current.resolution = 'REABERTA')
    and (p_movement is null or line.movement = p_movement)
    and (p_from is null or line.occurred_on >= p_from)
    and (p_to is null or line.occurred_on <= p_to)
    and (p_line_ids is null or line.id = any (p_line_ids))
  order by line.line_number;
$$;

create function private.picpay_statement_bulk_summary(
  p_import_id uuid, p_movement public.picpay_statement_movement, p_from date, p_to date, p_line_ids uuid[],
  p_category public.finance_category
)
returns jsonb language sql stable security definer set search_path = '' as $$
  with selected as (
    select line.*, private.statement_classification_refusal(line.movement, line.amount_cents, line.occurred_on, p_category) as refusal
    from private.picpay_statement_bulk_selection(p_import_id, p_movement, p_from, p_to, p_line_ids) line
  )
  select jsonb_build_object(
    'count', count(*),
    'total_cents', coalesce(sum(amount_cents), 0),
    'inflow_cents', coalesce(sum(amount_cents) filter (where amount_cents > 0), 0),
    'outflow_cents', coalesce(-sum(amount_cents) filter (where amount_cents < 0), 0),
    'period_from', min(occurred_on), 'period_to', max(occurred_on),
    'selection_sha256', encode(sha256(convert_to(coalesce(string_agg(id::text, ',' order by line_number), ''), 'UTF8')), 'hex'),
    'by_movement', coalesce((select jsonb_agg(jsonb_build_object('movement', movement, 'count', lines, 'amount_cents', total) order by movement)
      from (select movement, count(*) as lines, sum(amount_cents) as total from selected group by movement) grouped), '[]'::jsonb),
    'refusals', coalesce((select jsonb_agg(jsonb_build_object('code', refusal, 'count', lines) order by refusal)
      from (select refusal, count(*) as lines from selected where refusal is not null group by refusal) grouped), '[]'::jsonb))
  from selected;
$$;

-- What a bulk classification would do. Nothing is written.
create function public.preview_picpay_statement_bulk(
  p_import_id uuid, p_movement public.picpay_statement_movement, p_from date, p_to date, p_line_ids uuid[],
  p_category public.finance_category
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_import_id is null or p_category is null or (p_movement is null and p_line_ids is null)
    or (p_from is not null and p_to is not null and p_to < p_from) then
    raise exception using errcode = '22023', message = 'INVALID_STATEMENT_BULK';
  end if;
  if not exists (select 1 from public.picpay_statement_imports where id = p_import_id) then
    raise exception using errcode = 'P0001', message = 'STATEMENT_IMPORT_NOT_FOUND';
  end if;
  return private.picpay_statement_bulk_summary(p_import_id, p_movement, p_from, p_to, p_line_ids, p_category)
    || jsonb_build_object('category', p_category, 'max_lines', 1000);
end;
$$;

-- Classifies the previewed selection: one transaction, one decision per line, one aggregated audit entry.
create function public.resolve_picpay_statement_lines_bulk(
  p_import_id uuid, p_movement public.picpay_statement_movement, p_from date, p_to date, p_line_ids uuid[],
  p_category public.finance_category, p_reason text, p_expected_count integer, p_expected_total_cents bigint,
  p_expected_selection_sha256 text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_bulk_id uuid := gen_random_uuid();
  v_number bigint;
  v_summary jsonb;
  v_reason text := btrim(p_reason);
  v_inserted integer;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_import_id is null or p_category is null or (p_movement is null and p_line_ids is null)
    or (p_from is not null and p_to is not null and p_to < p_from)
    or v_reason is null or char_length(v_reason) not between 8 and 300
    or p_expected_count is null or p_expected_count not between 1 and 1000 or p_expected_total_cents is null
    or p_expected_selection_sha256 is null or p_expected_selection_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_STATEMENT_BULK';
  end if;
  if p_category in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA') then
    raise exception using errcode = '22023', message = 'FINANCE_CATEGORY_AUTOMATIC_ONLY';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'resolve_statement_bulk', v_actor_id), p_idempotency_key,
    jsonb_build_object('import_id', p_import_id, 'movement', p_movement, 'from', p_from, 'to', p_to, 'line_ids', p_line_ids,
      'category', p_category, 'reason', v_reason, 'expected_count', p_expected_count,
      'expected_total_cents', p_expected_total_cents, 'expected_selection_sha256', p_expected_selection_sha256));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  select number into v_number from public.picpay_statement_imports where id = p_import_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'STATEMENT_IMPORT_NOT_FOUND';
  end if;
  -- Bulk runs of one import are serialized, and the selected lines are locked against single-line reviews.
  perform pg_advisory_xact_lock(hashtextextended('picpay-statement-bulk:' || p_import_id, 0));
  perform 1 from public.picpay_statement_lines line
  where line.id in (select selected.id from private.picpay_statement_bulk_selection(p_import_id, p_movement, p_from, p_to, p_line_ids) selected)
  order by line.line_number for update;
  v_summary := private.picpay_statement_bulk_summary(p_import_id, p_movement, p_from, p_to, p_line_ids, p_category);
  if (v_summary ->> 'count')::integer <> p_expected_count or (v_summary ->> 'total_cents')::bigint <> p_expected_total_cents
    or v_summary ->> 'selection_sha256' <> p_expected_selection_sha256 then
    raise exception using errcode = 'P0001', message = 'STATEMENT_BULK_SELECTION_CHANGED';
  end if;
  if jsonb_array_length(v_summary -> 'refusals') > 0 then
    raise exception using errcode = 'P0001', message = 'STATEMENT_BULK_SELECTION_INELIGIBLE';
  end if;

  insert into public.picpay_statement_line_resolutions (line_id, resolution, category, reason, automatic, actor_id, correlation_id, bulk_id)
  select selected.id, 'CLASSIFICADA', p_category, v_reason, false, v_actor_id, p_correlation_id, v_bulk_id
  from private.picpay_statement_bulk_selection(p_import_id, p_movement, p_from, p_to, p_line_ids) selected;
  get diagnostics v_inserted = row_count;
  if v_inserted <> p_expected_count then
    raise exception using errcode = 'P0001', message = 'STATEMENT_BULK_SELECTION_CHANGED';
  end if;

  v_result := jsonb_build_object('bulk_id', v_bulk_id, 'import_id', p_import_id, 'resolution', 'CLASSIFICADA', 'category', p_category,
    'count', v_inserted, 'total_cents', (v_summary ->> 'total_cents')::bigint, 'correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.statement.lines_bulk_resolved', v_actor_id, 'picpay_statement_import', p_import_id::text, p_correlation_id,
    jsonb_build_object('bulk_id', v_bulk_id, 'import_number', v_number, 'category', p_category, 'count', v_inserted,
      'total_cents', v_summary -> 'total_cents', 'inflow_cents', v_summary -> 'inflow_cents', 'outflow_cents', v_summary -> 'outflow_cents',
      'period_from', v_summary -> 'period_from', 'period_to', v_summary -> 'period_to', 'by_movement', v_summary -> 'by_movement',
      'selection_sha256', v_summary -> 'selection_sha256', 'filter', jsonb_build_object('movement', p_movement, 'from', p_from,
        'to', p_to, 'line_ids', case when p_line_ids is null then null else cardinality(p_line_ids) end)));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.statement.lines_bulk_resolved', 'picpay_statement_import', p_import_id::text,
    jsonb_build_object('bulk_id', v_bulk_id, 'count', v_inserted, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_statement_import', p_import_id::text);
  return v_result;
end;
$$;

revoke all on function private.is_statement_cutover_day(date) from public, anon, authenticated, service_role;
revoke all on function private.set_statement_resolution_cutover() from public, anon, authenticated, service_role;
revoke all on function private.statement_classification_refusal(public.picpay_statement_movement, bigint, date, public.finance_category)
  from public, anon, authenticated, service_role;
revoke all on function private.statement_link_record_effect(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.statement_record_is_linked(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.picpay_statement_bulk_selection(uuid, public.picpay_statement_movement, date, date, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function private.picpay_statement_bulk_summary(uuid, public.picpay_statement_movement, date, date, uuid[], public.finance_category)
  from public, anon, authenticated, service_role;
revoke all on function public.list_statement_link_candidates(uuid) from public, anon, authenticated, service_role;
revoke all on function public.link_picpay_statement_line(uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.preview_picpay_statement_bulk(uuid, public.picpay_statement_movement, date, date, uuid[], public.finance_category)
  from public, anon, authenticated, service_role;
revoke all on function public.resolve_picpay_statement_lines_bulk(uuid, public.picpay_statement_movement, date, date, uuid[],
  public.finance_category, text, integer, bigint, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_statement_link_candidates(uuid) to authenticated;
grant execute on function public.link_picpay_statement_line(uuid, uuid, uuid, text, text, uuid) to authenticated;
grant execute on function public.preview_picpay_statement_bulk(uuid, public.picpay_statement_movement, date, date, uuid[], public.finance_category)
  to authenticated;
grant execute on function public.resolve_picpay_statement_lines_bulk(uuid, public.picpay_statement_movement, date, date, uuid[],
  public.finance_category, text, integer, bigint, text, text, uuid) to authenticated;

comment on function public.link_picpay_statement_line(uuid, uuid, uuid, text, text, uuid) is
  'Links a pending PicPay line to the supplier payment or manual entry that already carries its effect (one line per record).';
comment on function public.resolve_picpay_statement_lines_bulk(uuid, public.picpay_statement_movement, date, date, uuid[],
  public.finance_category, text, integer, bigint, text, text, uuid) is
  'Classifies the previewed pending lines of one import in one transaction, refusing when the selection changed.';
