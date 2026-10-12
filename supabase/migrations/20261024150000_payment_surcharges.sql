-- Acréscimo por meio de pagamento (PR D). Per cohort, finance configures for each eligible PDV method an
-- acréscimo charged to the customer: NONE, PERCENTAGE (basis points) or FIXED (cents). It is a price the class
-- charges, never the PicPay fee: the real fee still comes only from the PicPay reconciliation (TAXAS).
--
-- Eligible methods are those the PDV confirms in person: DINHEIRO, PIX (Área Pix), CREDITO and DEBITO (Maquininha).
-- V.A./V.R. stays recorded as Crédito (decision of 01/10/2026); the voucher card methods, behind the meal_voucher
-- flag, have no rule of their own and never receive an acréscimo. The Payment Link (flag off, externally blocked)
-- is not eligible yet: its charge amount stays the sale total.
--
-- Model:
--   * payment_surcharge_rules: append-only versions per (cohort, method). The current rule is the highest version;
--     no rule means NONE. A change is a new version with a reason; nothing is updated or deleted.
--   * payment_surcharges: immutable snapshot per payment attempt, written in the confirmation transaction: rule
--     version, mode, rate/fixed value, base, expected acréscimo, applied acréscimo and the waiver, if any.
--   * The sale keeps the product total (sales.total_cents, immutable). The payment attempt amount becomes what the
--     customer is charged: sales.total_cents + applied acréscimo. Receipt ledger entries, cash movements, the PicPay
--     reconciliation (amount = gross), refunds and closeouts all follow the attempt amount.
--
-- Calculation (packages/domain computePaymentSurchargeCents mirrors it):
--   base = sales.total_cents (after every discount and coupon)
--   PERCENTAGE: floor(base * rate_bps / 10000) — customer-favorable, as the PERCENTUAL discount (27/09/2026)
--   FIXED: fixed_cents once per sale; a zero base never receives an acréscimo
--   gross = base + applied, applied = 0 when waived
-- The operator sends the acréscimo shown to the customer; the server recomputes it and refuses a different value
-- (PAYMENT_SURCHARGE_CHANGED), so a rule changed between display and confirmation never charges an unseen amount.
--
-- Waiver ("Remover acréscimo"): permission sales.surcharge.waive (ADMIN; ADMIN_MASTER has every permission), a reason,
-- recorded in the snapshot and in the audit with the rule in force and the amount waived.
--
-- Refund/cancellation: a confirmed sale is reversed in full (reverse_confirmed_sale refunds the attempt amount), so the
-- acréscimo goes back to the customer with the products. A pending sale cancelled before payment never had one.

set local lock_timeout = '5s';

create type public.payment_surcharge_method as enum ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO');
create type public.payment_surcharge_mode as enum ('NONE', 'PERCENTAGE', 'FIXED');

insert into public.permissions (key, description) values
  ('sales.surcharge.waive', 'Remover o acréscimo do meio de pagamento de uma venda no PDV')
on conflict (key) do nothing;
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id from public.roles role cross join public.permissions permission
where role.key = 'ADMIN' and permission.key = 'sales.surcharge.waive'
on conflict do nothing;

-- New cohort tables (ADR 0011) follow exactly what 20261020090200 did to the existing ones: the base table moves to
-- cohort_data, cohort_id is mandatory (REQUIRED) without a default, a restrictive RLS policy and the public view filter
-- by the request scope, and the guard fills/validates cohort_id from the parent rows.
create function private.register_cohort_table(p_table text, p_domain text, p_mode text)
returns void language plpgsql set search_path = '' as $$
declare
  v_scope text := case p_mode
    when 'REQUIRED' then 'cohort_id = any ((select private.cohort_scope())::uuid[])'
    when 'SHARED_NULLABLE' then 'cohort_id is null or cohort_id = any ((select private.cohort_scope())::uuid[])'
    else 'cohort_id = any ((select private.cohort_scope())::uuid[]) or (cohort_id is null and (select private.cohort_sees_global()))'
  end;
  v_args text;
begin
  if p_mode not in ('REQUIRED', 'SHARED_NULLABLE', 'MASTER_NULLABLE') or p_mode = 'MASTER_NULLABLE' then
    raise exception 'COHORT_TABLE_MODE_UNSUPPORTED: %', p_mode;
  end if;
  if to_regclass(format('public.%I', p_table)) is null
    or (select relkind from pg_class where oid = format('public.%I', p_table)::regclass) <> 'r' then
    raise exception 'COHORT_TABLE_MISSING: public.%', p_table;
  end if;
  insert into private.cohort_scoped_tables (table_name, domain, mode) values (p_table, p_domain, p_mode);
  execute format('alter table public.%I set schema cohort_data', p_table);
  if p_mode = 'REQUIRED' then
    execute format('alter table cohort_data.%I alter column cohort_id set not null', p_table);
  end if;
  execute format('alter table cohort_data.%I enable row level security', p_table);
  execute format('create policy %I on cohort_data.%I as restrictive for all to anon, authenticated using (%s) with check (%s)',
    p_table || '_cohort_scope', p_table, v_scope, v_scope);
  perform private.refresh_cohort_view(p_table);
  select string_agg(format('%L, %L, %L, %L', child_column.attname, parent.relname, parent_column.attname,
      format_type(parent_column.atttypid, parent_column.atttypmod)), ', ' order by constraint_row.conname)
  into v_args
  from pg_constraint constraint_row
  join pg_class child on child.oid = constraint_row.conrelid
  join pg_class parent on parent.oid = constraint_row.confrelid
  join pg_attribute child_column on child_column.attrelid = constraint_row.conrelid and child_column.attnum = constraint_row.conkey[1]
  join pg_attribute parent_column on parent_column.attrelid = constraint_row.confrelid and parent_column.attnum = constraint_row.confkey[1]
  where constraint_row.contype = 'f' and cardinality(constraint_row.conkey) = 1
    and child.relnamespace = 'cohort_data'::regnamespace and child.relname = p_table
    and parent.relnamespace = 'cohort_data'::regnamespace and child_column.attname <> 'cohort_id';
  execute format(
    'create trigger a_cohort_guard before insert or update or delete on cohort_data.%I for each row execute function private.guard_cohort_write(%L%s)',
    p_table, p_mode, case when v_args is null then '' else ', ' || v_args end);
end;
$$;
revoke all on function private.register_cohort_table(text, text, text) from public, anon, authenticated, service_role;

-- Rules: append-only versions per cohort and method.
create table public.payment_surcharge_rules (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references public.cohorts(id) on delete restrict,
  method public.payment_surcharge_method not null,
  version integer not null check (version >= 1),
  mode public.payment_surcharge_mode not null,
  rate_bps integer,
  fixed_cents bigint,
  reason text not null check (char_length(reason) between 3 and 500 and reason = btrim(reason)),
  created_by uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint payment_surcharge_rules_version_unique unique (cohort_id, method, version),
  constraint payment_surcharge_rules_value_valid check (
    (mode = 'NONE' and rate_bps is null and fixed_cents is null)
    or (mode = 'PERCENTAGE' and rate_bps between 1 and 10000 and fixed_cents is null)
    or (mode = 'FIXED' and fixed_cents between 1 and 1000000 and rate_bps is null)
  )
);
comment on table public.payment_surcharge_rules is
  'Acréscimo por meio de pagamento: versões imutáveis por turma e método; vale a maior versão; sem linha = NONE.';
create trigger payment_surcharge_rules_immutable before update or delete on public.payment_surcharge_rules
for each row execute function private.prevent_immutable_record_change();
revoke all on public.payment_surcharge_rules from public, anon, authenticated, service_role;
select private.register_cohort_table('payment_surcharge_rules', 'payments', 'REQUIRED');

-- Snapshot of the acréscimo applied (or waived) to one payment attempt.
create table public.payment_surcharges (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references public.cohorts(id) on delete restrict,
  sale_id uuid not null references cohort_data.sales(id) on delete restrict,
  payment_attempt_id uuid not null references cohort_data.payment_attempts(id) on delete restrict,
  rule_id uuid not null references cohort_data.payment_surcharge_rules(id) on delete restrict,
  method public.payment_surcharge_method not null,
  mode public.payment_surcharge_mode not null,
  rate_bps integer,
  fixed_cents bigint,
  base_cents bigint not null check (base_cents between 1 and 9007199254740991),
  expected_cents bigint not null check (expected_cents between 1 and 9007199254740991),
  applied_cents bigint not null,
  waived boolean not null default false,
  waived_by uuid references public.profiles(id) on delete restrict,
  waiver_reason text,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint payment_surcharges_attempt_unique unique (payment_attempt_id),
  constraint payment_surcharges_value_valid check (
    (mode = 'PERCENTAGE' and rate_bps between 1 and 10000 and fixed_cents is null)
    or (mode = 'FIXED' and fixed_cents between 1 and 1000000 and rate_bps is null)
  ),
  constraint payment_surcharges_applied_valid check (applied_cents = case when waived then 0 else expected_cents end),
  constraint payment_surcharges_waiver_valid check (
    (waived and waived_by is not null and waiver_reason is not null
      and char_length(waiver_reason) between 5 and 500 and waiver_reason = btrim(waiver_reason))
    or (not waived and waived_by is null and waiver_reason is null)
  )
);
comment on table public.payment_surcharges is
  'Snapshot imutável do acréscimo aplicado (ou dispensado) em uma tentativa de pagamento; cobrado = sales.total_cents + applied_cents.';
create index payment_surcharges_sale_idx on public.payment_surcharges (sale_id);
create index payment_surcharges_rule_idx on public.payment_surcharges (rule_id);
create trigger payment_surcharges_immutable before update or delete on public.payment_surcharges
for each row execute function private.prevent_immutable_record_change();
revoke all on public.payment_surcharges from public, anon, authenticated, service_role;
select private.register_cohort_table('payment_surcharges', 'payments', 'REQUIRED');

insert into private.cohort_entity_types (entity_type, table_name) values
  ('payment_surcharge_rule', 'payment_surcharge_rules'), ('payment_surcharge', 'payment_surcharges')
on conflict (entity_type) do nothing;

-- Calculation -------------------------------------------------------------------------------------------------------

create function private.payment_surcharge_method_for(
  p_channel public.payment_integration_channel, p_card_method public.card_payment_method
)
returns public.payment_surcharge_method language sql immutable set search_path = '' as $$
  select case
    when p_channel = 'DINHEIRO' then 'DINHEIRO'::public.payment_surcharge_method
    when p_channel = 'PIX_AREA' then 'PIX'::public.payment_surcharge_method
    when p_channel = 'MAQUININHA' and p_card_method = 'CREDITO' then 'CREDITO'::public.payment_surcharge_method
    when p_channel = 'MAQUININHA' and p_card_method = 'DEBITO' then 'DEBITO'::public.payment_surcharge_method
  end;
$$;

create function private.compute_payment_surcharge_cents(
  p_mode public.payment_surcharge_mode, p_rate_bps integer, p_fixed_cents bigint, p_base_cents bigint
)
returns bigint language sql immutable set search_path = '' as $$
  select case
    when p_base_cents is null or p_base_cents <= 0 or p_mode is null or p_mode = 'NONE' then 0::bigint
    when p_mode = 'PERCENTAGE' then floor(p_base_cents::numeric * p_rate_bps / 10000)::bigint
    else p_fixed_cents
  end;
$$;

-- The rule in force for one cohort and method (NULL = none ever configured = NONE).
create function private.current_payment_surcharge_rule(p_cohort_id uuid, p_method public.payment_surcharge_method)
returns public.payment_surcharge_rules language sql stable security definer set search_path = '' as $$
  select rule.* from public.payment_surcharge_rules rule
  where rule.cohort_id = p_cohort_id and rule.method = p_method
  order by rule.version desc limit 1;
$$;

-- Applies the acréscimo of the sale's cohort to a CREATED attempt inside the confirmation transaction. Returns the
-- snapshot (JSON), or NULL when there is none: method not eligible, rule NONE or zero base.
create function private.apply_payment_surcharge(
  p_sale_id uuid, p_attempt_id uuid, p_method public.payment_surcharge_method,
  p_expected_cents bigint, p_waive boolean, p_waiver_reason text, p_actor_id uuid, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sale public.sales%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_rule public.payment_surcharge_rules%rowtype;
  v_expected bigint := 0;
  v_applied bigint;
  v_waive boolean := coalesce(p_waive, false);
  v_reason text := nullif(btrim(p_waiver_reason), '');
  v_snapshot public.payment_surcharges%rowtype;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  select * into v_attempt from public.payment_attempts where id = p_attempt_id;
  if v_sale.id is null or v_attempt.id is null or v_attempt.sale_id <> v_sale.id or v_attempt.status <> 'CREATED'
    or v_attempt.amount_cents <> v_sale.total_cents then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_CONFIRMABLE';
  end if;
  if p_method is not null then
    v_rule := private.current_payment_surcharge_rule(v_sale.cohort_id, p_method);
    if v_rule.id is not null then
      v_expected := private.compute_payment_surcharge_cents(v_rule.mode, v_rule.rate_bps, v_rule.fixed_cents, v_sale.total_cents);
    end if;
  end if;
  if p_expected_cents is not null and p_expected_cents < 0 then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_SURCHARGE';
  end if;
  if coalesce(p_expected_cents, 0) <> v_expected then
    raise exception using errcode = 'P0001', message = 'PAYMENT_SURCHARGE_CHANGED',
      detail = jsonb_build_object('expected_cents', v_expected)::text;
  end if;
  if v_waive then
    if v_expected = 0 then
      raise exception using errcode = 'P0001', message = 'PAYMENT_SURCHARGE_NOT_APPLICABLE';
    end if;
    if not public.has_permission('sales.surcharge.waive') then
      raise exception using errcode = '42501', message = 'SURCHARGE_WAIVE_FORBIDDEN';
    end if;
    if v_reason is null or char_length(v_reason) not between 5 and 500 then
      raise exception using errcode = '22023', message = 'INVALID_SURCHARGE_WAIVER_REASON';
    end if;
  end if;
  if v_expected = 0 then
    return null;
  end if;

  v_applied := case when v_waive then 0 else v_expected end;
  insert into public.payment_surcharges (
    sale_id, payment_attempt_id, rule_id, method, mode, rate_bps, fixed_cents, base_cents, expected_cents, applied_cents,
    waived, waived_by, waiver_reason, actor_id, correlation_id
  ) values (
    v_sale.id, v_attempt.id, v_rule.id, p_method, v_rule.mode, v_rule.rate_bps, v_rule.fixed_cents, v_sale.total_cents,
    v_expected, v_applied, v_waive, case when v_waive then p_actor_id end, case when v_waive then v_reason end,
    p_actor_id, p_correlation_id
  ) returning * into v_snapshot;
  if v_applied > 0 then
    update public.payment_attempts set amount_cents = v_sale.total_cents + v_applied where id = v_attempt.id;
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (case when v_waive then 'payments.surcharge.waived' else 'payments.surcharge.applied' end, p_actor_id,
    'payment_surcharge', v_snapshot.id::text, p_correlation_id,
    jsonb_build_object('sale_id', v_sale.id, 'payment_attempt_id', v_attempt.id, 'rule_id', v_rule.id,
      'rule_version', v_rule.version, 'method', p_method, 'mode', v_rule.mode, 'rate_bps', v_rule.rate_bps,
      'fixed_cents', v_rule.fixed_cents, 'base_cents', v_sale.total_cents, 'expected_cents', v_expected,
      'applied_cents', v_applied, 'waived_cents', v_expected - v_applied, 'waiver_reason', v_snapshot.waiver_reason));
  return private.payment_surcharge_json(v_snapshot);
end;
$$;

create function private.payment_surcharge_json(p_surcharge public.payment_surcharges)
returns jsonb language sql immutable set search_path = '' as $$
  select case when p_surcharge.id is null then null else jsonb_build_object(
    'method', p_surcharge.method, 'mode', p_surcharge.mode, 'rate_bps', p_surcharge.rate_bps,
    'fixed_cents', p_surcharge.fixed_cents, 'base_cents', p_surcharge.base_cents,
    'expected_cents', p_surcharge.expected_cents, 'applied_cents', p_surcharge.applied_cents,
    'waived', p_surcharge.waived, 'waiver_reason', p_surcharge.waiver_reason) end;
$$;

revoke all on function private.payment_surcharge_method_for(public.payment_integration_channel, public.card_payment_method),
  private.compute_payment_surcharge_cents(public.payment_surcharge_mode, integer, bigint, bigint),
  private.current_payment_surcharge_rule(uuid, public.payment_surcharge_method),
  private.apply_payment_surcharge(uuid, uuid, public.payment_surcharge_method, bigint, boolean, text, uuid, uuid),
  private.payment_surcharge_json(public.payment_surcharges)
  from public, anon, authenticated, service_role;

-- Configuration -----------------------------------------------------------------------------------------------------

-- The rules in force for every eligible method of the request cohort (sellers need them to show the acréscimo before
-- charging); finance also receives the version history.
create function public.list_payment_surcharge_rules()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_cohort_id uuid := private.cohort_permission_id();
begin
  if auth.uid() is null or not (public.has_permission('sales.create') or public.has_permission('finance.manage')) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_cohort_id is null then
    raise exception using errcode = 'P0001', message = 'COHORT_REQUIRED';
  end if;
  return jsonb_build_object(
    'cohort_id', v_cohort_id,
    'rules', (select jsonb_agg(jsonb_build_object(
        'method', method.value, 'mode', coalesce(rule.mode, 'NONE'), 'rate_bps', rule.rate_bps, 'fixed_cents', rule.fixed_cents,
        'version', coalesce(rule.version, 0), 'rule_id', rule.id, 'reason', rule.reason, 'updated_at', rule.created_at,
        'updated_by_name', case when rule.id is null then null
          else coalesce(nullif(btrim(author.display_name), ''), split_part(author.email, '@', 1)) end)
        order by method.position)
      from unnest(enum_range(null::public.payment_surcharge_method)) with ordinality as method(value, position)
      left join lateral (select * from public.payment_surcharge_rules candidate
        where candidate.cohort_id = v_cohort_id and candidate.method = method.value
        order by candidate.version desc limit 1) rule on true
      left join public.profiles author on author.id = rule.created_by),
    'history', case when public.has_permission('finance.manage') then coalesce((select jsonb_agg(jsonb_build_object(
        'rule_id', rule.id, 'method', rule.method, 'version', rule.version, 'mode', rule.mode, 'rate_bps', rule.rate_bps,
        'fixed_cents', rule.fixed_cents, 'reason', rule.reason, 'created_at', rule.created_at,
        'created_by_name', coalesce(nullif(btrim(author.display_name), ''), split_part(author.email, '@', 1)))
        order by rule.created_at desc, rule.method, rule.version desc)
      from (select * from public.payment_surcharge_rules where cohort_id = v_cohort_id
        order by created_at desc, version desc limit 100) rule
      join public.profiles author on author.id = rule.created_by), '[]'::jsonb) end);
end;
$$;

-- Finance sets the rule of one method in the request cohort: a new version, never an edit.
create function public.save_payment_surcharge_rule(
  p_method public.payment_surcharge_method, p_mode public.payment_surcharge_mode, p_rate_bps integer, p_fixed_cents bigint,
  p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_cohort_id uuid := private.cohort_write_id();
  v_reason text := btrim(p_reason);
  v_claim record;
  v_current public.payment_surcharge_rules%rowtype;
  v_rule public.payment_surcharge_rules%rowtype;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if v_cohort_id is null then
    raise exception using errcode = 'P0001', message = 'COHORT_REQUIRED';
  end if;
  if p_correlation_id is null or p_method is null or p_mode is null or v_reason is null
    or char_length(v_reason) not between 3 and 500
    or (p_mode = 'NONE' and (p_rate_bps is not null or p_fixed_cents is not null))
    or (p_mode = 'PERCENTAGE' and (p_rate_bps is null or p_rate_bps not between 1 and 10000 or p_fixed_cents is not null))
    or (p_mode = 'FIXED' and (p_fixed_cents is null or p_fixed_cents not between 1 and 1000000 or p_rate_bps is not null)) then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_SURCHARGE_RULE';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'save_surcharge_rule', v_actor_id), p_idempotency_key,
    jsonb_build_object('cohort_id', v_cohort_id, 'method', p_method, 'mode', p_mode, 'reason', v_reason)
      || jsonb_strip_nulls(jsonb_build_object('rate_bps', p_rate_bps, 'fixed_cents', p_fixed_cents)));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  -- One writer per cohort and method; the unique version is the backstop.
  perform pg_advisory_xact_lock(hashtextextended('payment_surcharge_rule:' || v_cohort_id::text || ':' || p_method::text, 0));
  v_current := private.current_payment_surcharge_rule(v_cohort_id, p_method);
  if coalesce(v_current.mode, 'NONE') = p_mode and v_current.rate_bps is not distinct from p_rate_bps
    and v_current.fixed_cents is not distinct from p_fixed_cents then
    raise exception using errcode = 'P0001', message = 'PAYMENT_SURCHARGE_RULE_UNCHANGED';
  end if;
  insert into public.payment_surcharge_rules (cohort_id, method, version, mode, rate_bps, fixed_cents, reason, created_by, correlation_id)
  values (v_cohort_id, p_method, coalesce(v_current.version, 0) + 1, p_mode, p_rate_bps, p_fixed_cents, v_reason, v_actor_id, p_correlation_id)
  returning * into v_rule;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.surcharge_rule.saved', v_actor_id, 'payment_surcharge_rule', v_rule.id::text, p_correlation_id,
    jsonb_build_object('method', p_method, 'version', v_rule.version, 'mode', p_mode, 'rate_bps', p_rate_bps,
      'fixed_cents', p_fixed_cents, 'reason', v_reason,
      'previous', case when v_current.id is null then null else jsonb_build_object('rule_id', v_current.id,
        'version', v_current.version, 'mode', v_current.mode, 'rate_bps', v_current.rate_bps, 'fixed_cents', v_current.fixed_cents) end));
  v_result := jsonb_build_object('rule_id', v_rule.id, 'method', v_rule.method, 'version', v_rule.version, 'mode', v_rule.mode,
    'rate_bps', v_rule.rate_bps, 'fixed_cents', v_rule.fixed_cents, 'reason', v_rule.reason, 'created_at', v_rule.created_at,
    'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_surcharge_rule', v_rule.id::text);
  return v_result;
end;
$$;

revoke all on function public.list_payment_surcharge_rules(),
  public.save_payment_surcharge_rule(public.payment_surcharge_method, public.payment_surcharge_mode, integer, bigint, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_payment_surcharge_rules(),
  public.save_payment_surcharge_rule(public.payment_surcharge_method, public.payment_surcharge_mode, integer, bigint, text, text, uuid)
  to authenticated;

-- Confirmations -----------------------------------------------------------------------------------------------------
-- Same commands as 20261002120000, plus the acréscimo shown to the customer (p_surcharge_cents) and the optional
-- waiver. Callers that send nothing expect no acréscimo: with an active rule they get PAYMENT_SURCHARGE_CHANGED.

drop function public.complete_reservation_pickup(uuid, public.payment_integration_channel, bigint, text, public.card_payment_method, uuid, text, uuid);
drop function public.confirm_cash_payment(uuid, bigint, text, uuid);
drop function public.confirm_manual_payment(uuid, public.payment_integration_channel, text, public.card_payment_method, uuid, text, uuid);

create function public.confirm_cash_payment(
  p_sale_id uuid, p_tendered_cents bigint, p_idempotency_key text, p_correlation_id uuid,
  p_surcharge_cents bigint default null, p_waive_surcharge boolean default false, p_surcharge_waiver_reason text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_sale public.sales%rowtype; v_attempt public.payment_attempts%rowtype;
  v_shift public.seller_shifts%rowtype; v_claim record; v_stock_result jsonb; v_ledger_id uuid; v_surcharge jsonb;
  v_change bigint; v_confirmed_at timestamptz := clock_timestamp(); v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if p_correlation_id is null or p_tendered_cents is null or p_tendered_cents not between 0 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'INVALID_CASH_PAYMENT';
  end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.created_by <> v_actor_id or v_sale.channel not in ('PDV', 'RESERVA') then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'cash_confirmation', v_actor_id), p_idempotency_key,
    jsonb_build_object('sale_id', p_sale_id, 'tendered_cents', p_tendered_cents)
      || jsonb_strip_nulls(jsonb_build_object('surcharge_cents', p_surcharge_cents,
        'waive_surcharge', case when coalesce(p_waive_surcharge, false) then true end,
        'surcharge_waiver_reason', nullif(btrim(p_surcharge_waiver_reason), ''))));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  if v_sale.status <> 'AWAITING_PAYMENT' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_AWAITING_PAYMENT';
  end if;
  select * into v_shift from public.seller_shifts
  where seller_id = v_actor_id and status = 'OPEN' for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_REQUIRED';
  end if;
  if v_shift.location_id <> v_sale.location_id then
    raise exception using errcode = 'P0001', message = 'SELLER_SHIFT_LOCATION_MISMATCH';
  end if;
  select * into v_attempt from public.payment_attempts
  where sale_id = p_sale_id order by created_at desc, id desc limit 1 for update;
  if not found or v_attempt.operator_id <> v_actor_id then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status <> 'CREATED' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_CONFIRMABLE';
  end if;
  if v_attempt.amount_cents <> v_sale.total_cents then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AMOUNT_MISMATCH';
  end if;
  v_surcharge := private.apply_payment_surcharge(v_sale.id, v_attempt.id, 'DINHEIRO', p_surcharge_cents,
    p_waive_surcharge, p_surcharge_waiver_reason, v_actor_id, p_correlation_id);
  select * into v_attempt from public.payment_attempts where id = v_attempt.id;
  if p_tendered_cents < v_attempt.amount_cents then
    raise exception using errcode = 'P0001', message = 'CASH_TENDERED_INSUFFICIENT';
  end if;
  v_change := p_tendered_cents - v_attempt.amount_cents;

  v_stock_result := private.consume_sale_reservation(v_sale.id, v_actor_id, p_correlation_id);
  update public.payment_attempts
  set status = 'APPROVED', integration_channel = 'DINHEIRO', confirmation_source = 'MANUAL', confirmed_at = v_confirmed_at
  where id = v_attempt.id returning * into v_attempt;
  insert into public.payment_attempt_status_history (attempt_id, from_status, to_status, actor_id, reason, correlation_id)
  values (v_attempt.id, 'CREATED', 'APPROVED', v_actor_id, 'Recebimento em dinheiro registrado no turno', p_correlation_id);
  insert into public.financial_ledger_entries (
    sale_id, payment_attempt_id, entry_type, amount_cents, actor_id, correlation_id, metadata
  ) values (
    v_sale.id, v_attempt.id, 'CASH_RECEIPT', v_attempt.amount_cents, v_actor_id, p_correlation_id,
    jsonb_build_object('integration_channel', 'DINHEIRO', 'confirmation_source', 'MANUAL', 'shift_id', v_shift.id)
      || case when v_surcharge is null then '{}'::jsonb else jsonb_build_object('product_cents', v_sale.total_cents,
        'surcharge_cents', (v_surcharge ->> 'applied_cents')::bigint) end
  ) returning id into v_ledger_id;
  insert into public.cash_movements (
    shift_id, movement_type, amount_cents, sale_id, payment_attempt_id, tendered_cents, change_cents, actor_id, correlation_id
  ) values (
    v_shift.id, 'SALE_RECEIPT', v_attempt.amount_cents, v_sale.id, v_attempt.id, p_tendered_cents, v_change, v_actor_id, p_correlation_id
  );
  v_sale := private.transition_sale_state(v_sale.id, 'CONFIRMED', v_actor_id, p_correlation_id, 'Pagamento em dinheiro recebido');

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.cash.confirmed', v_actor_id, 'payment_attempt', v_attempt.id::text, p_correlation_id,
    jsonb_build_object('sale_id', v_sale.id, 'amount_cents', v_attempt.amount_cents, 'tendered_cents', p_tendered_cents,
      'change_cents', v_change, 'shift_id', v_shift.id, 'financial_ledger_entry_id', v_ledger_id,
      'surcharge_cents', coalesce((v_surcharge ->> 'applied_cents')::bigint, 0)));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('payments.cash.confirmed', 'payment_attempt', v_attempt.id::text,
    jsonb_build_object('attempt_id', v_attempt.id, 'sale_id', v_sale.id, 'shift_id', v_shift.id, 'correlation_id', p_correlation_id));

  v_result := jsonb_build_object(
    'sale_id', v_sale.id, 'sale_status', v_sale.status,
    'payment_attempt', jsonb_build_object('attempt_id', v_attempt.id, 'status', v_attempt.status,
      'amount_cents', v_attempt.amount_cents, 'integration_channel', v_attempt.integration_channel,
      'confirmation_source', v_attempt.confirmation_source, 'confirmed_at', v_attempt.confirmed_at),
    'cash', jsonb_build_object('shift_id', v_shift.id, 'tendered_cents', p_tendered_cents, 'change_cents', v_change),
    'surcharge', v_surcharge,
    'stock', v_stock_result, 'financial_ledger_entry_id', v_ledger_id, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale.id::text);
  return v_result;
end;
$$;

create function public.confirm_manual_payment(
  p_sale_id uuid,
  p_integration_channel public.payment_integration_channel,
  p_proof_reference text,
  p_card_method public.card_payment_method,
  p_terminal_id uuid,
  p_idempotency_key text,
  p_correlation_id uuid,
  p_surcharge_cents bigint default null,
  p_waive_surcharge boolean default false,
  p_surcharge_waiver_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_scope text;
  v_claim record;
  v_stock_result jsonb;
  v_ledger_id uuid;
  v_surcharge jsonb;
  v_confirmed_at timestamptz := clock_timestamp();
  v_result jsonb;
  v_terminal public.payment_terminals%rowtype;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if p_integration_channel not in ('MAQUININHA', 'PIX_AREA') then
    raise exception using errcode = '22023', message = 'MANUAL_PAYMENT_CHANNEL_UNSUPPORTED';
  end if;
  if p_proof_reference is null
    or char_length(p_proof_reference) not between 4 and 128
    or p_proof_reference <> btrim(p_proof_reference)
    or p_proof_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$'
    or p_proof_reference ~ '[0-9]{12,}' then
    raise exception using errcode = '22023', message = 'INVALID_NON_SENSITIVE_PROOF_REFERENCE';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID';
  end if;
  -- Spec 6.7: the Maquininha records its card method; Área Pix has neither method nor terminal.
  if p_integration_channel = 'MAQUININHA' and p_card_method is null then
    raise exception using errcode = '22023', message = 'CARD_METHOD_REQUIRED';
  end if;
  if p_integration_channel = 'PIX_AREA' and (p_card_method is not null or p_terminal_id is not null) then
    raise exception using errcode = '22023', message = 'CARD_DETAILS_NOT_ALLOWED';
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.created_by <> v_actor_id or v_sale.channel not in ('PDV', 'RESERVA') then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_FOUND';
  end if;

  v_scope := private.build_idempotency_scope('payments', 'manual_confirmation', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object(
      'sale_id', p_sale_id,
      'integration_channel', p_integration_channel,
      'proof_reference', p_proof_reference
    ) || jsonb_strip_nulls(jsonb_build_object('card_method', p_card_method, 'terminal_id', p_terminal_id,
      'surcharge_cents', p_surcharge_cents, 'waive_surcharge', case when coalesce(p_waive_surcharge, false) then true end,
      'surcharge_waiver_reason', nullif(btrim(p_surcharge_waiver_reason), '')))
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  if v_sale.status <> 'AWAITING_PAYMENT' then
    raise exception using errcode = 'P0001', message = 'SALE_NOT_AWAITING_PAYMENT';
  end if;
  if p_card_method in ('VOUCHER_ALIMENTACAO', 'VOUCHER_REFEICAO') then
    perform private.require_feature('meal_voucher');
  end if;
  if p_terminal_id is not null then
    select * into v_terminal from public.payment_terminals where id = p_terminal_id for share;
    if not found or not v_terminal.active then
      raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_UNAVAILABLE';
    end if;
  elsif p_integration_channel = 'MAQUININHA' and exists (select 1 from public.payment_terminals where active) then
    -- Once the establishment registers its terminals, every Maquininha payment names one.
    raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_REQUIRED';
  end if;
  select * into v_attempt
  from public.payment_attempts
  where sale_id = p_sale_id
  order by created_at desc, id desc limit 1
  for update;
  if not found or v_attempt.operator_id <> v_actor_id then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status <> 'CREATED' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ATTEMPT_NOT_CONFIRMABLE';
  end if;
  if v_attempt.amount_cents <> v_sale.total_cents then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AMOUNT_MISMATCH';
  end if;
  v_surcharge := private.apply_payment_surcharge(v_sale.id, v_attempt.id,
    private.payment_surcharge_method_for(p_integration_channel, p_card_method), p_surcharge_cents,
    p_waive_surcharge, p_surcharge_waiver_reason, v_actor_id, p_correlation_id);

  v_stock_result := private.consume_sale_reservation(
    v_sale.id, v_actor_id, p_correlation_id
  );

  update public.payment_attempts
  set status = 'AWAITING_EXTERNAL_CONFIRMATION',
      integration_channel = p_integration_channel,
      confirmation_source = 'MANUAL',
      proof_reference = p_proof_reference,
      card_method = p_card_method,
      terminal_id = p_terminal_id
  where id = v_attempt.id;
  insert into public.payment_attempt_status_history (
    attempt_id, from_status, to_status, actor_id, reason, correlation_id
  ) values (
    v_attempt.id, 'CREATED', 'AWAITING_EXTERNAL_CONFIRMATION', v_actor_id,
    'Operador registrou confirmação externa manual', p_correlation_id
  );

  update public.payment_attempts
  set status = 'APPROVED', confirmed_at = v_confirmed_at
  where id = v_attempt.id
  returning * into v_attempt;
  insert into public.payment_attempt_status_history (
    attempt_id, from_status, to_status, actor_id, reason, correlation_id
  ) values (
    v_attempt.id, 'AWAITING_EXTERNAL_CONFIRMATION', 'APPROVED', v_actor_id,
    'Confirmação manual concluída', p_correlation_id
  );

  insert into public.financial_ledger_entries (
    sale_id, payment_attempt_id, entry_type, amount_cents,
    actor_id, correlation_id,
    metadata
  ) values (
    v_sale.id, v_attempt.id, 'RECEIVABLE_PICPAY', v_attempt.amount_cents,
    v_actor_id, p_correlation_id,
    jsonb_build_object(
      'integration_channel', p_integration_channel,
      'confirmation_source', 'MANUAL'
    ) || jsonb_strip_nulls(jsonb_build_object('card_method', p_card_method, 'terminal_id', p_terminal_id))
      || case when v_surcharge is null then '{}'::jsonb else jsonb_build_object('product_cents', v_sale.total_cents,
        'surcharge_cents', (v_surcharge ->> 'applied_cents')::bigint) end
  ) returning id into v_ledger_id;

  v_sale := private.transition_sale_state(
    v_sale.id, 'CONFIRMED', v_actor_id, p_correlation_id,
    'Pagamento manual externo confirmado'
  );

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'payments.manual.confirmed', v_actor_id, 'payment_attempt', v_attempt.id::text,
    p_correlation_id,
    jsonb_build_object(
      'sale_id', v_sale.id,
      'amount_cents', v_attempt.amount_cents,
      'integration_channel', p_integration_channel,
      'confirmation_source', 'MANUAL',
      'card_method', p_card_method,
      'terminal_id', p_terminal_id,
      'financial_ledger_entry_id', v_ledger_id,
      'surcharge_cents', coalesce((v_surcharge ->> 'applied_cents')::bigint, 0)
    )
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'payments.manual.confirmed', 'payment_attempt', v_attempt.id::text,
    jsonb_build_object(
      'attempt_id', v_attempt.id,
      'sale_id', v_sale.id,
      'status', v_attempt.status,
      'integration_channel', p_integration_channel,
      'confirmation_source', 'MANUAL',
      'correlation_id', p_correlation_id
    )
  );

  v_result := jsonb_build_object(
    'sale_id', v_sale.id,
    'sale_status', v_sale.status,
    'payment_attempt', jsonb_build_object(
      'attempt_id', v_attempt.id,
      'status', v_attempt.status,
      'amount_cents', v_attempt.amount_cents,
      'integration_channel', v_attempt.integration_channel,
      'confirmation_source', v_attempt.confirmation_source,
      'confirmed_at', v_attempt.confirmed_at,
      'proof_reference', v_attempt.proof_reference,
      'card_method', v_attempt.card_method,
      'terminal', case when v_terminal.id is null then null
        else jsonb_build_object('id', v_terminal.id, 'code', v_terminal.code, 'label', v_terminal.label) end
    ),
    'surcharge', v_surcharge,
    'stock', v_stock_result,
    'financial_ledger_entry_id', v_ledger_id,
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'sale', v_sale.id::text
  );
  return v_result;
exception
  when unique_violation then
    if sqlerrm like '%payment_attempts_manual_proof_unique%' then
      raise exception using errcode = 'P0001', message = 'PROOF_REFERENCE_ALREADY_USED';
    end if;
    raise;
end;
$$;

-- Atomic pickup: RESERVA sale at the frozen price, paid through the confirmations above (acréscimo included).
create function public.complete_reservation_pickup(
  p_reservation_id uuid,
  p_integration_channel public.payment_integration_channel,
  p_tendered_cents bigint,
  p_proof_reference text,
  p_card_method public.card_payment_method,
  p_terminal_id uuid,
  p_idempotency_key text,
  p_correlation_id uuid,
  p_surcharge_cents bigint default null,
  p_waive_surcharge boolean default false,
  p_surcharge_waiver_reason text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_reservation public.commercial_reservations%rowtype;
  v_claim record;
  v_sale_id uuid := gen_random_uuid();
  v_attempt_id uuid := gen_random_uuid();
  v_payment jsonb;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if p_correlation_id is null or p_integration_channel is null
    or p_integration_channel not in ('DINHEIRO', 'MAQUININHA', 'PIX_AREA')
    or (p_integration_channel = 'DINHEIRO' and p_tendered_cents is null)
    or (p_integration_channel <> 'DINHEIRO' and p_tendered_cents is not null)
    or p_idempotency_key is null or char_length(p_idempotency_key) > 100 then
    raise exception using errcode = '22023', message = 'INVALID_PICKUP_PAYMENT';
  end if;
  select * into v_reservation from public.commercial_reservations where id = p_reservation_id for update;
  if not found or not private.can_operate_location(v_actor_id, v_reservation.location_id) then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('reservations', 'pickup', v_actor_id), p_idempotency_key,
    jsonb_build_object('reservation_id', p_reservation_id, 'integration_channel', p_integration_channel,
      'tendered_cents', p_tendered_cents, 'proof_reference', p_proof_reference, 'card_method', p_card_method,
      'terminal_id', p_terminal_id)
      || jsonb_strip_nulls(jsonb_build_object('surcharge_cents', p_surcharge_cents,
        'waive_surcharge', case when coalesce(p_waive_surcharge, false) then true end,
        'surcharge_waiver_reason', nullif(btrim(p_surcharge_waiver_reason), ''))));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if v_reservation.status <> 'READY' then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_NOT_READY';
  end if;
  if v_reservation.pickup_deadline <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_EXPIRED';
  end if;

  -- The sale reuses the frozen reservation snapshot: no repricing at pickup.
  insert into public.sales (
    id, channel, location_id, created_by, customer_id,
    original_total_cents, discount_total_cents, total_cents, quoted_at, correlation_id
  ) values (
    v_sale_id, 'RESERVA', v_reservation.location_id, v_actor_id, v_reservation.customer_id,
    v_reservation.original_total_cents, v_reservation.discount_total_cents, v_reservation.total_cents,
    (v_reservation.quote_snapshot ->> 'quoted_at')::timestamptz, p_correlation_id
  );
  insert into public.sale_items (
    sale_id, product_id, product_sku, product_name, quantity,
    unit_price_cents, original_subtotal_cents, discount_cents, total_cents, promotion_id, promotion_snapshot
  )
  select v_sale_id, line.product_id, line.product_sku, line.product_name, line.quantity,
    line.unit_price_cents, line.original_subtotal_cents, line.discount_cents, line.total_cents,
    line.promotion_id, line.promotion_snapshot
  from jsonb_to_recordset(v_reservation.quote_snapshot -> 'lines') as line(
    product_id uuid, product_sku text, product_name text, quantity bigint,
    unit_price_cents bigint, original_subtotal_cents bigint, discount_cents bigint,
    total_cents bigint, promotion_id uuid, promotion_snapshot jsonb
  );
  perform private.assert_sale_totals(v_sale_id);
  -- The held stock now belongs to the sale and is consumed by the confirmation right below.
  update public.stock_reservations
  set origin_type = 'sale', origin_id = v_sale_id::text, expires_at = greatest(expires_at, clock_timestamp() + interval '5 minutes')
  where id = v_reservation.stock_reservation_id and status = 'ACTIVE';
  if not found then
    raise exception using errcode = 'P0001', message = 'COMMERCIAL_RESERVATION_STOCK_NOT_ACTIVE';
  end if;
  insert into public.payment_attempts (id, sale_id, amount_cents, operator_id, idempotency_key, correlation_id)
  values (v_attempt_id, v_sale_id, v_reservation.total_cents, v_actor_id, p_idempotency_key, p_correlation_id);
  perform private.transition_sale_state(v_sale_id, 'AWAITING_PAYMENT', v_actor_id, p_correlation_id, 'Retirada de reserva');

  if p_integration_channel = 'DINHEIRO' then
    v_payment := public.confirm_cash_payment(v_sale_id, p_tendered_cents, p_idempotency_key || ':pay', p_correlation_id,
      p_surcharge_cents, p_waive_surcharge, p_surcharge_waiver_reason);
  else
    v_payment := public.confirm_manual_payment(v_sale_id, p_integration_channel, p_proof_reference, p_card_method,
      p_terminal_id, p_idempotency_key || ':pay', p_correlation_id, p_surcharge_cents, p_waive_surcharge, p_surcharge_waiver_reason);
  end if;

  update public.commercial_reservations
  set status = 'COMPLETED', converted_sale_id = v_sale_id, converted_at = clock_timestamp(), completed_at = clock_timestamp()
  where id = v_reservation.id;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('reservations.completed', v_actor_id, 'commercial_reservation', v_reservation.id::text, p_correlation_id,
    jsonb_build_object('sale_id', v_sale_id, 'customer_id', v_reservation.customer_id,
      'total_cents', v_reservation.total_cents, 'integration_channel', p_integration_channel,
      'charged_cents', (v_payment -> 'payment_attempt' ->> 'amount_cents')::bigint));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('reservations.completed', 'commercial_reservation', v_reservation.id::text,
    jsonb_build_object('reservation_id', v_reservation.id, 'customer_id', v_reservation.customer_id,
      'sale_id', v_sale_id, 'correlation_id', p_correlation_id));

  v_result := jsonb_build_object(
    'reservation_id', v_reservation.id, 'status', 'COMPLETED', 'sale_id', v_sale_id,
    'total_cents', v_reservation.total_cents, 'integration_channel', p_integration_channel,
    'charged_cents', (v_payment -> 'payment_attempt' ->> 'amount_cents')::bigint,
    'surcharge', v_payment -> 'surcharge',
    'change_cents', v_payment -> 'cash' -> 'change_cents',
    'card_method', v_payment -> 'payment_attempt' -> 'card_method',
    'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'commercial_reservation', v_reservation.id::text);
  return v_result;
end;
$$;

revoke all on function public.confirm_cash_payment(uuid, bigint, text, uuid, bigint, boolean, text),
  public.confirm_manual_payment(uuid, public.payment_integration_channel, text, public.card_payment_method, uuid, text, uuid, bigint, boolean, text),
  public.complete_reservation_pickup(uuid, public.payment_integration_channel, bigint, text, public.card_payment_method, uuid, text, uuid, bigint, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_cash_payment(uuid, bigint, text, uuid, bigint, boolean, text),
  public.confirm_manual_payment(uuid, public.payment_integration_channel, text, public.card_payment_method, uuid, text, uuid, bigint, boolean, text),
  public.complete_reservation_pickup(uuid, public.payment_integration_channel, bigint, text, public.card_payment_method, uuid, text, uuid, bigint, boolean, text)
  to authenticated;

-- Read models -------------------------------------------------------------------------------------------------------

-- Closeout: confirmed sales are counted at what they charged (product total + applied acréscimo), as the payments.
create or replace function public.create_seller_closeout(
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stock_counts jsonb,
  p_justification text,
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
  v_location_id uuid;
  v_scope text;
  v_claim record;
  v_closeout_id uuid := gen_random_uuid();
  v_sales_count bigint;
  v_sales_total bigint;
  v_payment_count bigint;
  v_payment_total bigint;
  v_payment_difference bigint;
  v_stock_difference bigint;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('closeouts.create') then
    raise exception using errcode = '42501', message = 'SELLER_CLOSEOUT_REQUIRED';
  end if;
  if p_period_start is null or p_period_end is null or p_period_start >= p_period_end
    or p_period_end > clock_timestamp() or p_period_end - p_period_start > interval '7 days' then
    raise exception using errcode = '22023', message = 'INVALID_CLOSEOUT_PERIOD';
  end if;
  if p_correlation_id is null or jsonb_typeof(p_stock_counts) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_CLOSEOUT_INPUT';
  end if;
  if p_justification is not null and (
    char_length(p_justification) not between 4 and 500 or p_justification <> btrim(p_justification)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CLOSEOUT_JUSTIFICATION';
  end if;

  perform 1 from public.profiles where id = v_actor_id and active for update;
  if not found then
    raise exception using errcode = '42501', message = 'SELLER_INACTIVE';
  end if;
  select location.id into v_location_id
  from public.stock_locations location
  where location.seller_id = v_actor_id and location.location_type = 'SELLER' and location.active;
  if v_location_id is null then
    raise exception using errcode = 'P0001', message = 'SELLER_LOCATION_NOT_FOUND';
  end if;

  v_scope := private.build_idempotency_scope('closeouts', 'create', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object(
      'period_start', p_period_start,
      'period_end', p_period_end,
      'stock_counts', p_stock_counts,
      'justification', p_justification
    )
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  if exists (
    select 1 from public.seller_closeouts closeout
    where closeout.seller_id = v_actor_id and closeout.status = 'CLOSED'
      and tstzrange(closeout.period_start, closeout.period_end, '[)')
        && tstzrange(p_period_start, p_period_end, '[)')
  ) then
    raise exception using errcode = 'P0001', message = 'CLOSEOUT_PERIOD_OVERLAP';
  end if;

  if jsonb_array_length(p_stock_counts) <> (
    select count(*) from public.inventory_balances where location_id = v_location_id
  ) or exists (
    select 1
    from jsonb_to_recordset(p_stock_counts) as input(product_id uuid, counted_quantity bigint)
    left join public.inventory_balances balance
      on balance.location_id = v_location_id and balance.product_id = input.product_id
    where balance.id is null or input.counted_quantity is null or input.counted_quantity < 0
  ) or (
    select count(*) from jsonb_to_recordset(p_stock_counts) as input(product_id uuid, counted_quantity bigint)
  ) <> (
    select count(distinct input.product_id) from jsonb_to_recordset(p_stock_counts) as input(product_id uuid, counted_quantity bigint)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CLOSEOUT_STOCK_COUNTS';
  end if;

  select count(*), coalesce(sum(sale.total_cents + coalesce((select sum(surcharge.applied_cents) from public.payment_surcharges surcharge
    where surcharge.sale_id = sale.id), 0)), 0)
  into v_sales_count, v_sales_total
  from public.sales sale
  where sale.created_by = v_actor_id and sale.location_id = v_location_id
    and sale.status = 'CONFIRMED' and sale.updated_at >= p_period_start and sale.updated_at < p_period_end;

  select count(*), coalesce(sum(attempt.amount_cents), 0)
  into v_payment_count, v_payment_total
  from public.payment_attempts attempt
  join public.sales sale on sale.id = attempt.sale_id
  where sale.created_by = v_actor_id and sale.location_id = v_location_id
    and attempt.status in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED')
    and attempt.confirmed_at >= p_period_start and attempt.confirmed_at < p_period_end;

  select coalesce(sum(abs(input.counted_quantity - balance.on_hand_quantity)), 0)
  into v_stock_difference
  from jsonb_to_recordset(p_stock_counts) as input(product_id uuid, counted_quantity bigint)
  join public.inventory_balances balance
    on balance.location_id = v_location_id and balance.product_id = input.product_id;
  v_payment_difference := v_payment_total - v_sales_total;

  if (v_payment_difference <> 0 or v_stock_difference <> 0) and p_justification is null then
    raise exception using errcode = 'P0001', message = 'CLOSEOUT_JUSTIFICATION_REQUIRED';
  end if;

  insert into public.seller_closeouts (
    id, seller_id, location_id, period_start, period_end,
    confirmed_sales_count, confirmed_sales_total_cents,
    payment_count, payment_total_cents, payment_difference_cents,
    stock_difference_units, justification, correlation_id
  ) values (
    v_closeout_id, v_actor_id, v_location_id, p_period_start, p_period_end,
    v_sales_count, v_sales_total, v_payment_count, v_payment_total, v_payment_difference,
    v_stock_difference, p_justification, p_correlation_id
  );

  insert into public.seller_closeout_payment_summaries (
    closeout_id, integration_channel, payment_count, total_cents
  )
  select v_closeout_id, attempt.integration_channel, count(*), sum(attempt.amount_cents)
  from public.payment_attempts attempt
  join public.sales sale on sale.id = attempt.sale_id
  where sale.created_by = v_actor_id and sale.location_id = v_location_id
    and attempt.status in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED')
    and attempt.confirmed_at >= p_period_start and attempt.confirmed_at < p_period_end
    and attempt.integration_channel is not null
  group by attempt.integration_channel;

  insert into public.seller_closeout_stock_counts (
    closeout_id, product_id, expected_quantity, counted_quantity
  )
  select v_closeout_id, balance.product_id, balance.on_hand_quantity, input.counted_quantity
  from jsonb_to_recordset(p_stock_counts) as input(product_id uuid, counted_quantity bigint)
  join public.inventory_balances balance
    on balance.location_id = v_location_id and balance.product_id = input.product_id;

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'closeouts.created', v_actor_id, 'seller_closeout', v_closeout_id::text, p_correlation_id,
    jsonb_build_object(
      'location_id', v_location_id,
      'period_start', p_period_start,
      'period_end', p_period_end,
      'payment_difference_cents', v_payment_difference,
      'stock_difference_units', v_stock_difference
    )
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'closeouts.created', 'seller_closeout', v_closeout_id::text,
    jsonb_build_object(
      'closeout_id', v_closeout_id,
      'seller_id', v_actor_id,
      'location_id', v_location_id,
      'correlation_id', p_correlation_id
    )
  );

  select jsonb_build_object(
    'closeout_id', closeout.id,
    'seller_id', closeout.seller_id,
    'location_id', closeout.location_id,
    'status', closeout.status,
    'period_start', closeout.period_start,
    'period_end', closeout.period_end,
    'confirmed_sales_count', closeout.confirmed_sales_count,
    'confirmed_sales_total_cents', closeout.confirmed_sales_total_cents,
    'payment_count', closeout.payment_count,
    'payment_total_cents', closeout.payment_total_cents,
    'payment_difference_cents', closeout.payment_difference_cents,
    'stock_difference_units', closeout.stock_difference_units,
    'justification', closeout.justification,
    'payment_summaries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'integration_channel', summary.integration_channel,
        'payment_count', summary.payment_count,
        'total_cents', summary.total_cents
      ) order by summary.integration_channel)
      from public.seller_closeout_payment_summaries summary where summary.closeout_id = closeout.id
    ), '[]'::jsonb),
    'stock_counts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', stock.product_id,
        'expected_quantity', stock.expected_quantity,
        'counted_quantity', stock.counted_quantity,
        'difference_quantity', stock.difference_quantity
      ) order by stock.product_id)
      from public.seller_closeout_stock_counts stock where stock.closeout_id = closeout.id
    ), '[]'::jsonb),
    'correlation_id', closeout.correlation_id
  ) into v_result
  from public.seller_closeouts closeout where closeout.id = v_closeout_id;

  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'seller_closeout', v_closeout_id::text
  );
  return v_result;
end;
$$;

-- "Minhas vendas": the charged amount and the acréscimo of each payment.
create or replace function public.list_my_sales(p_filter text default null, p_cursor uuid default null, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_cursor public.sales%rowtype;
  v_rows jsonb;
  v_count integer;
begin
  if v_actor_id is null or not public.has_permission('sales.read.own') or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  if (p_filter is not null and p_filter not in ('PENDING', 'CONFIRMED', 'CANCELLED'))
    or p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_SALES_FILTER';
  end if;
  if p_cursor is not null then
    select * into v_cursor from public.sales where id = p_cursor and created_by = v_actor_id;
    if not found then
      raise exception using errcode = '22023', message = 'INVALID_SALES_CURSOR';
    end if;
  end if;

  with page as (
    select sale.*, attempt.id as attempt_id, attempt.status as attempt_status,
      attempt.integration_channel, attempt.confirmation_source, attempt.confirmed_at,
      attempt.card_method, terminal.code as terminal_code, attempt.amount_cents as attempt_amount_cents,
      surcharge.applied_cents as surcharge_applied_cents, surcharge.waived as surcharge_waived,
      reservation.expires_at as reservation_expires_at,
      case
        when sale.status = 'AWAITING_PAYMENT' then 'AWAITING_PAYMENT'
        when attempt.status = 'RECONCILIATION_PENDING' then 'RECONCILIATION_PENDING'
      end as pending_reason
    from public.sales sale
    left join lateral (
      select * from public.payment_attempts candidate where candidate.sale_id = sale.id
      order by candidate.created_at desc, candidate.id desc limit 1
    ) attempt on true
    left join public.payment_terminals terminal on terminal.id = attempt.terminal_id
    left join public.payment_surcharges surcharge on surcharge.payment_attempt_id = attempt.id
    left join public.stock_reservations reservation
      on reservation.origin_type = 'sale' and reservation.origin_id = sale.id::text and reservation.status = 'ACTIVE'
    where sale.created_by = v_actor_id and sale.channel in ('PDV', 'RESERVA') and sale.status <> 'DRAFT'
      and (p_cursor is null or (sale.created_at, sale.id) < (v_cursor.created_at, v_cursor.id))
      and (p_filter is null
        or (p_filter = 'PENDING' and (sale.status = 'AWAITING_PAYMENT' or attempt.status = 'RECONCILIATION_PENDING'))
        or (p_filter = 'CONFIRMED' and sale.status = 'CONFIRMED')
        or (p_filter = 'CANCELLED' and sale.status = 'CANCELLED'))
    order by sale.created_at desc, sale.id desc
    limit p_limit + 1
  )
  select jsonb_agg(jsonb_build_object(
      'sale_id', page.id, 'status', page.status, 'channel', page.channel, 'created_at', page.created_at, 'location_id', page.location_id,
      'original_total_cents', page.original_total_cents, 'discount_total_cents', page.discount_total_cents,
      'total_cents', page.total_cents, 'pending_reason', page.pending_reason,
      'reservation_expires_at', page.reservation_expires_at,
      'payment', case when page.attempt_id is null then null else jsonb_build_object(
        'attempt_id', page.attempt_id, 'status', page.attempt_status, 'integration_channel', page.integration_channel,
        'confirmation_source', page.confirmation_source, 'confirmed_at', page.confirmed_at,
        'card_method', page.card_method, 'terminal_code', page.terminal_code, 'amount_cents', page.attempt_amount_cents,
        'surcharge_cents', coalesce(page.surcharge_applied_cents, 0), 'surcharge_waived', coalesce(page.surcharge_waived, false)) end,
      'items', (select jsonb_agg(jsonb_build_object('product_name', item.product_name, 'quantity', item.quantity,
          'total_cents', item.total_cents) order by item.product_name, item.id)
        from public.sale_items item where item.sale_id = page.id)
    ) order by page.created_at desc, page.id desc), count(*)
  into v_rows, v_count
  from page;

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(value order by ordinality) from jsonb_array_elements(coalesce(v_rows, '[]'::jsonb)) with ordinality
      where ordinality <= p_limit), '[]'::jsonb),
    'next_cursor', case when v_count > p_limit then (v_rows -> (p_limit - 1)) ->> 'sale_id' end,
    'pending_count', (select count(*) from public.sales sale
      where sale.created_by = v_actor_id and sale.channel in ('PDV', 'RESERVA')
        and (sale.status = 'AWAITING_PAYMENT' or exists (
          select 1 from public.payment_attempts attempt
          where attempt.sale_id = sale.id and attempt.status = 'RECONCILIATION_PENDING'))));
end;
$$;

-- Finance sale detail: the charged amount and the acréscimo snapshot.
create or replace function private.sale_admin_summary(p_sale_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sale_id', sale.id, 'status', sale.status, 'channel', sale.channel, 'created_at', sale.created_at,
    'location_id', sale.location_id, 'location_name', location.name,
    'seller_id', sale.created_by, 'seller_name', coalesce(nullif(btrim(seller.display_name), ''), seller.email),
    'original_total_cents', sale.original_total_cents, 'discount_total_cents', sale.discount_total_cents,
    'total_cents', sale.total_cents,
    'pending_reason', case
      when sale.status = 'AWAITING_PAYMENT' then 'AWAITING_PAYMENT'
      when attempt.status = 'RECONCILIATION_PENDING' then 'RECONCILIATION_PENDING' end,
    'payment', case when attempt.id is null then null else jsonb_build_object(
      'attempt_id', attempt.id, 'status', attempt.status, 'integration_channel', attempt.integration_channel,
      'confirmation_source', attempt.confirmation_source, 'confirmed_at', attempt.confirmed_at,
      'proof_reference', attempt.proof_reference, 'card_method', attempt.card_method, 'terminal_code', terminal.code,
      'amount_cents', attempt.amount_cents, 'surcharge', private.payment_surcharge_json(surcharge)) end
  )
  from public.sales sale
  join public.stock_locations location on location.id = sale.location_id
  join public.profiles seller on seller.id = sale.created_by
  left join lateral (
    select * from public.payment_attempts candidate where candidate.sale_id = sale.id
    order by candidate.created_at desc, candidate.id desc limit 1
  ) attempt on true
  left join public.payment_terminals terminal on terminal.id = attempt.terminal_id
  left join public.payment_surcharges surcharge on surcharge.payment_attempt_id = attempt.id
  where sale.id = p_sale_id;
$$;

-- Indicators (D4): the receipts keep the gross amount the customer paid; the acréscimo inside them is reported apart
-- (product revenue = sale receipts − acréscimo), and the PicPay fee stays the reconciled TAXAS only.
create or replace function private.compute_management_indicators(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
          where current.resolution is null or current.resolution = 'REABERTA'))
    )
  );
end;
$$;
