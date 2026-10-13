-- ADR 0011 (PicPay evidence is global; attribution and books are per cohort), E0 — PicPay cohort attribution foundation.
--
-- Found on develop: a statement resolution written after the cohort migrations carries no cohort (the guard only fills it
-- from a cohort parent), and the books (finance_statement_rows, the acquirer effects, the statement flows) read every
-- line and every Minhas vendas transaction, so cohort B inherited the PicPay balance and revenue of cohort A.
--
-- This migration delivers attribution + isolation only (the AP ↔ PicPay reconciliation stays for F):
-- 1. Attribution is structural and explicit:
--    - ADMIN_MASTER declares each imported file "integralmente da Turma X" (the eligible evidence is attributed to X) or
--      MISTO/GLOBAL (it stays unassigned); the declaration is the origin, never the description, actor or default cohort;
--    - a person who classifies, links or reopens a line inside a concrete cohort attributes it to that cohort;
--    - a resolution or link tied to a cohort record (sale, payment attempt, payable settlement, manual entry) inherits it;
--    - automatic decisions never invent a cohort: without a record or a declaration the evidence stays global;
--    - ADMIN_MASTER attributes unassigned evidence later, by item or in bulk (audited, idempotent, preview-confirmed);
--    - an attribution never moves to another cohort (refused), and the pre-cohort history keeps reading as Turma 2026.
-- 2. Isolation, activated once (private.picpay_attribution_settings.enforced), so a deploy never makes numbers vanish:
--    schema first, then the global evidence is identified and attributed with approval, then ADMIN_MASTER activates
--    isolation (reason, audit, idempotent). It never goes back through the Portal or any RPC: a trigger refuses it, and
--    an extreme rollback belongs to a technical migration. While it is active, unassigned evidence counts in no cohort's
--    balance, result, historical revenue or indicators and is listed only to ADMIN_MASTER; a cohort ADMIN never sees
--    another cohort's evidence. Before activation every read behaves exactly as before.
--    A MISTO/GLOBAL file takes no cohort from the screen: its lines are not matched to the request cohort's sales at
--    import, and the engine never links an unassigned transaction to a payment (it waits for an explicit attribution).
-- Writes are the same with the switch on or off: imports need ADMIN_MASTER and a declaration; manual decisions record
-- their cohort. No evidence is attributed by this migration.

set local lock_timeout = '5s';

-- 1. The switch ----------------------------------------------------------------------------------------------------

create table private.picpay_attribution_settings (
  id boolean primary key default true constraint picpay_attribution_settings_singleton check (id),
  enforced boolean not null default false,
  updated_by uuid references public.profiles (id) on delete restrict,
  updated_at timestamptz,
  reason text
);
insert into private.picpay_attribution_settings (id) values (true);
revoke all on private.picpay_attribution_settings from public, anon, authenticated, service_role;
comment on table private.picpay_attribution_settings is
  'Isolamento da evidência PicPay por turma, ativado uma única vez: antes = leitura como antes; ativo = evidência sem turma não conta em turma nenhuma.';

-- Once active, isolation never goes back (nor is the row removed): only a technical rollback migration could drop this.
create function private.guard_picpay_attribution_settings() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or (old.enforced and not new.enforced) then
    raise exception using errcode = 'P0001', message = 'PICPAY_ISOLATION_IRREVERSIBLE';
  end if;
  return new;
end;
$$;
create trigger picpay_attribution_settings_one_way before update or delete on private.picpay_attribution_settings
for each row execute function private.guard_picpay_attribution_settings();
revoke all on function private.guard_picpay_attribution_settings() from public, anon, authenticated, service_role;

create function private.picpay_attribution_enforced() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enforced from private.picpay_attribution_settings), false)
$$;

-- 2. Import declarations (global evidence metadata, one per imported file, immutable) -------------------------------

create type public.picpay_import_scope as enum ('COHORT', 'GLOBAL');

create table public.picpay_import_declarations (
  id uuid primary key default gen_random_uuid(),
  statement_import_id uuid unique references public.picpay_statement_imports (id) on delete restrict,
  source_import_id uuid unique references public.picpay_source_imports (id) on delete restrict,
  scope public.picpay_import_scope not null,
  declared_cohort_id uuid references public.cohorts (id) on delete restrict,
  actor_id uuid not null references public.profiles (id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint picpay_import_declarations_one_import check (num_nonnulls(statement_import_id, source_import_id) = 1),
  constraint picpay_import_declarations_scope_valid check ((scope = 'COHORT') = (declared_cohort_id is not null))
);
comment on table public.picpay_import_declarations is
  'Declaração humana (ADMIN_MASTER) de cada arquivo PicPay importado: integralmente de uma turma ou misto/global. Imutável.';
create trigger picpay_import_declarations_immutable before update or delete on public.picpay_import_declarations
for each row execute function private.prevent_immutable_record_change();
alter table public.picpay_import_declarations enable row level security;
revoke all on public.picpay_import_declarations from public, anon, authenticated, service_role;

-- 3. Attributions (one per evidence item, never moved) ---------------------------------------------------------------

create type public.picpay_attribution_origin as enum ('IMPORT_DECLARATION', 'ASSIGNMENT');

create table public.picpay_evidence_attributions (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references public.cohorts (id) on delete restrict,
  statement_line_id uuid references public.picpay_statement_lines (id) on delete restrict,
  transaction_id uuid references public.picpay_transactions (id) on delete restrict,
  origin public.picpay_attribution_origin not null,
  declaration_id uuid references public.picpay_import_declarations (id) on delete restrict,
  batch_id uuid,
  reason text,
  actor_id uuid not null references public.profiles (id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint picpay_evidence_attributions_line_unique unique (statement_line_id),
  constraint picpay_evidence_attributions_transaction_unique unique (transaction_id),
  constraint picpay_evidence_attributions_one_item check (num_nonnulls(statement_line_id, transaction_id) = 1),
  constraint picpay_evidence_attributions_origin_valid check (
    (origin = 'IMPORT_DECLARATION' and declaration_id is not null and batch_id is null and reason is null)
    or (origin = 'ASSIGNMENT' and declaration_id is null and batch_id is not null
      and reason is not null and char_length(reason) between 8 and 300 and reason = btrim(reason))
  )
);
comment on table public.picpay_evidence_attributions is
  'Atribuição explícita de uma evidência PicPay global (linha do Extrato ou transação de Minhas vendas) a uma turma: '
  'pela declaração do arquivo ou por atribuição do ADMIN_MASTER. Imutável; nunca muda de turma.';
create index picpay_evidence_attributions_batch_idx on public.picpay_evidence_attributions (batch_id) where batch_id is not null;
create trigger picpay_evidence_attributions_immutable before update or delete on public.picpay_evidence_attributions
for each row execute function private.prevent_immutable_record_change();
revoke all on public.picpay_evidence_attributions from public, anon, authenticated, service_role;
select private.register_cohort_table('picpay_evidence_attributions', 'picpay_attribution', 'REQUIRED');

insert into private.cohort_entity_types (entity_type, table_name) values
  ('picpay_evidence_attribution', 'picpay_evidence_attributions'), ('picpay_attribution_settings', null)
on conflict (entity_type) do nothing;

-- 4. The cohort each piece of evidence counts in --------------------------------------------------------------------

-- Statement line: the explicit attribution, else the latest resolution that carries a cohort (the pre-cohort history
-- reads as Turma 2026; a resolution tied to a cohort record or decided by a person inside a cohort carries it).
create view private.picpay_line_cohorts as
  select line.id as line_id, coalesce(attribution.cohort_id, resolved.cohort_id) as cohort_id,
    case when attribution.id is not null then attribution.origin::text when resolved.cohort_id is not null then 'RESOLUTION' end as origin
  from public.picpay_statement_lines line
  left join cohort_data.picpay_evidence_attributions attribution on attribution.statement_line_id = line.id
  left join lateral (
    select resolution.cohort_id from cohort_data.picpay_statement_line_resolutions resolution
    where resolution.line_id = line.id and resolution.cohort_id is not null
    order by resolution.sequence desc limit 1
  ) resolved on true;
revoke all on private.picpay_line_cohorts from public, anon, authenticated, service_role;

-- Minhas vendas transaction: the explicit attribution, else the cohort of the payment attempt it is linked to now.
create view private.picpay_transaction_cohorts as
  select tx.id as transaction_id, coalesce(attribution.cohort_id, case when latest.action = 'LINK' then latest.cohort_id end) as cohort_id,
    case when attribution.id is not null then attribution.origin::text when latest.action = 'LINK' and latest.cohort_id is not null then 'LINK' end as origin
  from public.picpay_transactions tx
  left join cohort_data.picpay_evidence_attributions attribution on attribution.transaction_id = tx.id
  left join lateral (
    select link.action, link.cohort_id from cohort_data.picpay_transaction_links link
    where link.transaction_id = tx.id order by link.sequence desc limit 1
  ) latest on true;
revoke all on private.picpay_transaction_cohorts from public, anon, authenticated, service_role;

-- Books: with the switch on, evidence counts only in its own cohort (unassigned evidence counts nowhere).
create function private.picpay_counts(p_cohort uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not private.picpay_attribution_enforced() or coalesce(p_cohort = any (private.cohort_scope()), false)
$$;
-- Lists: ADMIN_MASTER also sees the unassigned evidence; nobody sees another cohort's.
create function private.picpay_visible(p_cohort uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not private.picpay_attribution_enforced() or coalesce(p_cohort = any (private.cohort_scope()), false)
    or (p_cohort is null and private.is_admin_master())
$$;
-- Whole-file figures (all lines of a file, the account-level settlement days) belong to the global evidence.
create function private.picpay_sees_whole_files() returns boolean
language sql stable security definer set search_path = '' as $$
  select not private.picpay_attribution_enforced() or private.is_admin_master()
$$;
revoke all on function private.picpay_attribution_enforced(), private.picpay_counts(uuid), private.picpay_visible(uuid),
  private.picpay_sees_whole_files() from public, anon, authenticated, service_role;

-- 5. Guards ---------------------------------------------------------------------------------------------------------

-- Resolutions and links: inherit the cohort the evidence already has; a person deciding about an unassigned line inside
-- a cohort attributes it; nothing ever moves evidence to another cohort.
create or replace function private.guard_picpay_attribution()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_current uuid;
  v_person boolean := private.cohort_caller() in ('user', 'anon') and not new.automatic;
begin
  if tg_table_name = 'picpay_transaction_links' then
    select coalesce(
      (select attribution.cohort_id from cohort_data.picpay_evidence_attributions attribution where attribution.transaction_id = new.transaction_id),
      (select link.cohort_id from cohort_data.picpay_transaction_links link where link.transaction_id = new.transaction_id
        order by link.sequence desc limit 1))
    into v_current;
    if new.cohort_id is null then
      new.cohort_id := (select attribution.cohort_id from cohort_data.picpay_evidence_attributions attribution
        where attribution.transaction_id = new.transaction_id);
    end if;
  else
    select cohort_id into v_current from private.picpay_line_cohorts where line_id = new.line_id;
    if new.cohort_id is null then
      new.cohort_id := v_current;
    end if;
  end if;
  -- A person acts inside a concrete cohort: on that cohort's evidence, or (ADMIN_MASTER, or anyone while isolation is off)
  -- on unassigned evidence, which the decision then attributes to the cohort of the request.
  if v_person then
    if v_current is null then
      if private.picpay_attribution_enforced() and not private.is_admin_master() then
        raise exception using errcode = '42501', message = 'PICPAY_EVIDENCE_NOT_ATTRIBUTED';
      end if;
      if tg_table_name = 'picpay_statement_line_resolutions' and new.cohort_id is null then
        new.cohort_id := private.cohort_write_id();
      end if;
    elsif v_current <> private.cohort_write_id() then
      raise exception using errcode = '42501', message = 'PICPAY_EVIDENCE_ATTRIBUTED_TO_ANOTHER_COHORT';
    end if;
  end if;
  if v_current is not null and new.cohort_id is not null and v_current <> new.cohort_id then
    raise exception using errcode = '42501', message = 'PICPAY_EVIDENCE_ATTRIBUTED_TO_ANOTHER_COHORT';
  end if;
  return new;
end;
$$;

-- Attributions: an item already counted in a cohort (by a resolution or a link) is never attributed to another one.
create function private.guard_picpay_evidence_attribution()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_current uuid;
begin
  if new.statement_line_id is not null then
    select resolution.cohort_id into v_current from cohort_data.picpay_statement_line_resolutions resolution
    where resolution.line_id = new.statement_line_id and resolution.cohort_id is not null order by resolution.sequence desc limit 1;
  else
    select cohort_id into v_current from private.picpay_transaction_cohorts where transaction_id = new.transaction_id;
  end if;
  if v_current is not null and v_current <> new.cohort_id then
    raise exception using errcode = '42501', message = 'PICPAY_EVIDENCE_ATTRIBUTED_TO_ANOTHER_COHORT';
  end if;
  return new;
end;
$$;
create trigger b_picpay_evidence_attribution before insert on cohort_data.picpay_evidence_attributions
for each row execute function private.guard_picpay_evidence_attribution();
revoke all on function private.guard_picpay_attribution(), private.guard_picpay_evidence_attribution()
  from public, anon, authenticated, service_role;

-- 6. Attribution by declaration and by ADMIN_MASTER -----------------------------------------------------------------

-- The evidence a file carries: the statement lines it observed, or the Minhas vendas transactions it observed.
create function private.picpay_import_items(p_import_id uuid)
returns table (kind text, item_id uuid, occurred_on date, amount_cents bigint, cohort_id uuid)
language sql stable security definer set search_path = '' as $$
  select 'STATEMENT_LINE', line.id, line.occurred_on, line.amount_cents, attribution.cohort_id
  from public.picpay_statement_line_observations observation
  join public.picpay_statement_lines line on line.id = observation.line_id
  join private.picpay_line_cohorts attribution on attribution.line_id = line.id
  where observation.import_id = p_import_id
  union
  select 'TRANSACTION', tx.id, (state.sold_at at time zone 'America/Sao_Paulo')::date, state.gross_cents, attribution.cohort_id
  from public.picpay_transaction_observations observation
  join public.picpay_transactions tx on tx.id = observation.transaction_id
  join private.picpay_transaction_state state on state.transaction_id = tx.id
  join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.id
  where observation.import_id = p_import_id
$$;
revoke all on function private.picpay_import_items(uuid) from public, anon, authenticated, service_role;

-- A file declared as one cohort's: its unassigned evidence becomes that cohort's; evidence of another cohort refutes it.
create function private.apply_picpay_import_declaration(
  p_import_id uuid, p_source_type public.picpay_source_type, p_scope public.picpay_import_scope, p_cohort_id uuid,
  p_actor_id uuid, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_declaration_id uuid := gen_random_uuid();
  v_attributed integer := 0;
  v_conflicts integer;
begin
  insert into public.picpay_import_declarations (id, statement_import_id, source_import_id, scope, declared_cohort_id, actor_id, correlation_id)
  values (v_declaration_id, case when p_source_type = 'PICPAY_STATEMENT' then p_import_id end,
    case when p_source_type <> 'PICPAY_STATEMENT' then p_import_id end, p_scope, p_cohort_id, p_actor_id, p_correlation_id);
  if p_scope = 'COHORT' then
    select count(*) into v_conflicts from private.picpay_import_items(p_import_id) item
    where item.cohort_id is not null and item.cohort_id <> p_cohort_id;
    if v_conflicts > 0 then
      raise exception using errcode = 'P0001', message = 'PICPAY_DECLARATION_CONFLICT',
        detail = v_conflicts || ' item(s) of this file already count in another cohort';
    end if;
    insert into public.picpay_evidence_attributions (cohort_id, statement_line_id, transaction_id, origin, declaration_id, actor_id, correlation_id)
    select p_cohort_id, case when item.kind = 'STATEMENT_LINE' then item.item_id end, case when item.kind = 'TRANSACTION' then item.item_id end,
      'IMPORT_DECLARATION', v_declaration_id, p_actor_id, p_correlation_id
    from private.picpay_import_items(p_import_id) item
    where item.cohort_id is null;
    get diagnostics v_attributed = row_count;
  end if;
  return jsonb_build_object('declaration_id', v_declaration_id, 'scope', p_scope, 'cohort_id', p_cohort_id, 'attributed', v_attributed);
end;
$$;
revoke all on function private.apply_picpay_import_declaration(uuid, public.picpay_source_type, public.picpay_import_scope, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- What a bulk attribution would take: unassigned items of one file, or the listed items; items of another cohort refuse it.
create function private.picpay_assignment_selection(p_import_id uuid, p_statement_line_ids uuid[], p_transaction_ids uuid[])
returns table (kind text, item_id uuid, occurred_on date, amount_cents bigint, cohort_id uuid)
language sql stable security definer set search_path = '' as $$
  select item.* from private.picpay_import_items(p_import_id) item where p_import_id is not null
  union
  select 'STATEMENT_LINE', line.id, line.occurred_on, line.amount_cents, attribution.cohort_id
  from public.picpay_statement_lines line join private.picpay_line_cohorts attribution on attribution.line_id = line.id
  where p_import_id is null and line.id = any (coalesce(p_statement_line_ids, '{}'))
  union
  select 'TRANSACTION', tx.id, (state.sold_at at time zone 'America/Sao_Paulo')::date, state.gross_cents, attribution.cohort_id
  from public.picpay_transactions tx
  join private.picpay_transaction_state state on state.transaction_id = tx.id
  join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.id
  where p_import_id is null and tx.id = any (coalesce(p_transaction_ids, '{}'))
$$;
revoke all on function private.picpay_assignment_selection(uuid, uuid[], uuid[]) from public, anon, authenticated, service_role;

create function private.picpay_assignment_preview_json(p_import_id uuid, p_statement_line_ids uuid[], p_transaction_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_cohort uuid := private.cohort_write_id();
begin
  if (p_import_id is null) = (coalesce(cardinality(p_statement_line_ids), 0) + coalesce(cardinality(p_transaction_ids), 0) = 0)
    or coalesce(cardinality(p_statement_line_ids), 0) + coalesce(cardinality(p_transaction_ids), 0) > 2000 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_ASSIGNMENT';
  end if;
  if p_import_id is not null and not exists (select 1 from public.picpay_statement_imports where id = p_import_id)
    and not exists (select 1 from public.picpay_source_imports where id = p_import_id) then
    raise exception using errcode = 'P0001', message = 'PICPAY_IMPORT_NOT_FOUND';
  end if;
  if p_import_id is null and (select count(*) from private.picpay_assignment_selection(null, p_statement_line_ids, p_transaction_ids))
      <> (select count(distinct id) from unnest(coalesce(p_statement_line_ids, '{}') || coalesce(p_transaction_ids, '{}')) id) then
    raise exception using errcode = 'P0001', message = 'PICPAY_EVIDENCE_NOT_FOUND';
  end if;
  return (
    select jsonb_build_object(
      'cohort_id', v_cohort,
      'count', count(*) filter (where selection.cohort_id is null),
      'total_cents', coalesce(sum(selection.amount_cents) filter (where selection.cohort_id is null), 0),
      'statement_lines', count(*) filter (where selection.cohort_id is null and selection.kind = 'STATEMENT_LINE'),
      'transactions', count(*) filter (where selection.cohort_id is null and selection.kind = 'TRANSACTION'),
      'first_on', min(selection.occurred_on) filter (where selection.cohort_id is null),
      'last_on', max(selection.occurred_on) filter (where selection.cohort_id is null),
      'already_in_cohort', count(*) filter (where selection.cohort_id = v_cohort),
      'other_cohort', count(*) filter (where selection.cohort_id <> v_cohort))
    from private.picpay_assignment_selection(p_import_id, p_statement_line_ids, p_transaction_ids) selection);
end;
$$;
revoke all on function private.picpay_assignment_preview_json(uuid, uuid[], uuid[]) from public, anon, authenticated, service_role;

create function public.preview_picpay_assignment(p_import_id uuid, p_statement_line_ids uuid[], p_transaction_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  return private.picpay_assignment_preview_json(p_import_id, p_statement_line_ids, p_transaction_ids);
end;
$$;

-- ADMIN_MASTER attributes unassigned evidence to the cohort of the request, after confirming the preview.
create function public.assign_picpay_evidence(
  p_import_id uuid, p_statement_line_ids uuid[], p_transaction_ids uuid[], p_reason text, p_expected_count integer,
  p_expected_total_cents bigint, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_reason text := btrim(p_reason);
  v_cohort uuid;
  v_preview jsonb;
  v_batch_id uuid := gen_random_uuid();
  v_result jsonb;
begin
  if v_actor_id is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  v_cohort := private.cohort_write_id();
  if p_correlation_id is null or v_reason is null or char_length(v_reason) not between 8 and 300
    or p_expected_count is null or p_expected_count < 1 or p_expected_total_cents is null then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_ASSIGNMENT';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'assign_picpay_evidence', v_actor_id), p_idempotency_key,
    jsonb_build_object('cohort_id', v_cohort, 'import_id', p_import_id, 'statement_line_ids', p_statement_line_ids,
      'transaction_ids', p_transaction_ids, 'reason', v_reason, 'expected_count', p_expected_count,
      'expected_total_cents', p_expected_total_cents));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  -- Serialized with imports and the reconciliation engine, which also decide about this evidence.
  perform pg_advisory_xact_lock(hashtextextended('picpay-statement-import', 0));
  perform pg_advisory_xact_lock(hashtextextended('picpay-reconciliation', 0));
  v_preview := private.picpay_assignment_preview_json(p_import_id, p_statement_line_ids, p_transaction_ids);
  if (v_preview ->> 'other_cohort')::integer > 0 then
    raise exception using errcode = '42501', message = 'PICPAY_EVIDENCE_ATTRIBUTED_TO_ANOTHER_COHORT',
      detail = (v_preview ->> 'other_cohort') || ' item(s) already count in another cohort';
  end if;
  if (v_preview ->> 'count')::integer <> p_expected_count or (v_preview ->> 'total_cents')::bigint <> p_expected_total_cents then
    raise exception using errcode = 'P0001', message = 'PICPAY_ASSIGNMENT_CHANGED';
  end if;
  insert into public.picpay_evidence_attributions (cohort_id, statement_line_id, transaction_id, origin, batch_id, reason, actor_id, correlation_id)
  select v_cohort, case when selection.kind = 'STATEMENT_LINE' then selection.item_id end,
    case when selection.kind = 'TRANSACTION' then selection.item_id end, 'ASSIGNMENT', v_batch_id, v_reason, v_actor_id, p_correlation_id
  from private.picpay_assignment_selection(p_import_id, p_statement_line_ids, p_transaction_ids) selection
  where selection.cohort_id is null;

  v_result := v_preview || jsonb_build_object('batch_id', v_batch_id, 'import_id', p_import_id, 'reason', v_reason,
    'correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.picpay.evidence_assigned', v_actor_id, 'picpay_attribution_batch', v_batch_id::text, p_correlation_id, v_result);
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.picpay.evidence_assigned', 'picpay_attribution_batch', v_batch_id::text,
    jsonb_build_object('batch_id', v_batch_id, 'cohort_id', v_cohort, 'count', v_preview -> 'count', 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_attribution_batch', v_batch_id::text);
  return v_result;
end;
$$;

-- What the cutover needs to see: the switch, the unassigned evidence (what would leave the books) and each file's declaration.
create function public.picpay_attribution_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  return (
    with lines as (
      select line.id, line.import_id, line.occurred_on, line.amount_cents, attribution.cohort_id,
        current.resolution is null or current.resolution = 'REABERTA' as pending
      from public.picpay_statement_lines line
      join private.picpay_line_cohorts attribution on attribution.line_id = line.id
      left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    ),
    transactions as (
      select tx.transaction_id, tx.sold_on, tx.gross_cents, tx.historical, tx.payment_attempt_id, tx.status, attribution.cohort_id
      from private.picpay_transactions_view tx
      join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.transaction_id
    ),
    files as (
      select 'PICPAY_STATEMENT'::text as source_type, import.id, import.number, import.file_name, import.period_from, import.period_to, import.created_at
      from public.picpay_statement_imports import
      union all
      select import.source_type::text, import.id, import.number, import.file_name, import.period_from, import.period_to, import.created_at
      from public.picpay_source_imports import
    )
    select jsonb_build_object(
      'enforced', (select enforced from private.picpay_attribution_settings),
      'updated_at', (select updated_at from private.picpay_attribution_settings),
      'reason', (select reason from private.picpay_attribution_settings),
      'unassigned', jsonb_build_object(
        'statement_lines', (select count(*) from lines where cohort_id is null),
        'statement_net_cents', coalesce((select sum(amount_cents) from lines where cohort_id is null), 0),
        'statement_pending', (select count(*) from lines where cohort_id is null and pending),
        'transactions', (select count(*) from transactions where cohort_id is null),
        'transactions_gross_cents', coalesce((select sum(gross_cents) from transactions where cohort_id is null and status in ('APROVADA', 'DEVOLVIDA')), 0),
        'historical_transactions', (select count(*) from transactions where cohort_id is null and historical)),
      'by_cohort', coalesce((select jsonb_agg(jsonb_build_object('cohort_id', counted.cohort_id, 'name', cohort.name,
          'statement_lines', counted.lines, 'transactions', counted.transactions) order by cohort.name)
        from (
          select coalesce(l.cohort_id, t.cohort_id) as cohort_id, coalesce(l.lines, 0) as lines, coalesce(t.transactions, 0) as transactions
          from (select cohort_id, count(*) as lines from lines where cohort_id is not null group by cohort_id) l
          full join (select cohort_id, count(*) as transactions from transactions where cohort_id is not null group by cohort_id) t
            on t.cohort_id = l.cohort_id
        ) counted join public.cohorts cohort on cohort.id = counted.cohort_id), '[]'::jsonb),
      'files', coalesce((select jsonb_agg(jsonb_build_object(
          'id', files.id, 'source_type', files.source_type, 'number', files.number, 'file_name', files.file_name,
          'period_from', files.period_from, 'period_to', files.period_to, 'created_at', files.created_at,
          'scope', coalesce(declaration.scope::text, 'LEGADO'), 'declared_cohort_id', declaration.declared_cohort_id,
          'declared_cohort_name', declared.name,
          'unassigned', (select count(*) from private.picpay_import_items(files.id) item where item.cohort_id is null),
          'unassigned_cents', (select coalesce(sum(item.amount_cents), 0) from private.picpay_import_items(files.id) item where item.cohort_id is null))
        order by files.created_at desc)
        from files
        left join public.picpay_import_declarations declaration
          on declaration.statement_import_id = files.id or declaration.source_import_id = files.id
        left join public.cohorts declared on declared.id = declaration.declared_cohort_id), '[]'::jsonb))
  );
end;
$$;

-- Unassigned items of one file, for attribution item by item.
create function public.list_unassigned_picpay_evidence(p_import_id uuid, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  if p_import_id is null or p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', item.kind, 'id', item.item_id, 'occurred_on', item.occurred_on,
      'amount_cents', item.amount_cents,
      'label', case when item.kind = 'STATEMENT_LINE' then (select line.movement_label || ' · ' || coalesce(line.description, '')
          from public.picpay_statement_lines line where line.id = item.item_id)
        else (select tx.payment_label || ' · ' || tx.transaction_ref from private.picpay_transactions_view tx where tx.transaction_id = item.item_id) end)
    order by item.occurred_on, item.item_id)
    from (select * from private.picpay_import_items(p_import_id) where cohort_id is null order by occurred_on, item_id limit p_limit) item), '[]'::jsonb);
end;
$$;

-- Activation: ADMIN_MASTER activates isolation once, after the global evidence was attributed. Audited as a global
-- operation; activating again changes nothing; there is no deactivation.
create function public.activate_picpay_attribution_isolation(p_reason text, p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_reason text := btrim(p_reason);
  v_settings private.picpay_attribution_settings%rowtype;
  v_result jsonb;
begin
  if v_actor_id is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  if p_correlation_id is null or v_reason is null or char_length(v_reason) not between 8 and 300 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_ISOLATION';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'activate_picpay_attribution_isolation', v_actor_id), p_idempotency_key,
    jsonb_build_object('reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select * into v_settings from private.picpay_attribution_settings where id for update;
  if v_settings.enforced then
    v_result := jsonb_build_object('active', true, 'activated_now', false, 'activated_at', v_settings.updated_at,
      'reason', v_settings.reason, 'correlation_id', p_correlation_id);
  else
    update private.picpay_attribution_settings set enforced = true, updated_by = v_actor_id, updated_at = now(), reason = v_reason
    where id
    returning * into v_settings;
    v_result := jsonb_build_object('active', true, 'activated_now', true, 'activated_at', v_settings.updated_at,
      'reason', v_reason, 'correlation_id', p_correlation_id);
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('finance.picpay.isolation_activated', v_actor_id, 'picpay_attribution_settings', 'global', p_correlation_id,
      v_result || jsonb_build_object('cohort_scope', 'GLOBAL'));
  end if;
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_attribution_settings', 'global');
  return v_result;
end;
$$;

-- 7. Settlement days seen by the request: the account-level figures for whoever sees whole files, otherwise only the
--    transactions and lines that count in the cohort.
create function private.picpay_settlement_days_visible()
returns table (
  payment_on date, expected_net_cents bigint, expected_count integer, settled_cents bigint, settled_lines integer,
  receivable_snapshot_cents bigint, statement_covered boolean, status text
)
language sql stable security definer set search_path = '' as $$
  with expected as (
    select state.expected_payment_on as day, sum(state.net_cents)::bigint as net, count(*)::integer as transactions
    from private.picpay_transaction_state state
    join private.picpay_transaction_cohorts attribution on attribution.transaction_id = state.transaction_id
    where state.status = 'APROVADA' and state.payment_kind <> 'PIX' and state.expected_payment_on is not null
      and (private.picpay_sees_whole_files() or private.picpay_visible(attribution.cohort_id))
    group by state.expected_payment_on
  ),
  settled as (
    select line.occurred_on as day, sum(line.amount_cents)::bigint as amount, count(*)::integer as lines
    from public.picpay_statement_lines line join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where line.movement = 'RECEBIVEIS_VENDA' and (private.picpay_sees_whole_files() or private.picpay_visible(attribution.cohort_id))
    group by line.occurred_on
  ),
  snapshot as (
    select receivable.payment_on as day, sum(receivable.net_cents)::bigint as net
    from private.picpay_receivable_state receivable
    left join private.picpay_transaction_state state on state.transaction_ref = receivable.transaction_ref
    left join private.picpay_transaction_cohorts attribution on attribution.transaction_id = state.transaction_id
    where private.picpay_sees_whole_files() or private.picpay_visible(attribution.cohort_id)
    group by receivable.payment_on
  ),
  days as (select day from expected union select day from settled union select day from snapshot)
  select days.day, coalesce(expected.net, 0), coalesce(expected.transactions, 0), coalesce(settled.amount, 0), coalesce(settled.lines, 0),
    coalesce(snapshot.net, 0),
    exists (select 1 from public.picpay_statement_imports import where days.day between import.period_from and import.period_to),
    case
      when coalesce(settled.amount, 0) > coalesce(expected.net, 0) then 'EXCEDENTE'
      when coalesce(settled.amount, 0) = coalesce(expected.net, 0) then 'LIQUIDADO'
      when coalesce(settled.amount, 0) > 0 then 'PARCIAL'
      when exists (select 1 from public.picpay_statement_imports import where days.day between import.period_from and import.period_to)
        then 'EM_ATRASO'
      else 'A_RECEBER'
    end
  from days
  left join expected on expected.day = days.day
  left join settled on settled.day = days.day
  left join snapshot on snapshot.day = days.day
  order by days.day;
$$;
revoke all on function private.picpay_settlement_days_visible() from public, anon, authenticated, service_role;

-- 8. Existing functions, isolated ---------------------------------------------------------------------------

-- Books: statement lines and Minhas vendas count only in their cohort while isolation is on.
CREATE OR REPLACE FUNCTION private.finance_statement_rows(p_from date, p_to date)
 RETURNS TABLE(occurred_on date, source text, source_id uuid, category finance_category, account finance_account, amount_cents bigint, description text, reference text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where current.resolution in ('TRANSFERENCIA', 'CLASSIFICADA', 'CONCILIADA_PICPAY') and line.occurred_on between p_from and p_to
      and private.picpay_counts(attribution.cohort_id)
  ),
  -- Lines nobody decided yet (or reopened): the money already moved in the bank, the reason is still unknown.
  pending as (
    select line.id, line.occurred_on, line.movement_label, line.amount_cents, import.number, line.line_number
    from public.picpay_statement_lines line
    join public.picpay_statement_imports import on import.id = line.import_id
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where (current.id is null or current.resolution = 'REABERTA') and line.occurred_on between p_from and p_to
      and private.picpay_counts(attribution.cohort_id)
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
  -- Imported lines name the movement, never the counterparty. Historical revenue keeps its bank origin.
  select occurred_on, 'IMPORT', id, category, 'PICPAY_EMPRESAS', amount_cents,
    case
      when movement = 'COFRINHO_GUARDADO' then 'Dinheiro guardado no Cofrinho'
      when movement = 'COFRINHO_RESGATADO' then 'Dinheiro resgatado do Cofrinho'
      when resolution = 'CONCILIADA_PICPAY' and movement = 'PIX_RECEBIDO' then 'Pix recebido conciliado com Minhas vendas'
      when resolution = 'CONCILIADA_PICPAY' then 'Estorno de Pix conciliado com Minhas vendas'
      when movement = 'RECEBIVEIS_VENDA' and resolution = 'CLASSIFICADA' then 'Recebíveis de venda (histórico do cutover)'
      when movement = 'RECEBIVEIS_VENDA' then 'Recebíveis de venda liquidados'
      when category = 'RECEITA_HISTORICA' then 'Extrato PicPay: ' || movement_label || ' (histórico do cutover)'
      else 'Extrato PicPay: ' || movement_label
    end,
    'PICPAY-CSV-' || number || '-L' || line_number
  from imported
  union all
  select occurred_on, 'IMPORT', id, null, counter_account, -amount_cents,
    case movement
      when 'COFRINHO_GUARDADO' then 'Dinheiro guardado no Cofrinho'
      when 'COFRINHO_RESGATADO' then 'Dinheiro resgatado do Cofrinho'
      when 'PIX_RECEBIDO' then 'Pix recebido conciliado com Minhas vendas'
      when 'PIX_ESTORNADO' then 'Estorno de Pix conciliado com Minhas vendas'
      else 'Recebíveis de venda liquidados'
    end,
    'PICPAY-CSV-' || number || '-L' || line_number
  from imported where resolution in ('TRANSFERENCIA', 'CONCILIADA_PICPAY')
  union all
  -- Treasury before classification: the PicPay account moves now; revenue and expense wait for the classification.
  select occurred_on, 'IMPORT_PENDING', id, null, 'PICPAY_EMPRESAS', amount_cents,
    'Extrato PicPay: ' || movement_label || ' (a classificar)', 'PICPAY-CSV-' || number || '-L' || line_number
  from pending
  union all
  -- The opening position: money that already existed, never inflow or outflow.
  select position.as_of, 'OPENING', position.id, null, line.account, line.amount_cents, 'Saldo de abertura',
    'ABERTURA-V' || position.version
  from private.current_finance_opening_position() position
  join public.finance_opening_position_lines line on line.position_id = position.id
  where position.as_of between p_from and p_to and line.amount_cents <> 0
  union all
  -- Acquirer evidence (Minhas vendas): historical revenue, real PicPay fees and historical refunds.
  select effect.occurred_on, 'PICPAY', effect.source_id, effect.category, effect.account, effect.amount_cents, effect.description, effect.reference
  from private.picpay_acquirer_effects(p_from, p_to) effect
  join private.picpay_transaction_cohorts attribution on attribution.transaction_id = effect.source_id
  where private.picpay_counts(attribution.cohort_id);
$function$;

-- Classified lines enter the result of their cohort only.
CREATE OR REPLACE FUNCTION private.picpay_statement_flows(p_from date, p_to date)
 RETURNS TABLE(kind finance_manual_entry_kind, category finance_category, amount_cents bigint, day date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  join private.picpay_line_cohorts attribution on attribution.line_id = line.id
  where current.resolution = 'CLASSIFICADA' and line.occurred_on between p_from and p_to
    and private.picpay_counts(attribution.cohort_id);
$function$;

-- Indicators: pending statement lines of the cohort only (the rest comes from the books).
CREATE OR REPLACE FUNCTION private.compute_management_indicators(p_from date, p_to date)
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

-- Statement lines that move no account of the cohort's books (pending, already recorded, linked): the cohort's only.
CREATE OR REPLACE FUNCTION private.finance_statement_unapplied(p_as_of date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with bounds as (
    select coalesce((select as_of from private.current_finance_opening_position()), date '2020-01-01') as start_on
  ),
  lines as (
    select line.amount_cents,
      case
        when current.resolution is null or current.resolution = 'REABERTA' then 'pending'
        when current.resolution = 'JA_REGISTRADO' then 'already_recorded'
        when current.resolution = 'VINCULADA' then 'linked'
      end as kind
    from public.picpay_statement_lines line
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    cross join bounds
    where line.occurred_on between bounds.start_on and p_as_of and private.picpay_counts(attribution.cohort_id)
  )
  select jsonb_build_object(
    'pending', jsonb_build_object('count', count(*) filter (where kind = 'pending'),
      'net_cents', coalesce(sum(amount_cents) filter (where kind = 'pending'), 0)),
    'already_recorded', jsonb_build_object('count', count(*) filter (where kind = 'already_recorded'),
      'net_cents', coalesce(sum(amount_cents) filter (where kind = 'already_recorded'), 0)),
    'linked', jsonb_build_object('count', count(*) filter (where kind = 'linked'),
      'net_cents', coalesce(sum(amount_cents) filter (where kind = 'linked'), 0)))
  from lines;
$function$;

-- Opening position: only the cohort's own statement decisions can conflict with it.
CREATE OR REPLACE FUNCTION public.record_finance_opening_position(p_as_of date, p_operating_since date, p_free_cents bigint, p_vault_cents bigint, p_receivables_cents bigint, p_cash_cents bigint, p_description text, p_reason text, p_supersedes_id uuid, p_idempotency_key text, p_correlation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_current public.finance_opening_positions%rowtype;
  v_position_id uuid := gen_random_uuid();
  v_version integer;
  v_description text := btrim(p_description);
  v_reason text := nullif(btrim(p_reason), '');
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_as_of is null or p_operating_since is null or p_operating_since <= p_as_of
    or p_as_of > (now() at time zone 'America/Sao_Paulo')::date
    or v_description is null or char_length(v_description) not between 3 and 300
    or (v_reason is not null and char_length(v_reason) not between 8 and 300)
    or p_free_cents is null or p_vault_cents is null or p_receivables_cents is null or p_cash_cents is null
    or least(p_free_cents, p_vault_cents, p_receivables_cents, p_cash_cents) < 0
    or greatest(p_free_cents, p_vault_cents, p_receivables_cents, p_cash_cents) > 9007199254740991 then
    raise exception using errcode = '22023', message = 'INVALID_OPENING_POSITION';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'record_opening_position', v_actor_id), p_idempotency_key,
    jsonb_build_object('as_of', p_as_of, 'operating_since', p_operating_since, 'free_cents', p_free_cents,
      'vault_cents', p_vault_cents, 'receivables_cents', p_receivables_cents, 'cash_cents', p_cash_cents,
      'description', v_description, 'reason', v_reason, 'supersedes_id', p_supersedes_id));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  -- One writer at a time: the version chain and the statement checks below see a stable state.
  perform pg_advisory_xact_lock(hashtextextended('finance-opening-position', 0));
  perform pg_advisory_xact_lock(hashtextextended('picpay-statement-import', 0));
  select * into v_current from private.current_finance_opening_position();
  if v_current.id is null then
    if p_supersedes_id is not null or v_reason is not null then
      raise exception using errcode = '22023', message = 'INVALID_OPENING_POSITION';
    end if;
    v_version := 1;
  else
    if p_supersedes_id is null then
      raise exception using errcode = 'P0001', message = 'OPENING_POSITION_ALREADY_RECORDED';
    end if;
    if p_supersedes_id <> v_current.id then
      raise exception using errcode = 'P0001', message = 'OPENING_POSITION_STALE';
    end if;
    if v_reason is null then
      raise exception using errcode = '22023', message = 'INVALID_OPENING_POSITION';
    end if;
    v_version := v_current.version + 1;
  end if;

  if exists (
    select 1 from public.picpay_statement_lines line
    join private.picpay_statement_current_resolutions current on current.line_id = line.id
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where line.occurred_on < p_operating_since
      and current.resolution in ('CONCILIADA_VENDA', 'CONCILIADA_ESTORNO') and private.picpay_counts(attribution.cohort_id)
  ) or exists (
    select 1 from public.picpay_statement_lines line
    join private.picpay_statement_current_resolutions current on current.line_id = line.id
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where line.occurred_on >= p_operating_since and current.resolution = 'CLASSIFICADA' and current.category = 'RECEITA_HISTORICA'
      and private.picpay_counts(attribution.cohort_id)
  ) then
    raise exception using errcode = 'P0001', message = 'OPENING_POSITION_CONFLICTS_WITH_STATEMENT';
  end if;

  insert into public.finance_opening_positions (
    id, version, as_of, operating_since, description, reason, supersedes_id, actor_id, correlation_id
  ) values (
    v_position_id, v_version, p_as_of, p_operating_since, v_description, v_reason, p_supersedes_id, v_actor_id, p_correlation_id
  );
  insert into public.finance_opening_position_lines (position_id, account, amount_cents) values
    (v_position_id, 'PICPAY_EMPRESAS', p_free_cents),
    (v_position_id, 'COFRINHO_PICPAY', p_vault_cents),
    (v_position_id, 'RECEBIVEIS_PICPAY', p_receivables_cents),
    (v_position_id, 'DINHEIRO_FISICO', p_cash_cents);

  v_result := private.finance_opening_position_json(v_position_id) || jsonb_build_object('correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.opening_position.recorded', v_actor_id, 'finance_opening_position', v_position_id::text, p_correlation_id,
    jsonb_build_object('version', v_version, 'as_of', p_as_of, 'operating_since', p_operating_since,
      'supersedes_id', p_supersedes_id, 'accounts', v_result -> 'accounts'));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.opening_position.recorded', 'finance_opening_position', v_position_id::text,
    jsonb_build_object('position_id', v_position_id, 'version', v_version, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'finance_opening_position', v_position_id::text);
  return v_result;
end;
$function$;

-- Engine: pairs a transaction with a payment of its own cohort and historical Pix lines with transactions of the same cohort.
CREATE OR REPLACE FUNCTION private.run_picpay_reconciliation(p_actor_id uuid, p_correlation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_links integer := 0;
  v_pix integer := 0;
  v_refunds integer := 0;
  v_settlements integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('picpay-reconciliation', 0));

  -- 1. Native transactions ↔ PDV payments: a reference typed by the seller (NSU or authorization) first, then amount,
  --    method and time (30 minutes); only a candidate unique in both directions is linked automatically.
  with position as (select operating_since from private.current_finance_opening_position()),
  open_transactions as (
    select tx.*, attribution.cohort_id as attributed_cohort_id from private.picpay_transactions_view tx
    join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.transaction_id
    where tx.status in ('APROVADA', 'DEVOLVIDA') and tx.payment_attempt_id is null and not tx.historical
  ),
  open_attempts as (
    select attempt.* from public.payment_attempts attempt
    where attempt.status in ('APPROVED', 'RECONCILED', 'RECONCILIATION_PENDING')
      and attempt.integration_channel in ('PIX_AREA', 'MAQUININHA', 'TAP')
      and (not exists (select 1 from position) or (coalesce(attempt.confirmed_at, attempt.created_at) at time zone 'America/Sao_Paulo')::date
        >= (select operating_since from position))
      and not exists (select 1 from private.picpay_current_links link where link.payment_attempt_id = attempt.id)
  ),
  pairs as (
    select tx.transaction_id, attempt.id as attempt_id,
      attempt.proof_reference is not null and attempt.proof_reference in (tx.nsu, tx.authorization_code) as strong
    from open_transactions tx
    join open_attempts attempt on attempt.amount_cents = tx.gross_cents
      and tx.attributed_cohort_id = attempt.cohort_id
      and private.picpay_kind_fits_attempt(tx.payment_kind, attempt.integration_channel, attempt.card_method)
      and ((attempt.proof_reference is not null and attempt.proof_reference in (tx.nsu, tx.authorization_code))
        or abs(extract(epoch from coalesce(attempt.confirmed_at, attempt.created_at) - tx.sold_at)) <= 1800)
  ),
  preferred as (
    select pair.* from pairs pair
    where pair.strong or not exists (select 1 from pairs other where other.transaction_id = pair.transaction_id and other.strong)
  ),
  unique_pairs as (
    select pair.* from preferred pair
    where (select count(*) from preferred other where other.transaction_id = pair.transaction_id) = 1
      and (select count(*) from preferred other where other.attempt_id = pair.attempt_id) = 1
  ),
  inserted as (
    insert into public.picpay_transaction_links (transaction_id, payment_attempt_id, action, automatic, evidence, actor_id, correlation_id)
    select transaction_id, attempt_id, 'LINK', true, case when strong then 'REFERENCIA' else 'VALOR_HORARIO_METODO' end, p_actor_id, p_correlation_id
    from unique_pairs
    returning 1
  )
  select count(*) into v_links from inserted;

  -- 2. Historical "Pix recebido": as many pending lines of a day and amount as historical Pix transactions of that day and
  --    amount still unexplained. The set is reconciled; no arbitrary pair is claimed.
  with acquirer as (
    select tx.sold_on as day, tx.gross_cents as amount, attribution.cohort_id, count(*) as transactions
    from private.picpay_transactions_view tx
    join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.transaction_id
    where tx.historical and tx.payment_attempt_id is null and tx.payment_kind = 'PIX' and tx.status in ('APROVADA', 'DEVOLVIDA')
    group by tx.sold_on, tx.gross_cents, attribution.cohort_id
  ),
  explained as (
    select line.occurred_on as day, line.amount_cents as amount, attribution.cohort_id, count(*) as lines
    from public.picpay_statement_lines line
    join private.picpay_statement_current_resolutions current on current.line_id = line.id
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where line.movement = 'PIX_RECEBIDO' and current.resolution = 'CONCILIADA_PICPAY'
    group by line.occurred_on, line.amount_cents, attribution.cohort_id
  ),
  pending as (
    select line.id, line.occurred_on, line.amount_cents, attribution.cohort_id,
      row_number() over (partition by line.occurred_on, line.amount_cents, attribution.cohort_id order by import.number, line.line_number) as position
    from public.picpay_statement_lines line
    join public.picpay_statement_imports import on import.id = line.import_id
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where line.movement = 'PIX_RECEBIDO' and private.is_statement_cutover_day(line.occurred_on)
      and (current.id is null or current.resolution = 'REABERTA')
  ),
  inserted as (
    insert into public.picpay_statement_line_resolutions (line_id, resolution, counter_account, automatic, actor_id, correlation_id)
    select pending.id, 'CONCILIADA_PICPAY', 'PENDENTE_LIQUIDACAO', true, p_actor_id, p_correlation_id
    from pending
    join acquirer on acquirer.day = pending.occurred_on and acquirer.amount = pending.amount_cents
      and acquirer.cohort_id is not distinct from pending.cohort_id
    left join explained on explained.day = pending.occurred_on and explained.amount = pending.amount_cents
      and explained.cohort_id is not distinct from pending.cohort_id
    where pending.position <= acquirer.transactions - coalesce(explained.lines, 0)
    returning 1
  )
  select count(*) into v_pix from inserted;

  -- 3. Historical "Pix estornado": as many pending refund lines of an amount as refunded (Devolvida) historical Pix of
  --    that amount still unexplained, never before the sale day.
  with acquirer as (
    select tx.gross_cents as amount, attribution.cohort_id, count(*) as transactions, min(tx.sold_on) as first_day
    from private.picpay_transactions_view tx
    join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.transaction_id
    where tx.historical and tx.payment_attempt_id is null and tx.payment_kind = 'PIX' and tx.status = 'DEVOLVIDA'
    group by tx.gross_cents, attribution.cohort_id
  ),
  explained as (
    select -line.amount_cents as amount, attribution.cohort_id, count(*) as lines
    from public.picpay_statement_lines line
    join private.picpay_statement_current_resolutions current on current.line_id = line.id
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where line.movement = 'PIX_ESTORNADO' and current.resolution = 'CONCILIADA_PICPAY'
    group by line.amount_cents, attribution.cohort_id
  ),
  pending as (
    select line.id, line.occurred_on, -line.amount_cents as amount, attribution.cohort_id,
      row_number() over (partition by line.amount_cents, attribution.cohort_id order by line.occurred_on, import.number, line.line_number) as position
    from public.picpay_statement_lines line
    join public.picpay_statement_imports import on import.id = line.import_id
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where line.movement = 'PIX_ESTORNADO' and line.amount_cents < 0 and private.is_statement_cutover_day(line.occurred_on)
      and (current.id is null or current.resolution = 'REABERTA')
  ),
  inserted as (
    insert into public.picpay_statement_line_resolutions (line_id, resolution, counter_account, automatic, actor_id, correlation_id)
    select pending.id, 'CONCILIADA_PICPAY', 'PENDENTE_LIQUIDACAO', true, p_actor_id, p_correlation_id
    from pending
    join acquirer on acquirer.amount = pending.amount and pending.occurred_on >= acquirer.first_day
      and acquirer.cohort_id is not distinct from pending.cohort_id
    left join explained on explained.amount = pending.amount and explained.cohort_id is not distinct from pending.cohort_id
    where pending.position <= acquirer.transactions - coalesce(explained.lines, 0)
    returning 1
  )
  select count(*) into v_refunds from inserted;

  -- 4. Historical "Recebíveis de venda": settled as a transfer out of Recebíveis PicPay only when the day's settlements
  --    do not exceed what Minhas vendas expected to be paid that day.
  with days as (select * from private.picpay_settlement_days() where settled_cents <= expected_net_cents),
  inserted as (
    insert into public.picpay_statement_line_resolutions (line_id, resolution, counter_account, automatic, actor_id, correlation_id)
    select line.id, 'TRANSFERENCIA', 'RECEBIVEIS_PICPAY', true, p_actor_id, p_correlation_id
    from public.picpay_statement_lines line
    join days on days.payment_on = line.occurred_on
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where line.movement = 'RECEBIVEIS_VENDA' and (current.id is null or current.resolution = 'REABERTA')
    returning 1
  )
  select count(*) into v_settlements from inserted;

  return jsonb_build_object('links', v_links, 'pix', v_pix, 'refunds', v_refunds, 'settlements', v_settlements);
end;
$function$;

-- Exceptions: only about evidence the request may see; account-level ones (settlement days, duplicates) per visibility.
CREATE OR REPLACE FUNCTION private.picpay_exception_rows()
 RETURNS TABLE(exception_key text, type text, occurred_on date, amount_cents bigint, subject_type text, subject_id uuid, details jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with position as (select operating_since from private.current_finance_opening_position()),
  sales_coverage as (select period_from, period_to from public.picpay_source_imports where source_type = 'PICPAY_SALES'),
  native_attempts as (
    select attempt.*, (coalesce(attempt.confirmed_at, attempt.created_at) at time zone 'America/Sao_Paulo')::date as paid_on
    from public.payment_attempts attempt
    where attempt.status in ('APPROVED', 'RECONCILED', 'RECONCILIATION_PENDING') and attempt.integration_channel in ('PIX_AREA', 'MAQUININHA', 'TAP')
      and (not exists (select 1 from position) or (coalesce(attempt.confirmed_at, attempt.created_at) at time zone 'America/Sao_Paulo')::date
        >= (select operating_since from position))
  ),
  linked as (
    select tx.*, attempt.amount_cents as attempt_amount, attempt.integration_channel, attempt.card_method, attempt.sale_id
    from private.picpay_transactions_view tx join public.payment_attempts attempt on attempt.id = tx.payment_attempt_id
  )
  select 'PDV_SEM_PICPAY:' || attempt.id, 'PDV_SEM_PICPAY', attempt.paid_on, attempt.amount_cents, 'payment_attempt', attempt.id,
    jsonb_build_object('channel', attempt.integration_channel, 'sale_id', attempt.sale_id)
  from native_attempts attempt
  where exists (select 1 from sales_coverage where attempt.paid_on between sales_coverage.period_from and sales_coverage.period_to)
    and not exists (select 1 from private.picpay_current_links link where link.payment_attempt_id = attempt.id)
  union all
  select 'PICPAY_SEM_PDV:' || tx.transaction_id, 'PICPAY_SEM_PDV', tx.sold_on, tx.gross_cents, 'picpay_transaction', tx.transaction_id,
    jsonb_build_object('transaction_ref', tx.transaction_ref, 'method', tx.payment_label, 'terminal', tx.terminal_number, 'status', tx.status)
  from private.picpay_transactions_view tx
  join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.transaction_id
  where tx.status in ('APROVADA', 'DEVOLVIDA') and not tx.historical and tx.payment_attempt_id is null
    and private.picpay_visible(attribution.cohort_id)
  union all
  select 'VALOR_DIVERGENTE:' || linked.transaction_id, 'VALOR_DIVERGENTE', linked.sold_on, linked.gross_cents - linked.attempt_amount,
    'picpay_transaction', linked.transaction_id,
    jsonb_build_object('transaction_ref', linked.transaction_ref, 'picpay_cents', linked.gross_cents, 'pdv_cents', linked.attempt_amount)
  from linked where linked.gross_cents <> linked.attempt_amount
  union all
  select 'METODO_DIVERGENTE:' || linked.transaction_id, 'METODO_DIVERGENTE', linked.sold_on, linked.gross_cents, 'picpay_transaction',
    linked.transaction_id, jsonb_build_object('transaction_ref', linked.transaction_ref, 'picpay_method', linked.payment_label,
      'pdv_channel', linked.integration_channel, 'pdv_card_method', linked.card_method)
  from linked where not private.picpay_kind_fits_attempt(linked.payment_kind, linked.integration_channel, linked.card_method)
  union all
  select 'TRANSACAO_DEVOLVIDA:' || linked.transaction_id, 'TRANSACAO_DEVOLVIDA', linked.sold_on, linked.gross_cents, 'picpay_transaction',
    linked.transaction_id, jsonb_build_object('transaction_ref', linked.transaction_ref, 'sale_id', linked.sale_id)
  from linked where linked.status = 'DEVOLVIDA'
    and not exists (select 1 from public.financial_ledger_entries refund where refund.sale_id = linked.sale_id and refund.entry_type = 'REFUND')
  union all
  select 'STATUS_DIVERGENTE:' || tx.transaction_id, 'STATUS_DIVERGENTE', tx.sold_on, tx.gross_cents, 'picpay_transaction', tx.transaction_id,
    jsonb_build_object('transaction_ref', tx.transaction_ref, 'status_conflict', tx.status_conflict, 'amount_conflict', tx.amount_conflict)
  from private.picpay_transactions_view tx
  join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.transaction_id
  where (tx.status_conflict or tx.amount_conflict) and private.picpay_visible(attribution.cohort_id)
  union all
  select 'LIQUIDACAO_SEM_EXPLICACAO:' || day.payment_on, 'LIQUIDACAO_SEM_EXPLICACAO', day.payment_on, day.settled_cents - day.expected_net_cents,
    'settlement_day', null::uuid, jsonb_build_object('expected_cents', day.expected_net_cents, 'settled_cents', day.settled_cents)
  from private.picpay_settlement_days_visible() day where day.status = 'EXCEDENTE'
  union all
  select 'RECEBIVEL_EM_ATRASO:' || day.payment_on, 'RECEBIVEL_EM_ATRASO', day.payment_on, day.expected_net_cents - day.settled_cents,
    'settlement_day', null::uuid, jsonb_build_object('expected_cents', day.expected_net_cents, 'settled_cents', day.settled_cents)
  from private.picpay_settlement_days_visible() day where day.status in ('EM_ATRASO', 'PARCIAL')
  union all
  select 'RECEBIVEL_INCONSISTENTE:' || receivable.installment_id, 'RECEBIVEL_INCONSISTENTE', receivable.payment_on, receivable.net_cents,
    'picpay_receivable', receivable.installment_id,
    jsonb_build_object('transaction_ref', receivable.transaction_ref, 'installment', receivable.installment_number,
      'transaction_status', tx.status, 'transaction_net_cents', tx.net_cents)
  from private.picpay_receivable_state receivable
  left join private.picpay_transaction_state tx on tx.transaction_ref = receivable.transaction_ref
  left join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.transaction_id
  where tx.transaction_id is not null and private.picpay_visible(attribution.cohort_id) and (tx.status <> 'APROVADA'
    or (receivable.installments_total = 1 and receivable.net_cents <> tx.net_cents))
  union all
  select 'DUPLICIDADE:' || conflict.id, 'DUPLICIDADE', conflict.occurred_on, conflict.amount_cents, 'statement_conflict', conflict.id,
    jsonb_build_object('movement', conflict.movement, 'known_count', conflict.known_count, 'observed_count', conflict.observed_count,
      'import_number', import.number)
  from public.picpay_statement_duplicate_conflicts conflict join public.picpay_statement_imports import on import.id = conflict.import_id
  where private.picpay_sees_whole_files()
  union all
  select 'EXTRATO_NAO_CLASSIFICADO:' || line.id, 'EXTRATO_NAO_CLASSIFICADO', line.occurred_on, line.amount_cents, 'statement_line', line.id,
    jsonb_build_object('movement', line.movement, 'movement_label', line.movement_label, 'line_number', line.line_number, 'import_number', import.number)
  from public.picpay_statement_lines line
  join public.picpay_statement_imports import on import.id = line.import_id
  left join private.picpay_statement_current_resolutions current on current.line_id = line.id
  join private.picpay_line_cohorts attribution on attribution.line_id = line.id
  where (current.id is null or current.resolution = 'REABERTA') and private.picpay_visible(attribution.cohort_id)
  union all
  -- A line classified by hand as historical revenue while Minhas vendas already carries that revenue: counted twice.
  select 'RECEITA_DUPLICADA:' || line.id, 'RECEITA_DUPLICADA', line.occurred_on, line.amount_cents, 'statement_line', line.id,
    jsonb_build_object('movement', line.movement, 'line_number', line.line_number)
  from public.picpay_statement_lines line
  join private.picpay_statement_current_resolutions current on current.line_id = line.id
  join private.picpay_line_cohorts attribution on attribution.line_id = line.id
  where current.resolution = 'CLASSIFICADA' and current.category = 'RECEITA_HISTORICA' and private.picpay_visible(attribution.cohort_id)
    and ((line.movement = 'PIX_RECEBIDO' and exists (select 1 from private.picpay_transactions_view tx where tx.historical
        and tx.payment_kind = 'PIX' and tx.sold_on = line.occurred_on and tx.gross_cents = line.amount_cents))
      or (line.movement = 'RECEBIVEIS_VENDA' and exists (select 1 from private.picpay_transactions_view tx where tx.historical
        and tx.payment_kind <> 'PIX' and tx.expected_payment_on = line.occurred_on)))
  union all
  -- A card sale settled by the manual reconciliation route would also be settled by the Extrato: never twice.
  select 'LIQUIDACAO_DUPLICADA:' || attempt.id, 'LIQUIDACAO_DUPLICADA', (settlement.created_at at time zone 'America/Sao_Paulo')::date,
    settlement.amount_cents, 'payment_attempt', attempt.id, jsonb_build_object('sale_id', attempt.sale_id)
  from public.payment_attempts attempt
  join public.financial_ledger_entries settlement on settlement.payment_attempt_id = attempt.id and settlement.entry_type = 'SETTLEMENT'
  where attempt.integration_channel in ('MAQUININHA', 'TAP')
  union all
  select 'SALDO_DIVERGENTE:' || checked.id, 'SALDO_DIVERGENTE', checked.as_of, checked.total_difference_cents, 'balance_check', checked.id,
    jsonb_build_object('free_difference_cents', checked.free_difference_cents, 'vault_difference_cents', checked.vault_difference_cents)
  from (select * from public.finance_balance_checks order by number desc limit 1) checked
  where checked.status = 'DIVERGENTE';
$function$;

-- Reconciliation summary: transactions, lines and receivables the request may see.
CREATE OR REPLACE FUNCTION private.picpay_reconciliation_summary_json(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with position as (select as_of, operating_since from private.current_finance_opening_position()),
  pdv as (
    select attempt.id from public.payment_attempts attempt
    where attempt.status in ('APPROVED', 'RECONCILED', 'RECONCILIATION_PENDING') and attempt.integration_channel in ('PIX_AREA', 'MAQUININHA', 'TAP')
      and (coalesce(attempt.confirmed_at, attempt.created_at) at time zone 'America/Sao_Paulo')::date between p_from and p_to
  ),
  tx as (
    select tx.* from private.picpay_transactions_view tx
    join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.transaction_id
    where tx.sold_on between p_from and p_to and private.picpay_visible(attribution.cohort_id)
  ),
  open_exceptions as (select * from private.picpay_exceptions() where not resolved),
  exceptions as (select * from open_exceptions where occurred_on between p_from and p_to),
  pending_lines as (
    select line.occurred_on, line.amount_cents from public.picpay_statement_lines line
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where (current.id is null or current.resolution = 'REABERTA') and private.picpay_visible(attribution.cohort_id)
  ),
  latest_check as (select as_of, status, total_difference_cents from public.finance_balance_checks order by number desc limit 1),
  lines as (
    select line.*, current.resolution from public.picpay_statement_lines line
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where line.occurred_on between p_from and p_to and private.picpay_visible(attribution.cohort_id)
  ),
  settlement as (select * from private.picpay_settlement_days_visible())
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'operating_since', (select operating_since from position),
    'opening_as_of', (select as_of from position),
    'imported_from', least((select min(occurred_on) from public.picpay_statement_lines), (select min(sold_on) from private.picpay_transactions_view)),
    'imported_to', greatest((select max(occurred_on) from public.picpay_statement_lines), (select max(sold_on) from private.picpay_transactions_view)),
    'pdv_sales', (select count(*) from pdv),
    'picpay', jsonb_build_object(
      'transactions', (select count(*) from tx),
      'approved', (select count(*) from tx where status = 'APROVADA'),
      'denied', (select count(*) from tx where status = 'NEGADA'),
      'refunded', (select count(*) from tx where status = 'DEVOLVIDA'),
      'historical', (select count(*) from tx where historical),
      'linked', (select count(*) from tx where payment_attempt_id is not null),
      'gross_cents', coalesce((select sum(gross_cents) from tx where status in ('APROVADA', 'DEVOLVIDA')), 0),
      'fee_cents', coalesce((select sum(total_fee_cents) from tx where status in ('APROVADA', 'DEVOLVIDA')), 0),
      'net_cents', coalesce((select sum(net_cents) from tx where status in ('APROVADA', 'DEVOLVIDA')), 0)),
    'exceptions', jsonb_build_object(
      'total', (select count(*) from exceptions),
      'by_type', coalesce((select jsonb_object_agg(type, total) from (select type, count(*) as total from exceptions group by type) grouped), '{}'::jsonb),
      'total_all', (select count(*) from open_exceptions),
      'outside_period', (select count(*) from open_exceptions where occurred_on not between p_from and p_to),
      'first_open_on', (select min(occurred_on) from open_exceptions),
      'last_open_on', (select max(occurred_on) from open_exceptions)),
    'receivables', jsonb_build_object(
      'pending_cents', coalesce((select sum(expected_net_cents - settled_cents) from settlement where status in ('A_RECEBER', 'EM_ATRASO', 'PARCIAL')), 0),
      'overdue_cents', coalesce((select sum(expected_net_cents - settled_cents) from settlement where status in ('EM_ATRASO', 'PARCIAL')), 0),
      'snapshot_cents', coalesce((select sum(receivable_snapshot_cents) from settlement), 0),
      'settled_cents', coalesce((select sum(settled_cents) from settlement where payment_on between p_from and p_to), 0)),
    'statement', jsonb_build_object(
      'lines', (select count(*) from lines),
      'inflow_cents', coalesce((select sum(amount_cents) from lines where amount_cents > 0
        and movement not in ('COFRINHO_RESGATADO')), 0),
      'outflow_cents', coalesce((select -sum(amount_cents) from lines where amount_cents < 0 and movement not in ('COFRINHO_GUARDADO')), 0),
      'internal_transfer_cents', coalesce((select sum(abs(amount_cents)) from lines where movement in ('COFRINHO_GUARDADO', 'COFRINHO_RESGATADO')), 0),
      'pending_lines', (select count(*) from lines where resolution is null or resolution = 'REABERTA'),
      'pending_lines_total', (select count(*) from pending_lines),
      'pending_net_cents_total', coalesce((select sum(amount_cents) from pending_lines), 0),
      'pending_outside_period', (select count(*) from pending_lines where occurred_on not between p_from and p_to)),
    'balance_check', (select jsonb_build_object('as_of', as_of, 'status', status, 'total_difference_cents', total_difference_cents) from latest_check),
    'balances', (select jsonb_build_object('as_of', balances.as_of, 'free_balance_cents', balances.free, 'vault_balance_cents', balances.vault,
        'available_balance_cents', balances.free + balances.vault, 'receivables_balance_cents', balances.receivables,
        'pix_clearing_cents', balances.clearing, 'cash_balance_cents', balances.cash)
      from (select least(p_to, (now() at time zone 'America/Sao_Paulo')::date) as as_of,
          max(balance_cents) filter (where account = 'PICPAY_EMPRESAS') as free, max(balance_cents) filter (where account = 'COFRINHO_PICPAY') as vault,
          max(balance_cents) filter (where account = 'RECEBIVEIS_PICPAY') as receivables,
          max(balance_cents) filter (where account = 'PENDENTE_LIQUIDACAO') as clearing, max(balance_cents) filter (where account = 'DINHEIRO_FISICO') as cash
        from private.finance_account_balances(least(p_to, (now() at time zone 'America/Sao_Paulo')::date))) balances),
    'status', case when (select count(*) from exceptions) = 0
        and (select count(*) from lines where resolution is null or resolution = 'REABERTA') = 0 then 'CONCILIADO' else 'COM_PENDENCIAS' end);
$function$;

-- Statement imports: a cohort ADMIN sees the files that carry lines of the cohort.
CREATE OR REPLACE FUNCTION public.list_picpay_statement_imports(p_before_number bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    select id, number from public.picpay_statement_imports import
    where (p_before_number is null or number < p_before_number)
      and (private.picpay_sees_whole_files() or exists (select 1 from public.picpay_statement_lines line
        join private.picpay_line_cohorts attribution on attribution.line_id = line.id
        where line.import_id = import.id and private.picpay_visible(attribution.cohort_id)))
    order by number desc limit p_limit + 1
  ) page;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.picpay_statement_import_json(id) order by ordinality)
      from unnest(v_ids) with ordinality id where ordinality <= p_limit), '[]'::jsonb),
    'next_before', case when coalesce(array_length(v_ids, 1), 0) > p_limit
      then (select number from public.picpay_statement_imports where id = v_ids[p_limit]) end,
    'pending_total', (select count(*) from public.picpay_statement_lines line
      left join private.picpay_statement_current_resolutions current on current.line_id = line.id
      join private.picpay_line_cohorts attribution on attribution.line_id = line.id
      where (current.resolution is null or current.resolution = 'REABERTA') and private.picpay_visible(attribution.cohort_id)));
end;
$function$;

-- One statement import: whole-file figures for whoever sees whole files, otherwise the cohort's lines only.
CREATE OR REPLACE FUNCTION private.picpay_statement_import_json(p_import_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'id', import.id, 'number', import.number, 'account', import.account, 'file_name', import.file_name,
    'file_sha256', import.file_sha256, 'file_size_bytes', import.file_size_bytes,
    'line_count', case when private.picpay_sees_whole_files() then import.line_count else (select count(*)
      from public.picpay_statement_lines line join private.picpay_line_cohorts attribution on attribution.line_id = line.id
      where line.import_id = import.id and private.picpay_visible(attribution.cohort_id))::integer end,
    'period_from', import.period_from, 'period_to', import.period_to,
    'inflow_cents', case when private.picpay_sees_whole_files() then import.inflow_cents else (select coalesce(sum(line.amount_cents), 0)
      from public.picpay_statement_lines line join private.picpay_line_cohorts attribution on attribution.line_id = line.id
      where line.import_id = import.id and line.amount_cents > 0 and private.picpay_visible(attribution.cohort_id))::bigint end,
    'outflow_cents', case when private.picpay_sees_whole_files() then import.outflow_cents else (select coalesce(-sum(line.amount_cents), 0)
      from public.picpay_statement_lines line join private.picpay_line_cohorts attribution on attribution.line_id = line.id
      where line.import_id = import.id and line.amount_cents < 0 and private.picpay_visible(attribution.cohort_id))::bigint end,
    'overlap_accepted', import.overlap_accepted,
    'declaration', case when private.picpay_sees_whole_files() then (select jsonb_build_object('scope', declaration.scope,
        'cohort_id', declaration.declared_cohort_id, 'cohort_name', cohort.name)
      from public.picpay_import_declarations declaration left join public.cohorts cohort on cohort.id = declaration.declared_cohort_id
      where declaration.statement_import_id = import.id) end,
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
      join private.picpay_line_cohorts attribution on attribution.line_id = line.id
      where line.import_id = import.id and private.picpay_visible(attribution.cohort_id)),
    'cutover_lines', (select count(*) from public.picpay_statement_lines line
      join private.picpay_line_cohorts attribution on attribution.line_id = line.id
      where line.import_id = import.id and private.is_statement_cutover_day(line.occurred_on) and private.picpay_visible(attribution.cohort_id))
  )
  from public.picpay_statement_imports import
  join public.profiles actor on actor.id = import.actor_id
  where import.id = p_import_id;
$function$;

-- Statement lines: the cohort's own; ADMIN_MASTER also sees the unassigned ones, labelled.
CREATE OR REPLACE FUNCTION public.list_picpay_statement_lines(p_import_id uuid, p_pending_only boolean DEFAULT false, p_after_line integer DEFAULT NULL::integer, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_lines jsonb;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_import_id is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_STATEMENT_FILTER';
  end if;
  if not exists (select 1 from public.picpay_statement_imports where id = p_import_id)
    or not (private.picpay_sees_whole_files() or exists (select 1 from public.picpay_statement_lines line
      join private.picpay_line_cohorts attribution on attribution.line_id = line.id
      where line.import_id = p_import_id and private.picpay_visible(attribution.cohort_id))) then
    raise exception using errcode = 'P0001', message = 'STATEMENT_IMPORT_NOT_FOUND';
  end if;
  select coalesce(jsonb_agg(item order by (item ->> 'line_number')::integer), '[]'::jsonb) into v_lines from (
    select jsonb_build_object(
      'id', line.id, 'line_number', line.line_number, 'occurred_on', line.occurred_on, 'movement', line.movement,
      'movement_label', line.movement_label, 'amount_cents', line.amount_cents, 'description', line.description,
      'cohort_id', attribution.cohort_id, 'attribution', attribution.origin,
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
    join private.picpay_line_cohorts attribution on attribution.line_id = line.id
    where line.import_id = p_import_id and private.picpay_visible(attribution.cohort_id)
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
$function$;

-- Bulk classification selects only lines the request may see.
CREATE OR REPLACE FUNCTION private.picpay_statement_bulk_selection(p_import_id uuid, p_movement picpay_statement_movement, p_from date, p_to date, p_line_ids uuid[])
 RETURNS SETOF picpay_statement_lines
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select line.* from public.picpay_statement_lines line
  left join private.picpay_statement_current_resolutions current on current.line_id = line.id
  join private.picpay_line_cohorts attribution on attribution.line_id = line.id
  where line.import_id = p_import_id and private.picpay_visible(attribution.cohort_id)
    and (current.resolution is null or current.resolution = 'REABERTA')
    and (p_movement is null or line.movement = p_movement)
    and (p_from is null or line.occurred_on >= p_from)
    and (p_to is null or line.occurred_on <= p_to)
    and (p_line_ids is null or line.id = any (p_line_ids))
  order by line.line_number;
$function$;

-- Link candidates only for a line the request may see.
CREATE OR REPLACE FUNCTION public.list_statement_link_candidates(p_line_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_line public.picpay_statement_lines%rowtype;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  select * into v_line from public.picpay_statement_lines where id = p_line_id;
  if not found or not private.picpay_visible((select cohort_id from private.picpay_line_cohorts where line_id = p_line_id)) then
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
$function$;

-- Minhas vendas transactions the request may see.
CREATE OR REPLACE FUNCTION public.list_picpay_transactions(p_from date, p_to date, p_status picpay_transaction_status DEFAULT NULL::picpay_transaction_status, p_unlinked_only boolean DEFAULT false, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 or p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', tx.transaction_id, 'transaction_ref', tx.transaction_ref, 'sold_at', tx.sold_at, 'expected_payment_on', tx.expected_payment_on,
      'method', tx.payment_label, 'kind', tx.payment_kind, 'capture', tx.capture_solution, 'terminal', tx.terminal_number, 'brand', tx.brand,
      'card_last4', tx.card_last4, 'status', tx.status, 'gross_cents', tx.gross_cents, 'fee_cents', tx.total_fee_cents, 'net_cents', tx.net_cents,
      'cancelled_cents', tx.cancelled_cents, 'installments', tx.installments, 'historical', tx.historical,
      'payment_attempt_id', tx.payment_attempt_id, 'link_evidence', tx.link_evidence, 'observations', tx.observation_count,
      'cohort_id', tx.cohort_id,
      'imports', (select jsonb_agg(import.number order by import.number) from public.picpay_transaction_observations observation
        join public.picpay_source_imports import on import.id = observation.import_id where observation.transaction_id = tx.transaction_id))
    order by tx.sold_at desc)
    from (select tx.*, attribution.cohort_id from private.picpay_transactions_view tx
      join private.picpay_transaction_cohorts attribution on attribution.transaction_id = tx.transaction_id
      where tx.sold_on between p_from and p_to and (p_status is null or tx.status = p_status)
        and (not coalesce(p_unlinked_only, false) or tx.payment_attempt_id is null) and private.picpay_visible(attribution.cohort_id)
      order by sold_at desc limit p_limit) tx), '[]'::jsonb);
end;
$function$;

-- Imported files: a cohort ADMIN sees the files that carry evidence of the cohort.
CREATE OR REPLACE FUNCTION public.list_picpay_imports(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  return coalesce((select jsonb_agg(item order by (item ->> 'created_at') desc) from (
    select private.picpay_import_json(kind, id) as item from (
      select 'PICPAY_STATEMENT'::public.picpay_source_type as kind, import.id, import.created_at from public.picpay_statement_imports import
      where private.picpay_sees_whole_files() or exists (select 1 from public.picpay_statement_lines line
        join private.picpay_line_cohorts attribution on attribution.line_id = line.id
        where line.import_id = import.id and private.picpay_visible(attribution.cohort_id))
      union all
      select import.source_type, import.id, import.created_at from public.picpay_source_imports import
      where private.picpay_sees_whole_files() or exists (select 1 from public.picpay_transaction_observations observation
        join private.picpay_transaction_cohorts attribution on attribution.transaction_id = observation.transaction_id
        where observation.import_id = import.id and private.picpay_visible(attribution.cohort_id))
      order by created_at desc limit p_limit) recent) items), '[]'::jsonb);
end;
$function$;

-- Settlements and receivables the request may see.
CREATE OR REPLACE FUNCTION public.list_picpay_settlements(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  return jsonb_build_object(
    'days', coalesce((select jsonb_agg(jsonb_build_object('payment_on', payment_on, 'expected_net_cents', expected_net_cents,
        'expected_count', expected_count, 'settled_cents', settled_cents, 'settled_lines', settled_lines,
        'receivable_snapshot_cents', receivable_snapshot_cents, 'statement_covered', statement_covered, 'status', status) order by payment_on)
      from private.picpay_settlement_days_visible() where payment_on between p_from and p_to), '[]'::jsonb),
    'receivables', coalesce((select jsonb_agg(jsonb_build_object('id', installment_id, 'transaction_ref', transaction_ref,
        'installment', installment_number, 'installments_total', installments_total, 'payment_on', payment_on, 'status', status_label,
        'gross_cents', gross_cents, 'discount_cents', discount_cents, 'net_cents', net_cents, 'terminal', terminal_number,
        'snapshots', snapshot_count, 'last_snapshot', import_number) order by payment_on, transaction_ref)
      from private.picpay_receivable_state receivable
      where receivable.payment_on between p_from and p_to and (private.picpay_sees_whole_files() or private.picpay_visible((
        select attribution.cohort_id from private.picpay_transaction_state state
        join private.picpay_transaction_cohorts attribution on attribution.transaction_id = state.transaction_id
        where state.transaction_ref = receivable.transaction_ref)))), '[]'::jsonb));
end;
$function$;

-- Previewing a PicPay file is ADMIN_MASTER's, like importing it.
CREATE OR REPLACE FUNCTION public.preview_picpay_file(p_content text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_type public.picpay_source_type;
  v_sha256 text;
  v_result jsonb;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  -- Importing (and previewing) evidence of the shared account, and declaring whose it is, is ADMIN_MASTER's.
  if not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
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
$function$;

-- Closing a PicPay period with isolation on is ADMIN_MASTER's.
CREATE OR REPLACE FUNCTION public.close_picpay_period(p_from date, p_to date, p_note text, p_idempotency_key text, p_correlation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_period_id uuid := gen_random_uuid();
  v_summary jsonb;
  v_open integer;
  v_status text;
  v_note text := nullif(btrim(p_note), '');
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  -- A period of the shared account covers every cohort's evidence: with isolation on, only ADMIN_MASTER closes it.
  if private.picpay_attribution_enforced() and not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  if p_correlation_id is null or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366
    or (v_note is not null and char_length(v_note) not between 3 and 300) then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_PERIOD';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'close_picpay_period', v_actor_id), p_idempotency_key,
    jsonb_build_object('from', p_from, 'to', p_to, 'note', v_note));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('picpay-reconciliation', 0));
  v_summary := private.picpay_reconciliation_summary_json(p_from, p_to);
  -- The summary is the single authority for the status: no open item and no statement line awaiting review.
  v_open := (v_summary -> 'exceptions' ->> 'total')::integer;
  v_status := v_summary ->> 'status';
  insert into public.picpay_reconciliation_periods (id, period_from, period_to, note, actor_id, correlation_id)
  values (v_period_id, p_from, p_to, v_note, v_actor_id, p_correlation_id);
  insert into public.picpay_reconciliation_period_events (period_id, status, open_exceptions, summary, reason, actor_id, correlation_id)
  values (v_period_id, v_status, v_open, v_summary, coalesce(v_note, 'Período avaliado'), v_actor_id, p_correlation_id);
  v_result := jsonb_build_object('id', v_period_id, 'status', v_status, 'open_exceptions', v_open, 'summary', v_summary,
    'correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.picpay.period_evaluated', v_actor_id, 'picpay_reconciliation_period', v_period_id::text, p_correlation_id,
    jsonb_build_object('from', p_from, 'to', p_to, 'status', v_status, 'open_exceptions', v_open));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_reconciliation_period', v_period_id::text);
  return v_result;
end;
$function$;

-- 9. Import with a declaration ---------------------------------------------------------------------------------------

-- A MISTO/GLOBAL file is not matched to sales or refunds at import: the candidates would be the request cohort's only,
-- so the screen would choose the cohort. Such lines stay unassigned and pending until an explicit attribution.
drop function private.import_picpay_statement_file(text, text, text, uuid, uuid);
CREATE OR REPLACE FUNCTION private.import_picpay_statement_file(p_file_name text, p_content text, p_sha256 text, p_actor_id uuid, p_correlation_id uuid, p_match_records boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    where plan.known_line_id is null and plan.resolution in ('CONCILIADA_VENDA', 'CONCILIADA_ESTORNO') and p_match_records
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
$function$;
revoke all on function private.import_picpay_statement_file(text, text, text, uuid, uuid, boolean) from public, anon, authenticated, service_role;

drop function public.import_picpay_file(text, text, text, uuid);

-- ADMIN_MASTER imports a file once (global evidence) inside a concrete cohort and declares it: "integralmente da Turma X"
-- (X must be the cohort of the request, named explicitly) or MISTO/GLOBAL. The declaration attributes the file's
-- unassigned evidence before the engine runs, so automatic decisions inherit it.
create function public.import_picpay_file(
  p_file_name text, p_content text, p_scope public.picpay_import_scope, p_declared_cohort_id uuid,
  p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_type public.picpay_source_type;
  v_sha256 text;
  v_file_name text;
  v_cohort uuid;
  v_import_id uuid;
  v_import jsonb;
  v_declaration jsonb;
  v_engine jsonb;
  v_flagged integer;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  v_cohort := private.cohort_write_id();
  v_file_name := left(btrim(regexp_replace(regexp_replace(coalesce(p_file_name, ''), '^.*[\\/]', ''), '[0-9]{11,}', '[doc]', 'g')), 200);
  if p_correlation_id is null or p_content is null or char_length(p_content) > 4000000 or v_file_name = '' or p_scope is null
    or (p_scope = 'GLOBAL' and p_declared_cohort_id is not null) then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILE';
  end if;
  if p_scope = 'COHORT' and p_declared_cohort_id is distinct from v_cohort then
    raise exception using errcode = '22023', message = 'PICPAY_DECLARATION_COHORT_MISMATCH';
  end if;
  v_type := private.detect_picpay_source(p_content);
  if v_type is null then
    raise exception using errcode = '22023', message = 'PICPAY_FILE_UNKNOWN';
  end if;
  v_sha256 := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'import_picpay_file', v_actor_id), p_idempotency_key,
    jsonb_build_object('sha256', v_sha256, 'file_name', v_file_name, 'scope', p_scope, 'declared_cohort_id', p_declared_cohort_id));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  -- One PicPay import at a time: deduplication and reconciliation see every earlier file.
  perform pg_advisory_xact_lock(hashtextextended('picpay-statement-import', 0));
  perform pg_advisory_xact_lock(hashtextextended('picpay-reconciliation', 0));
  if exists (select 1 from public.picpay_source_imports where file_sha256 = v_sha256)
    or exists (select 1 from public.picpay_statement_imports where file_sha256 = v_sha256) then
    raise exception using errcode = 'P0001', message = 'PICPAY_FILE_ALREADY_IMPORTED';
  end if;
  v_import_id := case v_type
    when 'PICPAY_SALES' then private.import_picpay_sales_file(v_file_name, p_content, v_sha256, v_actor_id, p_correlation_id)
    when 'PICPAY_RECEIVABLES' then private.import_picpay_receivables_file(v_file_name, p_content, v_sha256, v_actor_id, p_correlation_id)
    else private.import_picpay_statement_file(v_file_name, p_content, v_sha256, v_actor_id, p_correlation_id, p_scope = 'COHORT')
  end;
  v_declaration := private.apply_picpay_import_declaration(v_import_id, v_type, p_scope,
    case when p_scope = 'COHORT' then v_cohort end, v_actor_id, p_correlation_id);
  v_engine := private.run_picpay_reconciliation(v_actor_id, p_correlation_id);
  v_import := private.picpay_import_json(v_type, v_import_id);
  v_flagged := private.picpay_flag_periods_for_review((v_import ->> 'period_from')::date, (v_import ->> 'period_to')::date,
    'Nova evidência: arquivo ' || (v_import ->> 'number') || ' de ' || case v_type when 'PICPAY_SALES' then 'Minhas vendas'
      when 'PICPAY_RECEIVABLES' then 'Recebíveis' else 'Extrato' end, v_actor_id, p_correlation_id);

  v_result := v_import || jsonb_build_object('reconciliation', v_engine, 'periods_flagged', v_flagged, 'declaration', v_declaration,
    'correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.picpay.file_imported', v_actor_id, 'picpay_import', v_import_id::text, p_correlation_id,
    jsonb_build_object('source_type', v_type, 'number', v_import -> 'number', 'file_sha256', v_sha256, 'row_count', v_import -> 'row_count',
      'period_from', v_import -> 'period_from', 'period_to', v_import -> 'period_to', 'new_count', v_import -> 'new_count',
      'known_count', v_import -> 'known_count', 'updated_count', v_import -> 'updated_count', 'ambiguous_count', v_import -> 'ambiguous_count',
      'reconciliation', v_engine, 'periods_flagged', v_flagged, 'declaration', v_declaration));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.picpay.file_imported', 'picpay_import', v_import_id::text,
    jsonb_build_object('import_id', v_import_id, 'source_type', v_type, 'scope', p_scope, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_import', v_import_id::text);
  return v_result;
end;
$$;

-- 10. ADMIN_MASTER's view of the shared account, by effective attribution ---------------------------------------------

create or replace function public.picpay_evidence_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  return jsonb_build_object(
    'imports', (select count(*) from public.picpay_statement_imports),
    'last_period_to', (select max(period_to) from public.picpay_statement_imports),
    'inflow_cents', (select coalesce(sum(inflow_cents), 0) from public.picpay_statement_imports),
    'outflow_cents', (select coalesce(sum(outflow_cents), 0) from public.picpay_statement_imports),
    'lines', (select count(*) from public.picpay_statement_lines),
    'lines_pending', (select count(*) from public.picpay_statement_lines line
      where not exists (select 1 from private.picpay_statement_current_resolutions current where current.line_id = line.id)),
    'lines_global', (select count(*) from private.picpay_line_cohorts where cohort_id is null),
    'lines_global_net_cents', (select coalesce(sum(line.amount_cents), 0) from public.picpay_statement_lines line
      join private.picpay_line_cohorts attribution on attribution.line_id = line.id where attribution.cohort_id is null),
    'transactions_global', (select count(*) from private.picpay_transaction_cohorts where cohort_id is null),
    'enforced', private.picpay_attribution_enforced(),
    'lines_by_cohort', coalesce((select jsonb_agg(jsonb_build_object('cohort_id', counted.cohort_id, 'lines', counted.lines) order by counted.cohort_id)
      from (select cohort_id, count(*) as lines from private.picpay_line_cohorts where cohort_id is not null group by cohort_id) counted), '[]'::jsonb));
end;
$$;

-- 11. Grants ---------------------------------------------------------------------------------------------------------

revoke all on function public.import_picpay_file(text, text, public.picpay_import_scope, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.preview_picpay_assignment(uuid, uuid[], uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.assign_picpay_evidence(uuid, uuid[], uuid[], text, integer, bigint, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.picpay_attribution_status() from public, anon, authenticated, service_role;
revoke all on function public.list_unassigned_picpay_evidence(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.activate_picpay_attribution_isolation(text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.import_picpay_file(text, text, public.picpay_import_scope, uuid, text, uuid) to authenticated;
grant execute on function public.preview_picpay_assignment(uuid, uuid[], uuid[]) to authenticated;
grant execute on function public.assign_picpay_evidence(uuid, uuid[], uuid[], text, integer, bigint, text, uuid) to authenticated;
grant execute on function public.picpay_attribution_status() to authenticated;
grant execute on function public.list_unassigned_picpay_evidence(uuid, integer) to authenticated;
grant execute on function public.activate_picpay_attribution_isolation(text, text, uuid) to authenticated;

comment on function public.import_picpay_file(text, text, public.picpay_import_scope, uuid, text, uuid) is
  'ADMIN_MASTER importa um arquivo do PicPay (Minhas vendas, Recebíveis ou Extrato) uma única vez e declara se é integralmente '
  'da turma da requisição (atribui a evidência sem turma) ou misto/global (fica sem turma).';
comment on function public.assign_picpay_evidence(uuid, uuid[], uuid[], text, integer, bigint, text, uuid) is
  'ADMIN_MASTER atribui à turma da requisição evidência PicPay sem turma (um arquivo ou itens), após conferir a prévia.';
comment on function public.activate_picpay_attribution_isolation(text, text, uuid) is
  'ADMIN_MASTER ativa o isolamento uma única vez (sem volta): evidência PicPay sem turma deixa os livros de todas as turmas.';
