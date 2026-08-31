create type public.payment_reconciliation_outcome as enum ('MATCHED', 'DIVERGENT');
create type public.payment_reconciliation_source as enum ('MANUAL', 'IMPORT');

create table public.payment_reconciliations (
  id uuid primary key default gen_random_uuid(),
  payment_attempt_id uuid not null references public.payment_attempts(id) on delete restrict,
  expected_amount_cents bigint not null,
  observed_amount_cents bigint not null,
  fee_amount_cents bigint not null default 0,
  net_amount_cents bigint not null,
  external_reference text not null,
  source public.payment_reconciliation_source not null,
  outcome public.payment_reconciliation_outcome not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint payment_reconciliations_amounts_valid check (
    expected_amount_cents between 0 and 9007199254740991
    and observed_amount_cents between 1 and 9007199254740991
    and fee_amount_cents between 0 and observed_amount_cents - 1
    and net_amount_cents = observed_amount_cents - fee_amount_cents
  ),
  constraint payment_reconciliations_outcome_valid check (
    (outcome = 'MATCHED' and observed_amount_cents = expected_amount_cents)
    or (outcome = 'DIVERGENT' and observed_amount_cents <> expected_amount_cents)
  ),
  constraint payment_reconciliations_reference_valid check (
    char_length(external_reference) between 4 and 128
    and external_reference = btrim(external_reference)
    and external_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$'
    and external_reference !~ '[0-9]{12,}'
  ),
  constraint payment_reconciliations_external_reference_unique
    unique (external_reference)
);

create index payment_reconciliations_attempt_created_idx
  on public.payment_reconciliations (payment_attempt_id, created_at, id);
create index payment_reconciliations_outcome_created_idx
  on public.payment_reconciliations (outcome, created_at, id);
create index payment_reconciliations_correlation_idx
  on public.payment_reconciliations (correlation_id);

alter table public.financial_ledger_entries
  add column reconciliation_id uuid references public.payment_reconciliations(id) on delete restrict;
create unique index financial_ledger_reconciliation_type_unique
  on public.financial_ledger_entries (reconciliation_id, entry_type)
  where reconciliation_id is not null;

create trigger payment_reconciliations_immutable before update or delete
on public.payment_reconciliations
for each row execute function private.prevent_immutable_record_change();

create or replace function private.transition_payment_attempt(
  p_attempt_id uuid,
  p_target_status public.payment_attempt_status,
  p_actor_id uuid,
  p_correlation_id uuid,
  p_reason text default null
)
returns public.payment_attempts
language plpgsql
set search_path = ''
as $$
declare
  v_attempt public.payment_attempts%rowtype;
  v_from_status public.payment_attempt_status;
begin
  if p_actor_id is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_TRANSITION_CONTEXT';
  end if;
  if p_reason is not null and (
    char_length(p_reason) not between 1 and 500 or p_reason <> btrim(p_reason)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_TRANSITION_REASON';
  end if;
  if not exists (select 1 from public.profiles where id = p_actor_id and active) then
    raise exception using errcode = '42501', message = 'PAYMENT_ACTOR_INACTIVE';
  end if;

  select * into v_attempt from public.payment_attempts where id = p_attempt_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status = p_target_status then
    return v_attempt;
  end if;
  if not (
    (v_attempt.status = 'CREATED' and p_target_status = 'CANCELLED')
    or (v_attempt.status = 'APPROVED' and p_target_status in ('RECONCILIATION_PENDING', 'RECONCILED'))
    or (v_attempt.status = 'RECONCILIATION_PENDING' and p_target_status = 'RECONCILED')
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_PAYMENT_TRANSITION';
  end if;

  v_from_status := v_attempt.status;
  update public.payment_attempts set status = p_target_status where id = v_attempt.id
  returning * into v_attempt;
  insert into public.payment_attempt_status_history (
    attempt_id, from_status, to_status, actor_id, reason, correlation_id
  ) values (
    v_attempt.id, v_from_status, p_target_status, p_actor_id, p_reason, p_correlation_id
  );
  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'payments.attempt.status.changed', p_actor_id, 'payment_attempt', v_attempt.id::text,
    p_correlation_id, jsonb_build_object('status', p_target_status, 'reason', p_reason)
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'payments.attempt.status.changed', 'payment_attempt', v_attempt.id::text,
    jsonb_build_object(
      'attempt_id', v_attempt.id,
      'sale_id', v_attempt.sale_id,
      'status', p_target_status,
      'correlation_id', p_correlation_id
    )
  );
  return v_attempt;
end;
$$;

create or replace function public.reconcile_payment_attempt(
  p_attempt_id uuid,
  p_observed_amount_cents bigint,
  p_fee_amount_cents bigint,
  p_external_reference text,
  p_source public.payment_reconciliation_source,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_attempt public.payment_attempts%rowtype;
  v_scope text;
  v_claim record;
  v_reconciliation_id uuid := gen_random_uuid();
  v_outcome public.payment_reconciliation_outcome;
  v_net_amount_cents bigint;
  v_delta_cents bigint;
  v_fee_entry_id uuid;
  v_settlement_entry_id uuid;
  v_divergence_entry_id uuid;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_observed_amount_cents is null
    or p_observed_amount_cents not between 1 and 9007199254740991
    or p_fee_amount_cents is null
    or p_fee_amount_cents not between 0 and p_observed_amount_cents - 1 then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION_AMOUNTS';
  end if;
  if p_external_reference is null
    or char_length(p_external_reference) not between 4 and 128
    or p_external_reference <> btrim(p_external_reference)
    or p_external_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$'
    or p_external_reference ~ '[0-9]{12,}' then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION_REFERENCE';
  end if;
  if p_source is null or p_source not in ('MANUAL', 'IMPORT') then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION_SOURCE';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;

  select * into v_attempt from public.payment_attempts where id = p_attempt_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;

  v_scope := private.build_idempotency_scope('finance', 'reconcile_payment', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object(
      'attempt_id', p_attempt_id,
      'observed_amount_cents', p_observed_amount_cents,
      'fee_amount_cents', p_fee_amount_cents,
      'external_reference', p_external_reference,
      'source', p_source
    )
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  if v_attempt.status not in ('APPROVED', 'RECONCILIATION_PENDING') then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_RECONCILABLE';
  end if;
  v_outcome := case
    when p_observed_amount_cents = v_attempt.amount_cents then 'MATCHED'::public.payment_reconciliation_outcome
    else 'DIVERGENT'::public.payment_reconciliation_outcome
  end;
  v_net_amount_cents := p_observed_amount_cents - p_fee_amount_cents;
  v_delta_cents := p_observed_amount_cents - v_attempt.amount_cents;

  insert into public.payment_reconciliations (
    id, payment_attempt_id, expected_amount_cents, observed_amount_cents,
    fee_amount_cents, net_amount_cents, external_reference, source,
    outcome, actor_id, correlation_id
  ) values (
    v_reconciliation_id, v_attempt.id, v_attempt.amount_cents, p_observed_amount_cents,
    p_fee_amount_cents, v_net_amount_cents, p_external_reference, p_source,
    v_outcome, v_actor_id, p_correlation_id
  );

  if v_outcome = 'DIVERGENT' then
    insert into public.financial_ledger_entries (
      sale_id, payment_attempt_id, reconciliation_id, entry_type,
      amount_cents, actor_id, correlation_id,
      metadata
    ) values (
      v_attempt.sale_id, v_attempt.id, v_reconciliation_id, 'DIVERGENCE',
      v_delta_cents, v_actor_id, p_correlation_id,
      jsonb_build_object('observed_amount_cents', p_observed_amount_cents)
    ) returning id into v_divergence_entry_id;
    v_attempt := private.transition_payment_attempt(
      v_attempt.id, 'RECONCILIATION_PENDING', v_actor_id, p_correlation_id,
      'Divergência entre recebível e valor observado'
    );
  else
    if p_fee_amount_cents > 0 then
      insert into public.financial_ledger_entries (
        sale_id, payment_attempt_id, reconciliation_id, entry_type,
        amount_cents, actor_id, correlation_id
      ) values (
        v_attempt.sale_id, v_attempt.id, v_reconciliation_id, 'FEE',
        -p_fee_amount_cents, v_actor_id, p_correlation_id
      ) returning id into v_fee_entry_id;
    end if;
    insert into public.financial_ledger_entries (
      sale_id, payment_attempt_id, reconciliation_id, entry_type,
      amount_cents, actor_id, correlation_id
    ) values (
      v_attempt.sale_id, v_attempt.id, v_reconciliation_id, 'SETTLEMENT',
      v_net_amount_cents, v_actor_id, p_correlation_id
    ) returning id into v_settlement_entry_id;
    v_attempt := private.transition_payment_attempt(
      v_attempt.id, 'RECONCILED', v_actor_id, p_correlation_id,
      'Recebível conciliado com valor observado'
    );
  end if;

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'finance.payment.reconciled', v_actor_id, 'payment_reconciliation',
    v_reconciliation_id::text, p_correlation_id,
    jsonb_build_object(
      'attempt_id', v_attempt.id,
      'expected_amount_cents', v_attempt.amount_cents,
      'observed_amount_cents', p_observed_amount_cents,
      'fee_amount_cents', p_fee_amount_cents,
      'outcome', v_outcome,
      'source', p_source
    )
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'finance.payment.reconciled', 'payment_reconciliation', v_reconciliation_id::text,
    jsonb_build_object(
      'reconciliation_id', v_reconciliation_id,
      'attempt_id', v_attempt.id,
      'outcome', v_outcome,
      'status', v_attempt.status,
      'correlation_id', p_correlation_id
    )
  );

  v_result := jsonb_build_object(
    'reconciliation_id', v_reconciliation_id,
    'attempt_id', v_attempt.id,
    'payment_status', v_attempt.status,
    'outcome', v_outcome,
    'expected_amount_cents', v_attempt.amount_cents,
    'observed_amount_cents', p_observed_amount_cents,
    'fee_amount_cents', p_fee_amount_cents,
    'net_amount_cents', v_net_amount_cents,
    'source', p_source,
    'external_reference', p_external_reference,
    'ledger', jsonb_build_object(
      'fee_entry_id', v_fee_entry_id,
      'settlement_entry_id', v_settlement_entry_id,
      'divergence_entry_id', v_divergence_entry_id
    ),
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null,
    'payment_reconciliation', v_reconciliation_id::text
  );
  return v_result;
exception
  when unique_violation then
    if sqlerrm like '%payment_reconciliations_external_reference_unique%' then
      raise exception using errcode = 'P0001', message = 'RECONCILIATION_REFERENCE_ALREADY_USED';
    end if;
    raise;
end;
$$;

alter table public.payment_reconciliations enable row level security;
revoke all on table public.payment_reconciliations from public, anon, authenticated, service_role;
grant select on table public.payment_reconciliations to authenticated;
create policy payment_reconciliations_finance_read
on public.payment_reconciliations for select to authenticated
using (public.has_permission('finance.manage'));

revoke all on function private.transition_payment_attempt(uuid, public.payment_attempt_status, uuid, uuid, text)
from public, anon, authenticated, service_role;
revoke all on function public.reconcile_payment_attempt(uuid, bigint, bigint, text, public.payment_reconciliation_source, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.reconcile_payment_attempt(uuid, bigint, bigint, text, public.payment_reconciliation_source, text, uuid)
to authenticated;

comment on table public.payment_reconciliations is
  'Append-only observations that reconcile or flag divergence without changing prior financial entries.';
comment on function public.reconcile_payment_attempt(uuid, bigint, bigint, text, public.payment_reconciliation_source, text, uuid) is
  'Finance-only idempotent reconciliation that appends fee/settlement or divergence entries and advances payment state.';
