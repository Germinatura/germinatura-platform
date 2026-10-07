-- Spec 5.8 (FIN-001, FIN-003, FIN-007): hardening before the first real PicPay import. Permissions and function
-- definitions only: no row is inserted, updated or deleted, and no existing reconciliation, ledger entry, statement
-- import or balance changes.

-- 1. The statement-only import (and its preview) is retired. PicPay files enter only through import_picpay_file, which
--    deduplicates the Extrato across overlapping exports. Imports already recorded stay readable through
--    list_picpay_statement_imports and list_picpay_statement_lines; the private parser and planner remain because the
--    new importer uses them, and they are not executable by any API role.
drop function public.import_picpay_statement(text, text, boolean, text, uuid);
drop function public.preview_picpay_statement(text);
revoke all on function private.parse_picpay_statement(text) from public, anon, authenticated, service_role;
revoke all on function private.plan_picpay_statement(text) from public, anon, authenticated, service_role;

-- 2. Maquininha and Tap are no longer settled by reconcile_payment_attempt (manual route or import). The rule lives in
--    the function every caller goes through, after the idempotent replay so earlier results are still returned as
--    recorded. Other channels (Área Pix, Payment Link, Checkout, carteira) keep working.
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

  -- Card payments (Maquininha, Tap) are settled only by the PicPay reconciliation (Minhas vendas, Recebíveis and
  -- Extrato). A manual or imported settlement here would count the same money a second time.
  if v_attempt.integration_channel in ('MAQUININHA', 'TAP') then
    raise exception using errcode = 'P0001', message = 'PAYMENT_RECONCILIATION_PICPAY_ONLY';
  end if;
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

revoke all on function public.reconcile_payment_attempt(uuid, bigint, bigint, text, public.payment_reconciliation_source, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.reconcile_payment_attempt(uuid, bigint, bigint, text, public.payment_reconciliation_source, text, uuid)
to authenticated;
comment on function public.reconcile_payment_attempt(uuid, bigint, bigint, text, public.payment_reconciliation_source, text, uuid) is
  'Finance-only idempotent reconciliation that appends fee/settlement or divergence entries and advances payment state. '
  'Refuses Maquininha and Tap (PAYMENT_RECONCILIATION_PICPAY_ONLY): card payments are settled by the PicPay reconciliation.';
