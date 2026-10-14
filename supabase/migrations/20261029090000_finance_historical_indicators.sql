-- PR E — historical finance and indicators (design frozen 2026-10-13).
--
-- 1. Historical adjustments without cash (finance_historical_adjustments): each one corrects exactly one component of
--    the result (RECEITA, REEMBOLSO, TAXA, CMV, PERDA, DESPESA_OPERACIONAL) by an absolute amount and a direction, at a
--    competence date before native operation. No account: structurally no cash movement, PicPay transaction,
--    receivable, payable settlement or transfer. Immutable; corrected by a reversal. A CMV/PERDA increase references the
--    AJUSTE_NEGATIVO stock movements whose cost it recognises: each movement covered by at most one active adjustment,
--    the amount at most their known cost. Lots, settlements, movements, the opening position and the PicPay statement are
--    never touched.
-- 2. Cutover counterpart designations (finance_cutover_counterparts): presentation only. A manual INCOME counterpart is
--    tied to the expense it neutralizes (a classified PicPay outflow attributed to the same cohort, or a manual expense);
--    the counterpart is consumed whole, the target may be partly neutralized and receive several designations (never
--    beyond its amount). The official result, ledgers, balances and statement rows never change; revocation is
--    append-only. No inference from category, reference prefix or description.
-- 3. Indicators: the official operating result includes the historical adjustments; presentation figures exclude the
--    counterparts only when both sides fall in the window (presented = official for every window); unknown COGS is made
--    visible (known > 0, known zero, unknown, estimable, not estimable) and never turned into zero.
-- 4. Fundraising goal: net available resources (PicPay free + Cofrinho + physical cash − open payables). Receivables are
--    future value, shown apart; the opening position is the only base; counting_from drives the projection.
-- 5. Result → cash bridge in two parts (since the current opening; before it, with the cutover difference per account),
--    an exact identity over the books, no plug; estimates stay outside.
-- No real data is created: no adjustment, no designation.

set local lock_timeout = '5s';

-- 1. Historical adjustments --------------------------------------------------------------------------------------------

create type public.finance_result_component as enum ('RECEITA', 'REEMBOLSO', 'TAXA', 'CMV', 'PERDA', 'DESPESA_OPERACIONAL');
create type public.finance_adjustment_direction as enum ('ACRESCIMO', 'REDUCAO');
create type public.finance_adjustment_provenance as enum ('HISTORICO_RECONSTRUIDO', 'IMPORTADO', 'IMPLANTACAO');

create table public.finance_historical_adjustments (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references public.cohorts (id) on delete restrict,
  component public.finance_result_component not null,
  direction public.finance_adjustment_direction not null,
  amount_cents bigint not null constraint finance_historical_adjustments_amount_valid check (amount_cents between 1 and 99999999999),
  competence_on date not null,
  category public.finance_category,
  justification text not null constraint finance_historical_adjustments_justification_valid
    check (char_length(justification) between 20 and 1000 and justification = btrim(justification)),
  reference text constraint finance_historical_adjustments_reference_valid
    check (reference is null or (char_length(reference) between 1 and 120 and reference = btrim(reference))),
  provenance public.finance_adjustment_provenance not null,
  reversal_of uuid unique references public.finance_historical_adjustments (id) on delete restrict,
  reversal_reason text,
  actor_id uuid not null references public.profiles (id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint finance_historical_adjustments_reversal_valid check (
    (reversal_of is null and reversal_reason is null)
    or (reversal_of is not null and char_length(reversal_reason) between 8 and 500 and reversal_reason = btrim(reversal_reason))),
  constraint finance_historical_adjustments_category_valid check (category is null or category not in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA'))
);
comment on table public.finance_historical_adjustments is
  'Ajuste histórico sem caixa: corrige um componente do resultado (sem conta, sem movimento de caixa). Imutável; correção por reversão.';
create trigger finance_historical_adjustments_immutable before update or delete on public.finance_historical_adjustments
for each row execute function private.prevent_immutable_record_change();
revoke all on public.finance_historical_adjustments from public, anon, authenticated, service_role;
select private.register_cohort_table('finance_historical_adjustments', 'finance', 'REQUIRED');

-- The stock movements whose cost a CMV/PERDA increase recognises.
create table public.finance_historical_adjustment_movements (
  adjustment_id uuid not null references cohort_data.finance_historical_adjustments (id) on delete restrict,
  stock_movement_id uuid not null references cohort_data.stock_movements (id) on delete restrict,
  cohort_id uuid references public.cohorts (id) on delete restrict,
  primary key (adjustment_id, stock_movement_id)
);
create index finance_historical_adjustment_movements_movement_idx on public.finance_historical_adjustment_movements (stock_movement_id);
create trigger finance_historical_adjustment_movements_immutable before update or delete on public.finance_historical_adjustment_movements
for each row execute function private.prevent_immutable_record_change();
revoke all on public.finance_historical_adjustment_movements from public, anon, authenticated, service_role;
select private.register_cohort_table('finance_historical_adjustment_movements', 'finance', 'REQUIRED');

insert into private.cohort_entity_types (entity_type, table_name) values
  ('finance_historical_adjustment', 'finance_historical_adjustments')
on conflict (entity_type) do nothing;

-- Signed effect of an adjustment row on the operating result (a reversal row undoes its original).
create function private.finance_adjustment_effect(
  p_component public.finance_result_component, p_direction public.finance_adjustment_direction, p_amount_cents bigint, p_reversal boolean
)
returns bigint language sql immutable set search_path = '' as $$
  select (case when p_reversal then -1 else 1 end)
    * (case when p_component = 'RECEITA' then 1 else -1 end)
    * (case when p_direction = 'ACRESCIMO' then 1 else -1 end)
    * p_amount_cents
$$;

-- Adjustment rows (originals and reversals) with their signed effect on the result and on the magnitude of their component.
create view private.finance_adjustment_effects as
  select adjustment.id, adjustment.cohort_id, adjustment.component, adjustment.competence_on, adjustment.category,
    adjustment.reversal_of is not null as reversal,
    private.finance_adjustment_effect(adjustment.component, adjustment.direction, adjustment.amount_cents, adjustment.reversal_of is not null) as result_effect_cents,
    (case when adjustment.reversal_of is not null then -1 else 1 end) * (case when adjustment.direction = 'ACRESCIMO' then 1 else -1 end)
      * adjustment.amount_cents as component_effect_cents
  from public.finance_historical_adjustments adjustment;
revoke all on private.finance_adjustment_effects from public, anon, authenticated, service_role;

-- Negative count adjustments with known cost, and whether an active adjustment already recognises them.
create function private.finance_adjustable_movements()
returns table (stock_movement_id uuid, moved_on date, reason text, source_type text, source_id text, units bigint, known_cost_cents bigint,
  unknown_units bigint, covered_by uuid)
language sql stable security definer set search_path = '' as $$
  select movement.id, (movement.created_at at time zone 'America/Sao_Paulo')::date, movement.reason, movement.source_type, movement.source_id,
    coalesce(sum(allocation.quantity), 0)::bigint,
    coalesce(sum(allocation.allocated_cost_cents), 0)::bigint,
    coalesce(sum(allocation.quantity) filter (where allocation.allocated_cost_cents is null), 0)::bigint,
    (select link.adjustment_id from public.finance_historical_adjustment_movements link
      join public.finance_historical_adjustments adjustment on adjustment.id = link.adjustment_id
      where link.stock_movement_id = movement.id
        and not exists (select 1 from public.finance_historical_adjustments reversal where reversal.reversal_of = adjustment.id)
      limit 1)
  from public.stock_movements movement
  join public.stock_movement_items item on item.movement_id = movement.id
  join public.stock_movement_lot_allocations allocation on allocation.movement_item_id = item.id
  where movement.movement_type = 'AJUSTE_NEGATIVO'
  group by movement.id, movement.created_at, movement.reason, movement.source_type, movement.source_id
$$;
revoke all on function private.finance_adjustment_effect(public.finance_result_component, public.finance_adjustment_direction, bigint, boolean),
  private.finance_adjustable_movements() from public, anon, authenticated, service_role;

create function private.finance_historical_adjustment_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', adjustment.id, 'component', adjustment.component, 'direction', adjustment.direction, 'amount_cents', adjustment.amount_cents,
    'competence_on', adjustment.competence_on, 'category', adjustment.category, 'justification', adjustment.justification,
    'reference', adjustment.reference, 'provenance', adjustment.provenance,
    'result_effect_cents', private.finance_adjustment_effect(adjustment.component, adjustment.direction, adjustment.amount_cents, adjustment.reversal_of is not null),
    'reversal_of', adjustment.reversal_of, 'reversal_reason', adjustment.reversal_reason,
    'reversed_by', (select reversal.id from public.finance_historical_adjustments reversal where reversal.reversal_of = adjustment.id),
    'stock_movements', coalesce((select jsonb_agg(jsonb_build_object('id', movable.stock_movement_id, 'moved_on', movable.moved_on,
        'reason', movable.reason, 'units', movable.units, 'known_cost_cents', movable.known_cost_cents) order by movable.moved_on, movable.stock_movement_id)
      from public.finance_historical_adjustment_movements link
      join private.finance_adjustable_movements() movable on movable.stock_movement_id = link.stock_movement_id
      where link.adjustment_id = coalesce(adjustment.reversal_of, adjustment.id)), '[]'::jsonb),
    'actor_name', coalesce(nullif(btrim(actor.display_name), ''), actor.email), 'created_at', adjustment.created_at)
  from public.finance_historical_adjustments adjustment
  join public.profiles actor on actor.id = adjustment.actor_id
  where adjustment.id = p_id
$$;
revoke all on function private.finance_historical_adjustment_json(uuid) from public, anon, authenticated, service_role;

create function public.record_finance_historical_adjustment(
  p_component public.finance_result_component, p_direction public.finance_adjustment_direction, p_amount_cents bigint,
  p_competence_on date, p_category public.finance_category, p_justification text, p_reference text,
  p_provenance public.finance_adjustment_provenance, p_stock_movement_ids uuid[], p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_cohort uuid;
  v_claim record;
  v_opening record;
  v_justification text := btrim(p_justification);
  v_reference text := nullif(btrim(p_reference), '');
  v_movements uuid[] := coalesce((select array_agg(distinct id) from unnest(p_stock_movement_ids) id where id is not null), '{}');
  v_known bigint;
  v_found integer;
  v_last_moved date;
  v_id uuid := gen_random_uuid();
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  v_cohort := private.cohort_write_id();
  if p_correlation_id is null or p_component is null or p_direction is null or p_amount_cents is null
    or p_amount_cents not between 1 and 99999999999 or p_competence_on is null or p_provenance is null
    or v_justification is null or char_length(v_justification) not between 20 and 1000
    or (v_reference is not null and char_length(v_reference) > 120)
    or p_category in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA') then
    raise exception using errcode = '22023', message = 'INVALID_HISTORICAL_ADJUSTMENT';
  end if;
  -- Stock movements belong to cost increases only, and a cost increase always names them (the duplicate guard).
  if (p_component in ('CMV', 'PERDA') and p_direction = 'ACRESCIMO') <> (cardinality(v_movements) > 0) then
    raise exception using errcode = '22023', message = 'HISTORICAL_ADJUSTMENT_MOVEMENTS_REQUIRED';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'record_historical_adjustment', v_actor_id), p_idempotency_key,
    jsonb_build_object('component', p_component, 'direction', p_direction, 'amount_cents', p_amount_cents, 'competence_on', p_competence_on,
      'category', p_category, 'justification', v_justification, 'reference', v_reference, 'provenance', p_provenance,
      'stock_movement_ids', to_jsonb(v_movements)));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  select * into v_opening from private.current_finance_opening_position();
  if v_opening.id is null then
    raise exception using errcode = 'P0001', message = 'OPENING_POSITION_REQUIRED';
  end if;
  if p_competence_on >= v_opening.operating_since then
    raise exception using errcode = 'P0001', message = 'HISTORICAL_ADJUSTMENT_NOT_HISTORICAL';
  end if;
  -- One adjustment at a time per cohort: the coverage of each movement is decided under this lock.
  perform pg_advisory_xact_lock(hashtextextended('finance-historical-adjustment:' || v_cohort, 0));
  if cardinality(v_movements) > 0 then
    select count(*), coalesce(sum(movable.known_cost_cents), 0), max(movable.moved_on)
    into v_found, v_known, v_last_moved
    from private.finance_adjustable_movements() movable where movable.stock_movement_id = any (v_movements);
    if v_found <> cardinality(v_movements) then
      raise exception using errcode = 'P0001', message = 'HISTORICAL_ADJUSTMENT_MOVEMENT_NOT_ELIGIBLE';
    end if;
    if exists (select 1 from private.finance_adjustable_movements() movable
      where movable.stock_movement_id = any (v_movements) and movable.covered_by is not null) then
      raise exception using errcode = 'P0001', message = 'HISTORICAL_ADJUSTMENT_MOVEMENT_ALREADY_COVERED';
    end if;
    if p_amount_cents > v_known then
      raise exception using errcode = 'P0001', message = 'HISTORICAL_ADJUSTMENT_ABOVE_REFERENCED_COST';
    end if;
    -- The cost of goods cannot be recognised before they left the stock.
    if p_competence_on < v_last_moved then
      raise exception using errcode = 'P0001', message = 'HISTORICAL_ADJUSTMENT_BEFORE_MOVEMENT';
    end if;
  end if;

  insert into public.finance_historical_adjustments (id, component, direction, amount_cents, competence_on, category, justification, reference,
    provenance, actor_id, correlation_id)
  values (v_id, p_component, p_direction, p_amount_cents, p_competence_on, p_category, v_justification, v_reference, p_provenance,
    v_actor_id, p_correlation_id);
  insert into public.finance_historical_adjustment_movements (adjustment_id, stock_movement_id)
  select v_id, id from unnest(v_movements) id;

  v_result := private.finance_historical_adjustment_json(v_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.historical_adjustment.recorded', v_actor_id, 'finance_historical_adjustment', v_id::text, p_correlation_id, v_result);
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.historical_adjustment.recorded', 'finance_historical_adjustment', v_id::text,
    jsonb_build_object('adjustment_id', v_id, 'component', p_component, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'finance_historical_adjustment', v_id::text);
  return v_result;
end;
$$;

create function public.reverse_finance_historical_adjustment(p_adjustment_id uuid, p_reason text, p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_cohort uuid;
  v_claim record;
  v_reason text := btrim(p_reason);
  v_original public.finance_historical_adjustments%rowtype;
  v_id uuid := gen_random_uuid();
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  v_cohort := private.cohort_write_id();
  if p_correlation_id is null or p_adjustment_id is null or v_reason is null or char_length(v_reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_HISTORICAL_ADJUSTMENT_REVERSAL';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'reverse_historical_adjustment', v_actor_id), p_idempotency_key,
    jsonb_build_object('adjustment_id', p_adjustment_id, 'reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('finance-historical-adjustment:' || v_cohort, 0));
  select * into v_original from public.finance_historical_adjustments where id = p_adjustment_id;
  if v_original.id is null then
    raise exception using errcode = 'P0001', message = 'HISTORICAL_ADJUSTMENT_NOT_FOUND';
  end if;
  if v_original.reversal_of is not null
    or exists (select 1 from public.finance_historical_adjustments reversal where reversal.reversal_of = v_original.id) then
    raise exception using errcode = 'P0001', message = 'HISTORICAL_ADJUSTMENT_NOT_REVERSIBLE';
  end if;
  insert into public.finance_historical_adjustments (id, component, direction, amount_cents, competence_on, category, justification, reference,
    provenance, reversal_of, reversal_reason, actor_id, correlation_id)
  values (v_id, v_original.component, v_original.direction, v_original.amount_cents, v_original.competence_on, v_original.category,
    v_original.justification, v_original.reference, v_original.provenance, v_original.id, v_reason, v_actor_id, p_correlation_id);
  v_result := private.finance_historical_adjustment_json(v_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.historical_adjustment.reversed', v_actor_id, 'finance_historical_adjustment', v_id::text, p_correlation_id, v_result);
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.historical_adjustment.reversed', 'finance_historical_adjustment', v_id::text,
    jsonb_build_object('adjustment_id', v_id, 'reversal_of', v_original.id, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'finance_historical_adjustment', v_id::text);
  return v_result;
end;
$$;

create function public.list_finance_historical_adjustments()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.finance_historical_adjustment_json(adjustment.id) order by adjustment.created_at desc, adjustment.id)
      from public.finance_historical_adjustments adjustment), '[]'::jsonb),
    'movements', coalesce((select jsonb_agg(jsonb_build_object('id', movable.stock_movement_id, 'moved_on', movable.moved_on, 'reason', movable.reason,
        'source_type', movable.source_type, 'source_id', movable.source_id, 'units', movable.units, 'known_cost_cents', movable.known_cost_cents,
        'unknown_units', movable.unknown_units, 'covered_by', movable.covered_by) order by movable.moved_on desc, movable.stock_movement_id)
      from private.finance_adjustable_movements() movable), '[]'::jsonb),
    'operating_since', (select operating_since from private.current_finance_opening_position()));
end;
$$;

-- 2. Cutover counterpart designations (presentation only) ---------------------------------------------------------------

create table public.finance_cutover_counterparts (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references public.cohorts (id) on delete restrict,
  counterpart_manual_entry_id uuid not null references cohort_data.finance_manual_entries (id) on delete restrict,
  target_statement_line_id uuid references public.picpay_statement_lines (id) on delete restrict,
  target_manual_expense_id uuid references cohort_data.finance_manual_entries (id) on delete restrict,
  neutralized_cents bigint not null constraint finance_cutover_counterparts_amount_valid check (neutralized_cents between 1 and 99999999999),
  reason text not null constraint finance_cutover_counterparts_reason_valid check (char_length(reason) between 8 and 500 and reason = btrim(reason)),
  created_by uuid not null references public.profiles (id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint finance_cutover_counterparts_one_target check (num_nonnulls(target_statement_line_id, target_manual_expense_id) = 1),
  constraint finance_cutover_counterparts_not_self check (target_manual_expense_id is distinct from counterpart_manual_entry_id)
);
comment on table public.finance_cutover_counterparts is
  'Designação gerencial: uma receita manual que é contrapartida técnica do cutover neutraliza (toda) parte de uma despesa. '
  'Só apresentação; resultado oficial, livros e saldos não mudam. Revogação em tabela própria (append-only).';
create index finance_cutover_counterparts_counterpart_idx on public.finance_cutover_counterparts (counterpart_manual_entry_id);
create index finance_cutover_counterparts_line_idx on public.finance_cutover_counterparts (target_statement_line_id) where target_statement_line_id is not null;
create index finance_cutover_counterparts_expense_idx on public.finance_cutover_counterparts (target_manual_expense_id) where target_manual_expense_id is not null;
create trigger finance_cutover_counterparts_immutable before update or delete on public.finance_cutover_counterparts
for each row execute function private.prevent_immutable_record_change();
revoke all on public.finance_cutover_counterparts from public, anon, authenticated, service_role;
select private.register_cohort_table('finance_cutover_counterparts', 'finance', 'REQUIRED');

create table public.finance_cutover_counterpart_revocations (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references public.cohorts (id) on delete restrict,
  designation_id uuid not null unique references cohort_data.finance_cutover_counterparts (id) on delete restrict,
  reason text not null constraint finance_cutover_counterpart_revocations_reason_valid check (char_length(reason) between 8 and 500 and reason = btrim(reason)),
  revoked_by uuid not null references public.profiles (id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);
create trigger finance_cutover_counterpart_revocations_immutable before update or delete on public.finance_cutover_counterpart_revocations
for each row execute function private.prevent_immutable_record_change();
revoke all on public.finance_cutover_counterpart_revocations from public, anon, authenticated, service_role;
select private.register_cohort_table('finance_cutover_counterpart_revocations', 'finance', 'REQUIRED');

insert into private.cohort_entity_types (entity_type, table_name) values
  ('finance_cutover_counterpart', 'finance_cutover_counterparts')
on conflict (entity_type) do nothing;

-- Every designation with both sides as they are now. A designation applies only while it is active and both sides are
-- still what was designated: the counterpart an unreversed manual income, the target an unreversed manual expense or a
-- PicPay outflow still classified as an expense and attributed to the same cohort.
create view private.finance_counterpart_designations as
  select designation.id, designation.cohort_id, designation.neutralized_cents, designation.reason, designation.created_by, designation.created_at,
    designation.correlation_id,
    revocation.id as revocation_id, revocation.reason as revocation_reason, revocation.revoked_by, revocation.created_at as revoked_at,
    counterpart.id as counterpart_id, counterpart.occurred_on as counterpart_on, counterpart.amount_cents as counterpart_cents,
    counterpart.description as counterpart_description, counterpart.reference as counterpart_reference, counterpart.category as counterpart_category,
    case when designation.target_statement_line_id is not null then 'STATEMENT_LINE' else 'MANUAL_EXPENSE' end as target_kind,
    coalesce(designation.target_statement_line_id, designation.target_manual_expense_id) as target_id,
    coalesce(line.occurred_on, expense.occurred_on) as target_on,
    coalesce(-line.amount_cents, expense.amount_cents) as target_cents,
    coalesce('Extrato PicPay: ' || line.movement_label || coalesce(' · ' || line.description, ''), expense.description) as target_description,
    coalesce('PICPAY-CSV-' || statement_import.number || '-L' || line.line_number, expense.reference) as target_reference,
    coalesce(line_resolution.category, expense.category) as target_category,
    (revocation.id is null
      and counterpart.kind = 'INCOME'
      and not exists (select 1 from cohort_data.finance_manual_entries reversal where reversal.reversal_of = counterpart.id)
      and case when designation.target_statement_line_id is not null then
          line_resolution.resolution = 'CLASSIFICADA' and line.amount_cents < 0 and line_resolution.category <> 'TAXAS'
          and line.movement not in ('PIX_ESTORNADO', 'PIX_DEVOLVIDO') and line_attribution.cohort_id = designation.cohort_id
        else expense.kind = 'EXPENSE' and expense.category <> 'TAXAS'
          and not exists (select 1 from cohort_data.finance_manual_entries reversal where reversal.reversal_of = expense.id)
      end) as applies,
    revocation.id is null as active
  from cohort_data.finance_cutover_counterparts designation
  join cohort_data.finance_manual_entries counterpart on counterpart.id = designation.counterpart_manual_entry_id
  left join cohort_data.finance_cutover_counterpart_revocations revocation on revocation.designation_id = designation.id
  left join public.picpay_statement_lines line on line.id = designation.target_statement_line_id
  left join public.picpay_statement_imports statement_import on statement_import.id = line.import_id
  left join private.picpay_statement_current_resolutions line_resolution on line_resolution.line_id = line.id
  left join private.picpay_line_cohorts line_attribution on line_attribution.line_id = line.id
  left join cohort_data.finance_manual_entries expense on expense.id = designation.target_manual_expense_id;
revoke all on private.finance_counterpart_designations from public, anon, authenticated, service_role;

create function private.finance_counterpart_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', designation.id, 'neutralized_cents', designation.neutralized_cents, 'reason', designation.reason,
    'status', case when not designation.active then 'REVOGADA' when designation.applies then 'ATIVA' else 'INVALIDA' end,
    'counterpart', jsonb_build_object('id', designation.counterpart_id, 'occurred_on', designation.counterpart_on, 'amount_cents', designation.counterpart_cents,
      'description', designation.counterpart_description, 'reference', designation.counterpart_reference, 'category', designation.counterpart_category),
    'target', jsonb_build_object('kind', designation.target_kind, 'id', designation.target_id, 'occurred_on', designation.target_on,
      'amount_cents', designation.target_cents, 'description', designation.target_description, 'reference', designation.target_reference,
      'category', designation.target_category),
    -- Presentation only: neither cash nor the official result move.
    'cash_effect_cents', 0, 'result_effect_cents', 0,
    'created_by', coalesce(nullif(btrim(creator.display_name), ''), creator.email), 'created_at', designation.created_at,
    'revocation', case when designation.revocation_id is null then null else jsonb_build_object('reason', designation.revocation_reason,
      'revoked_by', coalesce(nullif(btrim(revoker.display_name), ''), revoker.email), 'revoked_at', designation.revoked_at) end)
  from private.finance_counterpart_designations designation
  join public.profiles creator on creator.id = designation.created_by
  left join public.profiles revoker on revoker.id = designation.revoked_by
  where designation.id = p_id and designation.cohort_id = any (private.cohort_scope())
$$;
revoke all on function private.finance_counterpart_json(uuid) from public, anon, authenticated, service_role;

-- Designates a manual income as the technical counterpart of an expense. Both before native operation, in the cohort of
-- the request; the counterpart is consumed whole (neutralized = its amount), the target never beyond its amount.
create function public.designate_cutover_counterpart(
  p_counterpart_manual_entry_id uuid, p_target_statement_line_id uuid, p_target_manual_expense_id uuid, p_neutralized_cents bigint,
  p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_cohort uuid;
  v_claim record;
  v_reason text := btrim(p_reason);
  v_opening record;
  v_counterpart cohort_data.finance_manual_entries%rowtype;
  v_line public.picpay_statement_lines%rowtype;
  v_line_resolution record;
  v_expense cohort_data.finance_manual_entries%rowtype;
  v_target_on date;
  v_target_cents bigint;
  v_target_used bigint;
  v_id uuid := gen_random_uuid();
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  v_cohort := private.cohort_write_id();
  if p_correlation_id is null or p_counterpart_manual_entry_id is null
    or num_nonnulls(p_target_statement_line_id, p_target_manual_expense_id) <> 1
    or p_neutralized_cents is null or p_neutralized_cents < 1 or v_reason is null or char_length(v_reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_CUTOVER_COUNTERPART';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'designate_cutover_counterpart', v_actor_id), p_idempotency_key,
    jsonb_build_object('counterpart', p_counterpart_manual_entry_id, 'target_line', p_target_statement_line_id,
      'target_expense', p_target_manual_expense_id, 'neutralized_cents', p_neutralized_cents, 'reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select * into v_opening from private.current_finance_opening_position();
  if v_opening.id is null then
    raise exception using errcode = 'P0001', message = 'OPENING_POSITION_REQUIRED';
  end if;
  -- Designations of a cohort are decided one at a time: what is still available never oversubscribes.
  perform pg_advisory_xact_lock(hashtextextended('finance-cutover-counterparts:' || v_cohort, 0));

  -- The counterpart: an unreversed manual income of this cohort, before native operation, not designated yet.
  select * into v_counterpart from cohort_data.finance_manual_entries where id = p_counterpart_manual_entry_id and cohort_id = v_cohort;
  if v_counterpart.id is null or v_counterpart.kind <> 'INCOME'
    or exists (select 1 from cohort_data.finance_manual_entries reversal where reversal.reversal_of = v_counterpart.id) then
    raise exception using errcode = 'P0001', message = 'CUTOVER_COUNTERPART_NOT_ELIGIBLE';
  end if;
  if v_counterpart.occurred_on >= v_opening.operating_since then
    raise exception using errcode = 'P0001', message = 'CUTOVER_COUNTERPART_NOT_HISTORICAL';
  end if;
  if exists (select 1 from private.finance_counterpart_designations designation
    where designation.counterpart_id = v_counterpart.id and designation.active) then
    raise exception using errcode = 'P0001', message = 'CUTOVER_COUNTERPART_ALREADY_DESIGNATED';
  end if;
  -- Initial version: the counterpart is consumed whole.
  if p_neutralized_cents <> v_counterpart.amount_cents then
    raise exception using errcode = 'P0001', message = 'CUTOVER_COUNTERPART_AMOUNT_MISMATCH';
  end if;

  -- The target: a PicPay outflow classified as an expense and already attributed to this cohort (the designation never
  -- attributes a line), or an unreversed manual expense of this cohort; before native operation.
  if p_target_statement_line_id is not null then
    select * into v_line from public.picpay_statement_lines where id = p_target_statement_line_id;
    select current.resolution, current.category into v_line_resolution
    from private.picpay_statement_current_resolutions current where current.line_id = p_target_statement_line_id;
    if v_line.id is null
      or (select cohort_id from private.picpay_line_cohorts where line_id = v_line.id) is distinct from v_cohort then
      raise exception using errcode = 'P0001', message = 'CUTOVER_TARGET_NOT_IN_COHORT';
    end if;
    if v_line_resolution.resolution is distinct from 'CLASSIFICADA' or v_line.amount_cents >= 0 or v_line_resolution.category = 'TAXAS'
      or v_line.movement in ('PIX_ESTORNADO', 'PIX_DEVOLVIDO') then
      raise exception using errcode = 'P0001', message = 'CUTOVER_TARGET_NOT_EXPENSE';
    end if;
    v_target_on := v_line.occurred_on;
    v_target_cents := -v_line.amount_cents;
  else
    select * into v_expense from cohort_data.finance_manual_entries where id = p_target_manual_expense_id and cohort_id = v_cohort;
    if v_expense.id is null then
      raise exception using errcode = 'P0001', message = 'CUTOVER_TARGET_NOT_IN_COHORT';
    end if;
    if v_expense.kind <> 'EXPENSE' or v_expense.category = 'TAXAS'
      or exists (select 1 from cohort_data.finance_manual_entries reversal where reversal.reversal_of = v_expense.id) then
      raise exception using errcode = 'P0001', message = 'CUTOVER_TARGET_NOT_EXPENSE';
    end if;
    v_target_on := v_expense.occurred_on;
    v_target_cents := v_expense.amount_cents;
  end if;
  if v_target_on >= v_opening.operating_since then
    raise exception using errcode = 'P0001', message = 'CUTOVER_TARGET_NOT_HISTORICAL';
  end if;
  select coalesce(sum(designation.neutralized_cents), 0) into v_target_used
  from private.finance_counterpart_designations designation
  where designation.active and designation.target_id = coalesce(p_target_statement_line_id, p_target_manual_expense_id);
  if p_neutralized_cents > v_target_cents - v_target_used then
    raise exception using errcode = 'P0001', message = 'CUTOVER_TARGET_EXCEEDED',
      detail = 'available ' || (v_target_cents - v_target_used);
  end if;

  insert into public.finance_cutover_counterparts (id, counterpart_manual_entry_id, target_statement_line_id, target_manual_expense_id,
    neutralized_cents, reason, created_by, correlation_id)
  values (v_id, v_counterpart.id, p_target_statement_line_id, p_target_manual_expense_id, p_neutralized_cents, v_reason, v_actor_id, p_correlation_id);
  v_result := private.finance_counterpart_json(v_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.cutover_counterpart.designated', v_actor_id, 'finance_cutover_counterpart', v_id::text, p_correlation_id, v_result);
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.cutover_counterpart.designated', 'finance_cutover_counterpart', v_id::text,
    jsonb_build_object('designation_id', v_id, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'finance_cutover_counterpart', v_id::text);
  return v_result;
end;
$$;

-- Revocation keeps the designation and records who, when and why; the presentation goes back to the original entries.
create function public.revoke_cutover_counterpart(p_designation_id uuid, p_reason text, p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_cohort uuid;
  v_claim record;
  v_reason text := btrim(p_reason);
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  v_cohort := private.cohort_write_id();
  if p_correlation_id is null or p_designation_id is null or v_reason is null or char_length(v_reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_CUTOVER_COUNTERPART_REVOCATION';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'revoke_cutover_counterpart', v_actor_id), p_idempotency_key,
    jsonb_build_object('designation_id', p_designation_id, 'reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('finance-cutover-counterparts:' || v_cohort, 0));
  if not exists (select 1 from cohort_data.finance_cutover_counterparts where id = p_designation_id and cohort_id = v_cohort) then
    raise exception using errcode = 'P0001', message = 'CUTOVER_COUNTERPART_NOT_FOUND';
  end if;
  if exists (select 1 from cohort_data.finance_cutover_counterpart_revocations where designation_id = p_designation_id) then
    raise exception using errcode = 'P0001', message = 'CUTOVER_COUNTERPART_ALREADY_REVOKED';
  end if;
  insert into public.finance_cutover_counterpart_revocations (designation_id, reason, revoked_by, correlation_id)
  values (p_designation_id, v_reason, v_actor_id, p_correlation_id);
  v_result := private.finance_counterpart_json(p_designation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.cutover_counterpart.revoked', v_actor_id, 'finance_cutover_counterpart', p_designation_id::text, p_correlation_id, v_result);
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.cutover_counterpart.revoked', 'finance_cutover_counterpart', p_designation_id::text,
    jsonb_build_object('designation_id', p_designation_id, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'finance_cutover_counterpart', p_designation_id::text);
  return v_result;
end;
$$;

-- Designations and what can still be designated (historical manual incomes, and historical expenses with what is left).
create function public.list_cutover_counterparts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_since date := (select operating_since from private.current_finance_opening_position());
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  return jsonb_build_object(
    'operating_since', v_since,
    'items', coalesce((select jsonb_agg(private.finance_counterpart_json(designation.id) order by designation.created_at desc, designation.id)
      from private.finance_counterpart_designations designation where designation.cohort_id = any (private.cohort_scope())), '[]'::jsonb),
    'counterpart_candidates', coalesce((select jsonb_agg(jsonb_build_object('id', entry.id, 'occurred_on', entry.occurred_on,
        'amount_cents', entry.amount_cents, 'category', entry.category, 'description', entry.description, 'reference', entry.reference)
        order by entry.occurred_on desc, entry.id)
      from public.finance_manual_entries entry
      where v_since is not null and entry.kind = 'INCOME' and entry.occurred_on < v_since
        and not exists (select 1 from public.finance_manual_entries reversal where reversal.reversal_of = entry.id)
        and not exists (select 1 from private.finance_counterpart_designations designation where designation.counterpart_id = entry.id and designation.active)), '[]'::jsonb),
    'target_candidates', coalesce((select jsonb_agg(candidate order by candidate ->> 'occurred_on' desc) from (
      select jsonb_build_object('kind', 'STATEMENT_LINE', 'id', line.id, 'occurred_on', line.occurred_on, 'amount_cents', -line.amount_cents,
          'available_cents', -line.amount_cents - coalesce((select sum(designation.neutralized_cents) from private.finance_counterpart_designations designation
            where designation.target_id = line.id and designation.active), 0),
          'category', current.category, 'description', 'Extrato PicPay: ' || line.movement_label || coalesce(' · ' || line.description, ''),
          'reference', 'PICPAY-CSV-' || statement_import.number || '-L' || line.line_number) as candidate
      from public.picpay_statement_lines line
      join public.picpay_statement_imports statement_import on statement_import.id = line.import_id
      join private.picpay_statement_current_resolutions current on current.line_id = line.id
      join private.picpay_line_cohorts attribution on attribution.line_id = line.id
      where v_since is not null and line.occurred_on < v_since and current.resolution = 'CLASSIFICADA' and line.amount_cents < 0
        and current.category <> 'TAXAS' and line.movement not in ('PIX_ESTORNADO', 'PIX_DEVOLVIDO')
        and attribution.cohort_id = private.cohort_write_id()
      union all
      select jsonb_build_object('kind', 'MANUAL_EXPENSE', 'id', entry.id, 'occurred_on', entry.occurred_on, 'amount_cents', entry.amount_cents,
          'available_cents', entry.amount_cents - coalesce((select sum(designation.neutralized_cents) from private.finance_counterpart_designations designation
            where designation.target_id = entry.id and designation.active), 0),
          'category', entry.category, 'description', entry.description, 'reference', entry.reference)
      from public.finance_manual_entries entry
      where v_since is not null and entry.kind = 'EXPENSE' and entry.occurred_on < v_since and entry.category <> 'TAXAS'
        and not exists (select 1 from public.finance_manual_entries reversal where reversal.reversal_of = entry.id)
    ) candidates), '[]'::jsonb));
end;
$$;

-- The result exactly as the books record it (the computation in force before E, unchanged).
CREATE FUNCTION private.compute_management_indicators_registered(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_days integer;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using errcode = '22023', message = 'INVALID_INDICATORS_PERIOD';
  end if;
  v_start := p_from::timestamp at time zone 'America/Sao_Paulo';
  v_end := (p_to + 1)::timestamp at time zone 'America/Sao_Paulo';
  v_days := p_to - p_from + 1;

  return (
    with statement as (
      select * from private.finance_statement_rows(p_from, p_to)
    ),
    raffle_sales as (
      select distinct sale_id from public.raffle_numbers where sale_id is not null
      union
      select sale_id from public.raffle_sale_refunds
    ),
    sale_entries as (
      select entry.sale_id, entry.payment_attempt_id, entry.entry_type, entry.amount_cents,
        (entry.created_at at time zone 'America/Sao_Paulo')::date as day,
        coalesce(attempt.card_method::text, attempt.integration_channel::text) as method
      from public.financial_ledger_entries entry
      join public.payment_attempts attempt on attempt.id = entry.payment_attempt_id
      where entry.created_at >= v_start and entry.created_at < v_end
    ),
    receipts as (
      select * from sale_entries where entry_type in ('RECEIVABLE_PICPAY', 'CASH_RECEIPT')
    ),
    refunds as (
      select * from sale_entries where entry_type = 'REFUND'
    ),
    -- Acréscimo charged to the customer (part of the receipts) and given back by full refunds; never a fee.
    surcharges as (
      select surcharge.method::text as method, surcharge.applied_cents, surcharge.expected_cents - surcharge.applied_cents as waived_cents,
        case when receipt.payment_attempt_id is not null then 1 else 0 end as received,
        case when refund.payment_attempt_id is not null then 1 else 0 end as refunded
      from public.payment_surcharges surcharge
      left join (select distinct payment_attempt_id from receipts) receipt on receipt.payment_attempt_id = surcharge.payment_attempt_id
      left join (select distinct payment_attempt_id from refunds) refund on refund.payment_attempt_id = surcharge.payment_attempt_id
      where receipt.payment_attempt_id is not null or refund.payment_attempt_id is not null
    ),
    manual as (
      select coalesce(original.kind, entry.kind) as kind, coalesce(original.category, entry.category) as category,
        case when entry.kind = 'REVERSAL' then -entry.amount_cents else entry.amount_cents end as amount_cents,
        entry.occurred_on as day
      from public.finance_manual_entries entry
      left join public.finance_manual_entries original on original.id = entry.reversal_of
      where entry.occurred_on between p_from and p_to
        and coalesce(original.kind, entry.kind) in ('INCOME', 'EXPENSE')
      union all
      -- Classified lines of imported PicPay statements count like manual income and expense.
      select flow.kind, flow.category, flow.amount_cents, flow.day from private.picpay_statement_flows(p_from, p_to) flow
    ),
    -- Lot cost of the goods leaving through sales, and the cost a reversal brought back.
    cost_lines as (
      select item.product_id, (movement.created_at at time zone 'America/Sao_Paulo')::date as day,
        case when movement.movement_type = 'VENDA' then 1 else -1 end as direction,
        allocation.quantity, allocation.allocated_cost_cents
      from public.stock_movements movement
      join public.stock_movement_items item on item.movement_id = movement.id
      join public.stock_movement_lot_allocations allocation on allocation.movement_item_id = item.id
      where movement.created_at >= v_start and movement.created_at < v_end
        and ((movement.movement_type = 'VENDA' and movement.source_type = 'sale')
          or (movement.movement_type = 'CANCELAMENTO_VENDA' and movement.source_type = 'sale_reversal'))
    ),
    losses as (
      select report.product_id, product.name as product_name, report.reason::text as reason, report.location_id,
        location.name as location_name, report.quantity,
        (select sum(allocation.allocated_cost_cents) from public.stock_movement_items item
          join public.stock_movement_lot_allocations allocation on allocation.movement_item_id = item.id
          where item.movement_id = report.movement_id) as cost_cents,
        (select coalesce(sum(allocation.quantity) filter (where allocation.allocated_cost_cents is null), 0) from public.stock_movement_items item
          join public.stock_movement_lot_allocations allocation on allocation.movement_item_id = item.id
          where item.movement_id = report.movement_id) as unknown_units,
        (report.decided_at at time zone 'America/Sao_Paulo')::date as day
      from public.stock_loss_reports report
      join public.products product on product.id = report.product_id
      join public.stock_locations location on location.id = report.location_id
      where report.status = 'APPLIED' and report.decided_at >= v_start and report.decided_at < v_end
    ),
    figures as (
      select
        coalesce((select sum(amount_cents) from statement where source = 'SALE' and amount_cents > 0
          and category in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA')), 0) as sale_revenue,
        coalesce((select sum(amount_cents) from manual where kind = 'INCOME'), 0) as manual_income,
        coalesce((select sum(amount_cents) from statement where source = 'PICPAY' and category = 'RECEITA_HISTORICA'), 0) as picpay_revenue,
        coalesce((select -sum(amount_cents) from statement where source in ('SALE', 'PICPAY') and category = 'REEMBOLSO'), 0) as refunds,
        coalesce((select -sum(amount_cents) from statement where category = 'TAXAS'), 0) as fees,
        coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'AJUSTE'), 0) as divergences,
        coalesce((select sum(amount_cents) from manual where kind = 'EXPENSE' and category <> 'TAXAS'), 0) as expenses,
        coalesce((select -sum(amount_cents) from statement where source = 'PAYABLE'), 0) as supplier_payments,
        coalesce((select sum(amount_cents) from statement where category is not null or source = 'IMPORT_PENDING'), 0) as cash_balance,
        coalesce((select sum(direction * allocated_cost_cents) from cost_lines where allocated_cost_cents is not null), 0) as cogs,
        coalesce((select sum(direction * quantity) from cost_lines where allocated_cost_cents is null), 0) as cogs_unknown_units,
        coalesce((select sum(cost_cents) from losses), 0) as losses_cost,
        coalesce((select sum(quantity) from losses), 0) as losses_units,
        coalesce((select sum(unknown_units) from losses), 0) as losses_unknown_units,
        coalesce((select sum(applied_cents) from surcharges where received = 1), 0) as surcharge_revenue,
        coalesce((select sum(applied_cents) from surcharges where refunded = 1), 0) as surcharge_refunds,
        coalesce((select sum(waived_cents) from surcharges where received = 1), 0) as surcharge_waived,
        (select count(*) from surcharges where received = 1 and waived_cents > 0) as surcharge_waivers,
        (select count(distinct sale_id) from receipts) as sales_count,
        (select count(distinct sale_id) from refunds) as refunded_sales
    ),
    totals as (
      select figures.*, sale_revenue + manual_income + picpay_revenue as gross_revenue,
        sale_revenue + manual_income + picpay_revenue - refunds - fees + divergences as net_revenue
      from figures
    ),
    product_lines as (
      select item.product_id, item.product_name, item.quantity, item.total_cents
      from (select distinct sale_id from receipts) sold join public.sale_items item on item.sale_id = sold.sale_id
      where sold.sale_id not in (select sale_id from raffle_sales)
      union all
      select item.product_id, item.product_name, -item.quantity, -item.total_cents
      from (select distinct sale_id from refunds) returned join public.sale_items item on item.sale_id = returned.sale_id
      where returned.sale_id not in (select sale_id from raffle_sales)
    ),
    products as (
      select lines.product_id, max(lines.product_name) as product_name, sum(lines.quantity) as units, sum(lines.total_cents) as revenue_cents,
        (select sum(direction * allocated_cost_cents) from cost_lines cost where cost.product_id = lines.product_id and cost.allocated_cost_cents is not null) as cost_cents,
        (select coalesce(sum(direction * quantity), 0) from cost_lines cost where cost.product_id = lines.product_id and cost.allocated_cost_cents is null) as unknown_units
      from product_lines lines group by lines.product_id
    ),
    seller_sales as (
      select sale.created_by, sale.id, sale.total_cents, 1 as direction
      from (select distinct sale_id from receipts) sold join public.sales sale on sale.id = sold.sale_id
      where sale.channel in ('PDV', 'RESERVA')
      union all
      select sale.created_by, sale.id, sale.total_cents, -1
      from (select distinct sale_id from refunds) returned join public.sales sale on sale.id = returned.sale_id
      where sale.channel in ('PDV', 'RESERVA')
    ),
    sellers as (
      select seller.id as seller_id, coalesce(nullif(btrim(seller.display_name), ''), split_part(seller.email, '@', 1)) as seller_name,
        sum(direction * total_cents) as revenue_cents,
        count(*) filter (where direction = 1) as sales_count,
        count(*) filter (where direction = -1) as refunded_count,
        (select coalesce(sum(direction * item.quantity), 0) from seller_sales inner_sale join public.sale_items item on item.sale_id = inner_sale.id
          where inner_sale.created_by = seller.id) as units
      from seller_sales join public.profiles seller on seller.id = seller_sales.created_by
      group by seller.id, seller.display_name, seller.email
    ),
    days as (
      select generate_series(p_from, p_to, interval '1 day')::date as day
    ),
    daily as (
      select days.day,
        coalesce((select sum(amount_cents) from statement row where row.occurred_on = days.day and row.source = 'SALE' and row.amount_cents > 0
          and row.category in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA')), 0)
          + coalesce((select sum(amount_cents) from manual where manual.day = days.day and manual.kind = 'INCOME'), 0)
          + coalesce((select sum(amount_cents) from statement row where row.occurred_on = days.day and row.source = 'PICPAY'
            and row.category = 'RECEITA_HISTORICA'), 0) as revenue_cents,
        coalesce((select sum(amount_cents) from statement row where row.occurred_on = days.day
          and (row.category = 'TAXAS' or (row.source in ('SALE', 'PICPAY') and row.category in ('REEMBOLSO', 'AJUSTE')))), 0) as deductions_cents,
        coalesce((select sum(direction * allocated_cost_cents) from cost_lines where cost_lines.day = days.day and allocated_cost_cents is not null), 0) as cogs_cents
      from days
    )
    select jsonb_build_object(
      'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days, 'time_zone', 'America/Sao_Paulo'),
      'totals', (select jsonb_build_object(
        'gross_revenue_cents', gross_revenue, 'sale_revenue_cents', sale_revenue, 'manual_income_cents', manual_income,
        'product_revenue_cents', sale_revenue - surcharge_revenue, 'surcharge_revenue_cents', surcharge_revenue,
        'surcharge_refunds_cents', surcharge_refunds, 'surcharge_waived_cents', surcharge_waived,
        'surcharge_waivers', surcharge_waivers,
        'refunds_cents', refunds, 'fees_cents', fees, 'divergences_cents', divergences, 'net_revenue_cents', net_revenue,
        'cogs_cents', cogs, 'cogs_unknown_units', cogs_unknown_units,
        'losses_cost_cents', losses_cost, 'losses_units', losses_units, 'losses_unknown_units', losses_unknown_units,
        'operating_expenses_cents', expenses, 'supplier_payments_cents', supplier_payments,
        'gross_margin_cents', net_revenue - cogs,
        'gross_margin_bps', case when net_revenue > 0 then floor((net_revenue - cogs) * 10000 / net_revenue)::bigint end,
        'operating_profit_cents', net_revenue - cogs - losses_cost - expenses,
        'cash_balance_cents', cash_balance,
        'sales_count', sales_count, 'refunded_sales', refunded_sales,
        'average_ticket_cents', case when sales_count > 0 then floor(sale_revenue / sales_count)::bigint end,
        'cost_complete', cogs_unknown_units = 0 and losses_unknown_units = 0) from totals),
      'by_channel', jsonb_build_object(
        'PDV', coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'VENDA_PDV' and amount_cents > 0), 0),
        'ONLINE', coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'VENDA_ONLINE' and amount_cents > 0), 0),
        'RESERVA', coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'RESERVA' and amount_cents > 0), 0),
        'RIFA', coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'RIFA' and amount_cents > 0), 0),
        'EVENTO', coalesce((select sum(amount_cents) from manual where kind = 'INCOME' and category = 'EVENTO'), 0),
        'MANUAL', coalesce((select sum(amount_cents) from manual where kind = 'INCOME' and category <> 'EVENTO'), 0),
        'HISTORICO_PICPAY', coalesce((select sum(amount_cents) from statement where source = 'PICPAY' and category = 'RECEITA_HISTORICA'), 0)),
      'by_payment_method', coalesce((select jsonb_object_agg(method, total) from (
        select method, sum(amount_cents) as total from receipts group by method) grouped), '{}'::jsonb),
      'refunds_by_payment_method', coalesce((select jsonb_object_agg(method, total) from (
        select method, -sum(amount_cents) as total from refunds group by method) grouped), '{}'::jsonb),
      'expenses_by_category', coalesce((select jsonb_object_agg(category, total) from (
        select category, sum(amount_cents) as total from manual where kind = 'EXPENSE' group by category) grouped), '{}'::jsonb),
      'top_products', coalesce((select jsonb_agg(jsonb_build_object(
          'product_id', product_id, 'product_name', product_name, 'units', units, 'revenue_cents', revenue_cents,
          'cost_cents', cost_cents, 'unknown_cost_units', unknown_units,
          'margin_cents', case when unknown_units = 0 then revenue_cents - coalesce(cost_cents, 0) end,
          'units_per_day', round(units::numeric / v_days, 2))
        order by revenue_cents desc, units desc, product_id) from (select * from products where units <> 0 or revenue_cents <> 0
          order by revenue_cents desc, units desc, product_id limit 10) ranked), '[]'::jsonb),
      'sellers', coalesce((select jsonb_agg(jsonb_build_object(
          'seller_id', seller_id, 'seller_name', seller_name, 'revenue_cents', revenue_cents, 'sales_count', sales_count,
          'refunded_count', refunded_count, 'units', units,
          'average_ticket_cents', case when sales_count > 0 then floor(revenue_cents / sales_count)::bigint end)
        order by revenue_cents desc, seller_id) from sellers), '[]'::jsonb),
      'losses', coalesce((select jsonb_agg(jsonb_build_object(
          'product_id', product_id, 'product_name', product_name, 'reason', reason, 'location_id', location_id,
          'location_name', location_name, 'units', units, 'cost_cents', cost_cents, 'unknown_cost_units', unknown_units)
        order by cost_cents desc nulls last, units desc) from (
          select product_id, product_name, reason, location_id, location_name, sum(quantity) as units,
            sum(cost_cents) as cost_cents, sum(unknown_units) as unknown_units
          from losses group by product_id, product_name, reason, location_id, location_name) grouped), '[]'::jsonb),
      'daily', coalesce((select jsonb_agg(jsonb_build_object(
          'day', day, 'revenue_cents', revenue_cents, 'net_revenue_cents', revenue_cents + deductions_cents,
          'cogs_cents', cogs_cents, 'gross_margin_cents', revenue_cents + deductions_cents - cogs_cents) order by day) from daily), '[]'::jsonb),
      'pending', jsonb_build_object(
        'awaiting_payment', (select count(*) from public.sales where status = 'AWAITING_PAYMENT'),
        'divergent_reconciliations', (select count(*) from public.payment_reconciliations where outcome = 'DIVERGENT'),
        'reopened_closeouts', (select count(*) from public.seller_closeouts where status = 'REOPENED'),
        'open_payment_recoveries', (select count(*) from public.payment_recovery_items where status = 'OPEN'),
        'statement_lines_pending', (select count(*) from public.picpay_statement_lines line
          left join private.picpay_statement_current_resolutions current on current.line_id = line.id
          join private.picpay_line_cohorts attribution on attribution.line_id = line.id
          where (current.resolution is null or current.resolution = 'REABERTA') and private.picpay_counts(attribution.cohort_id)))
    )
  );
end;
$function$;

-- 3. Indicators: official result with the historical adjustments; presentation; COGS visibility ---------------------------
-- (The previous computation, unchanged, is now private.compute_management_indicators_registered: what the books record.)

create or replace function private.compute_management_indicators(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_registered jsonb := private.compute_management_indicators_registered(p_from, p_to);
  v_totals jsonb := v_registered -> 'totals';
  v_start timestamptz := p_from::timestamp at time zone 'America/Sao_Paulo';
  v_end timestamptz := (p_to + 1)::timestamp at time zone 'America/Sao_Paulo';
  v_adjustments jsonb;
  v_effect bigint;
  v_revenue_c bigint; v_refund_c bigint; v_fee_c bigint; v_cogs_c bigint; v_loss_c bigint; v_expense_c bigint;
  v_pairs bigint;
  v_outside integer;
  v_invalid integer;
  v_revenue_presented bigint; v_deductions bigint; v_expenses_registered bigint; v_expenses_presented bigint; v_cogs bigint; v_losses bigint;
  v_visibility jsonb;
begin
  -- Historical adjustments with competence in the window (the view reads the cohort's own rows).
  select coalesce(jsonb_object_agg(component, jsonb_build_object('result_effect_cents', result_effect, 'component_effect_cents', component_effect)), '{}'::jsonb),
    coalesce(sum(result_effect), 0),
    coalesce(sum(component_effect) filter (where component = 'RECEITA'), 0), coalesce(sum(component_effect) filter (where component = 'REEMBOLSO'), 0),
    coalesce(sum(component_effect) filter (where component = 'TAXA'), 0), coalesce(sum(component_effect) filter (where component = 'CMV'), 0),
    coalesce(sum(component_effect) filter (where component = 'PERDA'), 0), coalesce(sum(component_effect) filter (where component = 'DESPESA_OPERACIONAL'), 0)
  into v_adjustments, v_effect, v_revenue_c, v_refund_c, v_fee_c, v_cogs_c, v_loss_c, v_expense_c
  from (select effect.component::text as component, sum(effect.result_effect_cents)::bigint as result_effect, sum(effect.component_effect_cents)::bigint as component_effect
    from private.finance_adjustment_effects effect where effect.competence_on between p_from and p_to group by effect.component) grouped;

  -- Counterparts reclassified only when both sides fall in the window (otherwise the original entries stay as they are).
  select coalesce(sum(designation.neutralized_cents) filter (where designation.counterpart_on between p_from and p_to and designation.target_on between p_from and p_to), 0),
    count(*) filter (where (designation.counterpart_on between p_from and p_to) <> (designation.target_on between p_from and p_to)),
    0
  into v_pairs, v_outside, v_invalid
  from private.finance_counterpart_designations designation
  where designation.applies and designation.cohort_id = any (private.cohort_scope());
  select count(*) into v_invalid from private.finance_counterpart_designations designation
  where designation.active and not designation.applies and designation.cohort_id = any (private.cohort_scope())
    and (designation.counterpart_on between p_from and p_to or designation.target_on between p_from and p_to);

  v_revenue_presented := (v_totals ->> 'gross_revenue_cents')::bigint + v_revenue_c - v_pairs;
  v_deductions := (v_totals ->> 'refunds_cents')::bigint + (v_totals ->> 'fees_cents')::bigint - (v_totals ->> 'divergences_cents')::bigint
    + v_refund_c + v_fee_c;
  v_expenses_registered := (v_totals ->> 'operating_expenses_cents')::bigint + v_expense_c;
  v_expenses_presented := v_expenses_registered - v_pairs;
  v_cogs := (v_totals ->> 'cogs_cents')::bigint + v_cogs_c;
  v_losses := (v_totals ->> 'losses_cost_cents')::bigint + v_loss_c;

  -- Cost of goods sold, by what is known about it. An unknown cost is never zero; an estimate never enters the result.
  with sold as (
    select movement.source_id, item.product_id, lot.origin_type, allocation.allocated_cost_cents,
      case when movement.movement_type = 'VENDA' then 1 else -1 end * allocation.quantity as units
    from public.stock_movements movement
    join public.stock_movement_items item on item.movement_id = movement.id
    join public.stock_movement_lot_allocations allocation on allocation.movement_item_id = item.id
    join public.inventory_lots lot on lot.id = allocation.lot_id
    where movement.created_at >= v_start and movement.created_at < v_end
      and ((movement.movement_type = 'VENDA' and movement.source_type = 'sale')
        or (movement.movement_type = 'CANCELAMENTO_VENDA' and movement.source_type = 'sale_reversal'))
  ),
  purchase_cost as (
    select lot.product_id, sum(lot.total_cost_cents)::numeric / sum(lot.received_quantity) as unit_cost
    from public.inventory_lots lot
    where lot.origin_type = 'PURCHASE_RECEIPT' and lot.total_cost_cents is not null and lot.received_quantity > 0
    group by lot.product_id
  ),
  unknown as (
    select sold.product_id, sum(sold.units) as units from sold where sold.allocated_cost_cents is null group by sold.product_id
  )
  select jsonb_build_object(
    'units_known_positive', coalesce((select sum(units) from sold where allocated_cost_cents > 0), 0),
    'units_known_zero', coalesce((select sum(units) from sold where allocated_cost_cents = 0), 0),
    'units_unknown', coalesce((select sum(units) from unknown), 0),
    'sales_with_unknown_cost', (select count(distinct source_id) from sold where allocated_cost_cents is null and units > 0),
    'unknown_by_origin', coalesce((select jsonb_object_agg(origin, units) from (
      select coalesce(origin_type, 'DESCONHECIDA') as origin, sum(units) as units from sold where allocated_cost_cents is null group by 1) grouped), '{}'::jsonb),
    'units_estimable', coalesce((select sum(unknown.units) from unknown join purchase_cost on purchase_cost.product_id = unknown.product_id), 0),
    'units_not_estimable', coalesce((select sum(unknown.units) from unknown where not exists (select 1 from purchase_cost where purchase_cost.product_id = unknown.product_id)), 0),
    'estimated_unknown_cost_cents', coalesce((select round(sum(unknown.units * purchase_cost.unit_cost))::bigint from unknown
      join purchase_cost on purchase_cost.product_id = unknown.product_id), 0),
    'loss_units_unknown', (v_totals ->> 'losses_unknown_units')::bigint,
    'status', case
      when coalesce((select sum(units) from unknown), 0) = 0 and (v_totals ->> 'losses_unknown_units')::bigint = 0 then 'COMPLETO'
      when (v_totals ->> 'losses_unknown_units')::bigint = 0
        and not exists (select 1 from unknown where not exists (select 1 from purchase_cost where purchase_cost.product_id = unknown.product_id)) then 'ESTIMADO'
      else 'INCOMPLETO' end)
  into v_visibility;

  return jsonb_set(v_registered, '{totals}', v_totals || jsonb_build_object(
      'registered_operating_profit_cents', (v_totals ->> 'operating_profit_cents')::bigint,
      'historical_adjustments_cents', v_effect,
      'operating_profit_cents', (v_totals ->> 'operating_profit_cents')::bigint + v_effect))
    || jsonb_build_object(
      'historical_adjustments', v_adjustments,
      'presentation', jsonb_build_object(
        'operating_revenue_presented_cents', v_revenue_presented,
        'technical_cutover_counterparts_cents', v_pairs,
        'deductions_cents', v_deductions,
        'operating_expenses_registered_cents', v_expenses_registered,
        'counterparts_cents', v_pairs,
        'operating_expenses_presented_cents', v_expenses_presented,
        'cogs_cents', v_cogs,
        'losses_cents', v_losses,
        'operating_result_cents', v_revenue_presented - v_deductions - v_cogs - v_losses - v_expenses_presented,
        'counterparts_outside_window', v_outside,
        'invalid_designations', v_invalid),
      'cost_visibility', v_visibility);
end;
$$;
revoke all on function private.compute_management_indicators(date, date), private.compute_management_indicators_registered(date, date)
  from public, anon, authenticated, service_role;

-- 4. Fundraising goal: net available resources -----------------------------------------------------------------------
-- Real resources (PicPay free balance + Cofrinho + physical cash) − open payables. Receivables are future value, shown
-- apart. The opening position already is inside the balances (the only base). counting_from now drives the projection
-- (the growth of real resources since then) and the "resultado operacional desde X" indicator, never the progress.

create or replace function private.fundraising_goal_progress(p_full boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_goal public.fundraising_goal%rowtype;
  v_today date := (clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_opening record;
  v_free bigint; v_vault bigint; v_cash bigint; v_receivables bigint; v_clearing bigint;
  v_accumulated bigint;
  v_committed bigint;
  v_current bigint;
  v_until date;
  v_base_on date;
  v_base bigint;
  v_elapsed integer;
  v_remaining integer;
  v_projected bigint;
  v_result_since bigint;
  v_show boolean;
begin
  select * into v_goal from public.fundraising_goal where singleton;
  if not found then return null; end if;
  select * into v_opening from private.current_finance_opening_position();
  select coalesce(max(balance_cents) filter (where account = 'PICPAY_EMPRESAS'), 0), coalesce(max(balance_cents) filter (where account = 'COFRINHO_PICPAY'), 0),
    coalesce(max(balance_cents) filter (where account = 'DINHEIRO_FISICO'), 0), coalesce(max(balance_cents) filter (where account = 'RECEBIVEIS_PICPAY'), 0),
    coalesce(max(balance_cents) filter (where account = 'PENDENTE_LIQUIDACAO'), 0)
  into v_free, v_vault, v_cash, v_receivables, v_clearing
  from private.finance_account_balances(v_today);
  v_accumulated := v_free + v_vault + v_cash;
  select coalesce(sum(outstanding_cents), 0) into v_committed from public.purchase_payable_balances where outstanding_cents > 0;
  v_current := v_accumulated - v_committed;

  -- Projection: the pace at which real resources grew since counting_from (or since the opening, if later), carried to
  -- the target date; what is committed today stays committed.
  v_until := least(v_today, v_goal.target_date);
  v_base_on := greatest(v_goal.counting_from - 1, coalesce(v_opening.as_of, v_goal.counting_from - 1));
  v_elapsed := greatest(v_until - v_base_on, 0);
  v_remaining := greatest(v_goal.target_date - v_until, 0);
  select coalesce(sum(balance_cents) filter (where account in ('PICPAY_EMPRESAS', 'COFRINHO_PICPAY', 'DINHEIRO_FISICO')), 0)
  into v_base from private.finance_account_balances(v_base_on);
  v_projected := case when v_elapsed > 0 then v_current + floor((v_accumulated - v_base)::numeric / v_elapsed * v_remaining)::bigint else v_current end;
  if p_full and v_until >= v_goal.counting_from then
    v_result_since := (private.compute_management_indicators(v_goal.counting_from, v_until) #>> '{totals,operating_profit_cents}')::bigint;
  end if;
  v_show := p_full or v_goal.show_amounts;
  return jsonb_build_object(
    'basis', 'NET_AVAILABLE',
    'counting_from', v_goal.counting_from, 'target_date', v_goal.target_date,
    'public_visible', v_goal.public_visible, 'show_amounts', v_goal.show_amounts,
    'target_cents', case when v_show then v_goal.target_cents end,
    'current_cents', case when v_show then v_current end,
    'projected_cents', case when v_show then v_projected end,
    'accumulated_cents', case when v_show then v_accumulated end,
    'committed_cents', case when v_show then v_committed end,
    'receivables_cents', case when v_show then v_receivables + v_clearing end,
    'accounts', case when v_show then jsonb_build_object('free_cents', v_free, 'vault_cents', v_vault, 'cash_cents', v_cash) end,
    'operating_result_since_cents', case when p_full then v_result_since end,
    'progress_bps', greatest(floor(v_current::numeric * 10000 / v_goal.target_cents), 0)::bigint,
    'projected_bps', greatest(floor(v_projected::numeric * 10000 / v_goal.target_cents), 0)::bigint,
    'on_track', v_projected >= v_goal.target_cents,
    'days_remaining', greatest(v_goal.target_date - v_today, 0),
    'updated_at', case when p_full then v_goal.updated_at end);
end;
$$;
revoke all on function private.fundraising_goal_progress(boolean) from public, anon, authenticated, service_role;

-- 5. Result → cash bridge and the financial overview -------------------------------------------------------------------

-- Part A (since the current opening): the real position (free + Cofrinho + physical cash) explained from the official
-- result, line by line over the same statement rows. Every line comes from the books (CONFIRMADA); the residual is
-- checked, never plugged.
-- Part B (before the current opening): the assets the opening declares, explained from the result of the period before
-- it, the base of the version it supersedes (if any) and the cutover difference per account (amount confirmed; its cause
-- is NÃO DETERMINÁVEL until someone classifies it). Designated counterparts of the period are listed by name.
create function private.finance_result_cash_bridge()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_opening record;
  v_root record;
  v_goal_from date := (select counting_from from public.fundraising_goal where singleton);
  v_a_from date;
  v_a jsonb;
  v_b jsonb;
  v_b_from date;
  v_b_to date;
  v_totals jsonb;
  v_row record;
begin
  select * into v_opening from private.current_finance_opening_position();
  v_a_from := coalesce(v_opening.as_of, date '2020-01-01');

  -- Part A.
  v_totals := private.compute_management_indicators(v_a_from, v_today) -> 'totals';
  with rows as (select * from private.finance_statement_rows(v_a_from, v_today)),
  real as (select unnest(array['PICPAY_EMPRESAS', 'COFRINHO_PICPAY', 'DINHEIRO_FISICO']::public.finance_account[]) as account),
  figures as (
    select
      (v_totals ->> 'operating_profit_cents')::bigint as profit,
      (v_totals ->> 'cogs_cents')::bigint as cogs,
      (v_totals ->> 'losses_cost_cents')::bigint as losses,
      (v_totals ->> 'historical_adjustments_cents')::bigint as adjustments,
      coalesce((select sum(amount_cents) from rows where category is not null and source <> 'PAYABLE' and account not in (select account from real)), 0)::bigint as outside_cash,
      coalesce((select sum(amount_cents) from rows where source = 'PAYABLE' and account in (select account from real)), 0)::bigint as suppliers,
      coalesce((select sum(amount_cents) from rows where category is null and source not in ('OPENING', 'IMPORT_PENDING') and account in (select account from real)), 0)::bigint as transfers,
      coalesce((select sum(amount_cents) from rows where source = 'IMPORT_PENDING' and account in (select account from real)), 0)::bigint as pending,
      coalesce((select sum(amount_cents) from rows where source = 'OPENING' and account in (select account from real)), 0)::bigint as opening,
      coalesce((select sum(balance_cents) from private.finance_account_balances(v_today) where account in (select account from real)), 0)::bigint as position
  )
  select jsonb_build_object(
    'from', v_a_from, 'to', v_today,
    'lines', jsonb_build_array(
      jsonb_build_object('key', 'operating_result', 'label', 'Resultado operacional oficial', 'cents', profit, 'status', 'CONFIRMADA'),
      jsonb_build_object('key', 'historical_adjustments', 'label', '− Ajustes históricos sem caixa (efeito no resultado)', 'cents', -adjustments, 'status', 'CONFIRMADA'),
      jsonb_build_object('key', 'cogs', 'label', '+ CMV registrado (custo, não é saída de caixa)', 'cents', cogs, 'status', 'CONFIRMADA'),
      jsonb_build_object('key', 'losses', 'label', '+ Custo das perdas (não é saída de caixa)', 'cents', losses, 'status', 'CONFIRMADA'),
      jsonb_build_object('key', 'outside_cash', 'label', '− Resultado ainda fora do caixa (recebíveis, Pix em trânsito)', 'cents', -outside_cash, 'status', 'CONFIRMADA'),
      jsonb_build_object('key', 'suppliers', 'label', '+ Pagamentos a fornecedores (caixa, fora do resultado)', 'cents', suppliers, 'status', 'CONFIRMADA'),
      jsonb_build_object('key', 'transfers', 'label', '+ Transferências de/para contas reais (liquidações etc.)', 'cents', transfers, 'status', 'CONFIRMADA'),
      jsonb_build_object('key', 'pending', 'label', '+ Extrato aguardando classificação', 'cents', pending, 'status', 'CONFIRMADA'),
      jsonb_build_object('key', 'opening', 'label', '+ Posição de abertura', 'cents', opening, 'status', 'CONFIRMADA')),
    'calculated_cents', profit - adjustments + cogs + losses - outside_cash + suppliers + transfers + pending + opening,
    'position_cents', position,
    'residual_cents', position - (profit - adjustments + cogs + losses - outside_cash + suppliers + transfers + pending + opening))
  into v_a from figures;

  -- Part B: from the root of the opening's version chain (or the goal start) to the day before the current opening.
  if v_opening.id is not null then
    with recursive chain as (
      select position.* from public.finance_opening_positions position where position.id = v_opening.supersedes_id
      union all
      select previous.* from public.finance_opening_positions previous join chain on chain.supersedes_id = previous.id
    )
    select * into v_root from chain where chain.as_of < v_opening.as_of order by chain.as_of, chain.version limit 1;
    v_b_from := coalesce(v_root.as_of, case when v_goal_from < v_opening.as_of then v_goal_from end);
    v_b_to := v_opening.as_of - 1;
  end if;
  if v_b_from is not null and v_b_from <= v_b_to then
    v_totals := private.compute_management_indicators(v_b_from, v_b_to) -> 'totals';
    with rows as (select * from private.finance_statement_rows(v_b_from, v_b_to) where source <> 'OPENING'),
    accounts as (select unnest(enum_range(null::public.finance_account)) as account),
    per_account as (
      select accounts.account,
        coalesce((select sum(line.amount_cents) from public.finance_opening_position_lines line where line.position_id = v_root.id and line.account = accounts.account), 0)::bigint as base,
        coalesce((select sum(rows.amount_cents) from rows where rows.account = accounts.account), 0)::bigint as movements,
        coalesce((select sum(line.amount_cents) from public.finance_opening_position_lines line where line.position_id = v_opening.id and line.account = accounts.account), 0)::bigint as declared
      from accounts
    )
    select jsonb_build_object(
      'from', v_b_from, 'to', v_b_to,
      'base_version', v_root.version, 'declared_version', v_opening.version,
      'lines', jsonb_build_array(
        jsonb_build_object('key', 'operating_result', 'label', 'Resultado operacional oficial do período', 'cents', (v_totals ->> 'operating_profit_cents')::bigint, 'status', 'CONFIRMADA'),
        jsonb_build_object('key', 'historical_adjustments', 'label', '− Ajustes históricos sem caixa', 'cents', -(v_totals ->> 'historical_adjustments_cents')::bigint, 'status', 'CONFIRMADA'),
        jsonb_build_object('key', 'cogs', 'label', '+ CMV registrado', 'cents', (v_totals ->> 'cogs_cents')::bigint, 'status', 'CONFIRMADA'),
        jsonb_build_object('key', 'losses', 'label', '+ Custo das perdas', 'cents', (v_totals ->> 'losses_cost_cents')::bigint, 'status', 'CONFIRMADA'),
        jsonb_build_object('key', 'suppliers', 'label', '+ Pagamentos a fornecedores', 'cents', coalesce((select sum(amount_cents) from rows where source = 'PAYABLE'), 0), 'status', 'CONFIRMADA'),
        jsonb_build_object('key', 'pending', 'label', '+ Extrato aguardando classificação', 'cents', coalesce((select sum(amount_cents) from rows where source = 'IMPORT_PENDING'), 0), 'status', 'CONFIRMADA'),
        jsonb_build_object('key', 'transfers', 'label', '+ Transferências (somam zero entre contas)', 'cents', coalesce((select sum(amount_cents) from rows where category is null and source <> 'IMPORT_PENDING'), 0), 'status', 'CONFIRMADA'),
        jsonb_build_object('key', 'base', 'label', '+ Base da versão anterior da abertura', 'cents', (select sum(base) from per_account), 'status', 'CONFIRMADA'),
        jsonb_build_object('key', 'cutover_difference', 'label', '+ Diferença de cutover (declarado − reconstruído)', 'cents',
          (select sum(declared - base - movements) from per_account), 'status', 'CONFIRMADA', 'nature', 'NAO_DETERMINAVEL')),
      'declared_cents', (select sum(declared) from per_account),
      'reconstructed_cents', (select sum(base + movements) from per_account),
      'accounts', (select jsonb_agg(jsonb_build_object('account', account, 'base_cents', base, 'movements_cents', movements,
          'reconstructed_cents', base + movements, 'declared_cents', declared, 'difference_cents', declared - base - movements) order by account)
        from per_account where base <> 0 or movements <> 0 or declared <> 0),
      'counterparts', coalesce((select jsonb_agg(jsonb_build_object('id', designation.id, 'counterpart_reference', designation.counterpart_reference,
          'counterpart_cents', designation.counterpart_cents, 'target_reference', designation.target_reference, 'target_cents', designation.target_cents,
          'neutralized_cents', designation.neutralized_cents, 'reason', designation.reason) order by designation.counterpart_on)
        from private.finance_counterpart_designations designation
        where designation.applies and designation.cohort_id = any (private.cohort_scope())
          and designation.counterpart_on between v_b_from and v_b_to), '[]'::jsonb))
    into v_b;
  end if;
  return jsonb_build_object('part_a', v_a, 'part_b', v_b);
end;
$$;
revoke all on function private.finance_result_cash_bridge() from public, anon, authenticated, service_role;

-- The financial overview: position, receivables, payables, result (official, presentation, COGS visibility, historical ×
-- native), counterparts in the window, goal and bridge. Each figure keeps its meaning; nothing is netted silently.
create function public.finance_overview(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_as_of date;
  v_since date;
  v_indicators jsonb;
  v_historical jsonb;
  v_native jsonb;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE_OVERVIEW_PERIOD';
  end if;
  v_as_of := least(p_to, v_today);
  v_since := (select operating_since from private.current_finance_opening_position());
  -- The position, the goal and the result → cash bridge all start at the opening position: without one there is no
  -- overview to show (a known state of the domain, not an unavailable service).
  if v_since is null then
    raise exception using errcode = 'P0001', message = 'OPENING_POSITION_REQUIRED';
  end if;
  v_indicators := private.compute_management_indicators(p_from, p_to);
  -- Result by origin: before native operation (reconstructed history) and from it on.
  if v_since is not null and v_since > p_from and v_since <= p_to then
    v_historical := private.compute_management_indicators(p_from, v_since - 1) -> 'totals';
    v_native := private.compute_management_indicators(v_since, p_to) -> 'totals';
  elsif v_since is not null and v_since <= p_from then
    v_native := v_indicators -> 'totals';
  else
    v_historical := v_indicators -> 'totals';
  end if;
  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'as_of', v_as_of, 'operating_since', v_since),
    'position', (select jsonb_build_object(
        'free_cents', coalesce(max(balance_cents) filter (where account = 'PICPAY_EMPRESAS'), 0),
        'vault_cents', coalesce(max(balance_cents) filter (where account = 'COFRINHO_PICPAY'), 0),
        'cash_cents', coalesce(max(balance_cents) filter (where account = 'DINHEIRO_FISICO'), 0),
        'receivables_cents', coalesce(max(balance_cents) filter (where account = 'RECEBIVEIS_PICPAY'), 0),
        'pix_in_transit_cents', coalesce(max(balance_cents) filter (where account = 'PENDENTE_LIQUIDACAO'), 0))
      from private.finance_account_balances(v_as_of)),
    'payables', jsonb_build_object(
      'open_cents', coalesce((select sum(outstanding_cents) from public.purchase_payable_balances where outstanding_cents > 0), 0),
      'open_count', (select count(*) from public.purchase_payable_balances where outstanding_cents > 0)),
    'result', jsonb_build_object(
      'totals', v_indicators -> 'totals',
      'presentation', v_indicators -> 'presentation',
      'historical_adjustments', v_indicators -> 'historical_adjustments',
      'cost_visibility', v_indicators -> 'cost_visibility',
      'historical_cents', (v_historical ->> 'operating_profit_cents')::bigint,
      'native_cents', (v_native ->> 'operating_profit_cents')::bigint),
    'counterparts', coalesce((select jsonb_agg(private.finance_counterpart_json(designation.id)
        || jsonb_build_object('in_window', designation.counterpart_on between p_from and p_to and designation.target_on between p_from and p_to,
          'counterpart_in_window', designation.counterpart_on between p_from and p_to, 'target_in_window', designation.target_on between p_from and p_to)
        order by designation.counterpart_on, designation.id)
      from private.finance_counterpart_designations designation
      where designation.active and designation.cohort_id = any (private.cohort_scope())
        and (designation.counterpart_on between p_from and p_to or designation.target_on between p_from and p_to)), '[]'::jsonb),
    'goal', private.fundraising_goal_progress(true),
    'bridge', private.finance_result_cash_bridge());
end;
$$;

-- Grants -----------------------------------------------------------------------------------------------------------------

revoke all on function public.record_finance_historical_adjustment(public.finance_result_component, public.finance_adjustment_direction, bigint, date,
  public.finance_category, text, text, public.finance_adjustment_provenance, uuid[], text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reverse_finance_historical_adjustment(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_finance_historical_adjustments() from public, anon, authenticated, service_role;
revoke all on function public.designate_cutover_counterpart(uuid, uuid, uuid, bigint, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.revoke_cutover_counterpart(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_cutover_counterparts() from public, anon, authenticated, service_role;
revoke all on function public.finance_overview(date, date) from public, anon, authenticated, service_role;
grant execute on function public.record_finance_historical_adjustment(public.finance_result_component, public.finance_adjustment_direction, bigint, date,
  public.finance_category, text, text, public.finance_adjustment_provenance, uuid[], text, uuid) to authenticated;
grant execute on function public.reverse_finance_historical_adjustment(uuid, text, text, uuid) to authenticated;
grant execute on function public.list_finance_historical_adjustments() to authenticated;
grant execute on function public.designate_cutover_counterpart(uuid, uuid, uuid, bigint, text, text, uuid) to authenticated;
grant execute on function public.revoke_cutover_counterpart(uuid, text, text, uuid) to authenticated;
grant execute on function public.list_cutover_counterparts() to authenticated;
grant execute on function public.finance_overview(date, date) to authenticated;
