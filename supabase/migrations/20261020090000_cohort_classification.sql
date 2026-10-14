-- Cohort classification, second step (ADR 0011, decisions of 08/10/2026). Expand only, same technique as
-- 20261019090100: constant defaults (catalogue only, no row rewritten) or an explicit backfill where the cohort is
-- derived. No authorization change yet.
--
-- * Per cohort: suppliers, finance_balance_checks, user_roles (roles are granted per cohort), the new per-cohort flag
--   values and the new cohort ↔ payment terminal association.
-- * Global identity: payment_terminals stays global (a physical device lives across generations); a cohort is
--   authorized to use a terminal through cohort_payment_terminals.
-- * Attribution of global evidence (nullable cohort): PicPay transaction links and statement line resolutions,
--   Payment Link recovery items, refund requests and provider refunds. NULL = not attributed yet; otherwise the cohort
--   of the sale/attempt/entry the evidence was attributed to; the history belongs to Turma 2026. The evidence itself
--   (files, transactions, receivables, statement lines, webhook receipts) stays global and globally unique.
-- * Logs (nullable cohort): audit_logs and outbox_events. NULL = a truly global operation (identity, cohorts,
--   ADMIN_MASTER, global flags, terminal identity, PicPay evidence imports); history before the cohorts is Turma 2026.

set local lock_timeout = '5s';

-- How each registered table is scoped. REQUIRED: always one cohort. SHARED_NULLABLE: global until attributed, then
-- one cohort. MASTER_NULLABLE: one cohort, or NULL for global operations visible only to ADMIN_MASTER/system.
alter table private.cohort_scoped_tables
  add column if not exists mode text not null default 'REQUIRED'
  constraint cohort_scoped_tables_mode_check check (mode in ('REQUIRED', 'SHARED_NULLABLE', 'MASTER_NULLABLE'));

insert into private.cohort_scoped_tables (table_name, domain, mode) values
  ('suppliers', 'procurement', 'REQUIRED'),
  ('finance_balance_checks', 'finance', 'REQUIRED'),
  ('user_roles', 'identity', 'REQUIRED'),
  ('picpay_transaction_links', 'picpay_attribution', 'SHARED_NULLABLE'),
  ('picpay_statement_line_resolutions', 'picpay_attribution', 'SHARED_NULLABLE'),
  ('payment_recovery_items', 'payments', 'SHARED_NULLABLE'),
  ('payment_link_refund_requests', 'payments', 'SHARED_NULLABLE'),
  ('payment_link_provider_refunds', 'payments', 'SHARED_NULLABLE'),
  ('audit_logs', 'audit', 'MASTER_NULLABLE'),
  ('outbox_events', 'infrastructure', 'MASTER_NULLABLE')
on conflict (table_name) do nothing;

-- REQUIRED and logs: every existing row belongs to Turma 2026 (catalogue-only default, no rewrite).
do $$
declare
  v_table text;
begin
  foreach v_table in array array['suppliers', 'finance_balance_checks', 'user_roles', 'audit_logs', 'outbox_events'] loop
    execute format('alter table public.%I add column if not exists cohort_id uuid default %L::uuid', v_table, private.bootstrap_cohort_id());
    if not exists (select 1 from pg_constraint where conname = v_table || '_cohort_id_fkey' and conrelid = format('public.%I', v_table)::regclass) then
      execute format('alter table public.%I add constraint %I foreign key (cohort_id) references public.cohorts (id) not valid', v_table, v_table || '_cohort_id_fkey');
    end if;
  end loop;
end;
$$;

-- Logs: from now on the cohort is set per row (ADR 0011); NULL means global.
alter table public.audit_logs alter column cohort_id drop default;
alter table public.outbox_events alter column cohort_id drop default;

-- Attribution: every existing interpretation of the evidence was made in the books of Turma 2026 (the only cohort), so
-- the history reads as Turma 2026 through a catalogue-only default: no UPDATE, no tuple rewritten, the immutable
-- PicPay links and resolutions stay untouched. From now on there is no default: NULL = not attributed yet, otherwise
-- the guard derives the cohort of the sale/attempt/entry the evidence is attributed to.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['picpay_transaction_links', 'picpay_statement_line_resolutions', 'payment_recovery_items',
    'payment_link_refund_requests', 'payment_link_provider_refunds'] loop
    execute format('alter table public.%I add column if not exists cohort_id uuid default %L::uuid', v_table, private.bootstrap_cohort_id());
    execute format('alter table public.%I alter column cohort_id drop default', v_table);
    if not exists (select 1 from pg_constraint where conname = v_table || '_cohort_id_fkey' and conrelid = format('public.%I', v_table)::regclass) then
      execute format('alter table public.%I add constraint %I foreign key (cohort_id) references public.cohorts (id) not valid', v_table, v_table || '_cohort_id_fkey');
    end if;
  end loop;
end;
$$;

-- Payment terminals: global identity, per-cohort authorization. Every terminal registered so far was registered by
-- Turma 2026 and keeps working there.
create table public.cohort_payment_terminals (
  cohort_id uuid not null default private.bootstrap_cohort_id() references public.cohorts (id),
  terminal_id uuid not null references public.payment_terminals (id),
  active boolean not null default true,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  primary key (cohort_id, terminal_id)
);
create index cohort_payment_terminals_terminal_idx on public.cohort_payment_terminals (terminal_id);
comment on table public.cohort_payment_terminals is
  'Maquininhas autorizadas por turma. A identidade do terminal (payment_terminals) é global e nunca é duplicada.';
alter table public.cohort_payment_terminals enable row level security;
revoke all on public.cohort_payment_terminals from anon, authenticated;
insert into public.cohort_payment_terminals (cohort_id, terminal_id, active, updated_by, updated_at)
select private.bootstrap_cohort_id(), terminal.id, true, terminal.updated_by, terminal.updated_at
from public.payment_terminals terminal
on conflict (cohort_id, terminal_id) do nothing;

-- Feature flags: one global catalogue. GLOBAL flags gate shared infrastructure/accreditation and keep their value
-- in the catalogue; COHORT flags gate a cohort's modules and payment methods, valued per cohort. Classified by the
-- effect found in the code (ADR 0011), not by the name.
alter table public.feature_flags add column if not exists scope text not null default 'COHORT'
  constraint feature_flags_scope_check check (scope in ('GLOBAL', 'COHORT'));
-- The definition guard stamps updated_at on every UPDATE; classifying is not a change of the flag, so the four global
-- rows keep every pre-existing value (only the new column is written).
alter table public.feature_flags disable trigger feature_flags_guard;
update public.feature_flags set scope = 'GLOBAL'
where key in ('payment_link', 'picpay_checkout', 'picpay_tap', 'meal_voucher') and scope <> 'GLOBAL';
alter table public.feature_flags enable trigger feature_flags_guard;

create table public.cohort_feature_flags (
  cohort_id uuid not null default private.bootstrap_cohort_id() references public.cohorts (id),
  key text not null references public.feature_flags (key),
  enabled boolean not null,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  primary key (cohort_id, key)
);
comment on table public.cohort_feature_flags is 'Valor das chaves funcionais de escopo COHORT em cada turma.';
alter table public.cohort_feature_flags enable row level security;
revoke all on public.cohort_feature_flags from anon, authenticated;
insert into public.cohort_feature_flags (cohort_id, key, enabled, updated_by, updated_at)
select private.bootstrap_cohort_id(), flag.key, flag.enabled, flag.updated_by, flag.updated_at
from public.feature_flags flag
where flag.scope = 'COHORT'
on conflict (cohort_id, key) do nothing;

insert into private.cohort_scoped_tables (table_name, domain, mode) values
  ('cohort_payment_terminals', 'payments', 'REQUIRED'),
  ('cohort_feature_flags', 'settings', 'REQUIRED')
on conflict (table_name) do nothing;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['suppliers', 'finance_balance_checks', 'user_roles', 'audit_logs', 'outbox_events',
    'picpay_transaction_links', 'picpay_statement_line_resolutions', 'payment_recovery_items',
    'payment_link_refund_requests', 'payment_link_provider_refunds'] loop
    execute format('alter table public.%I validate constraint %I', v_table, v_table || '_cohort_id_fkey');
  end loop;
end;
$$;
