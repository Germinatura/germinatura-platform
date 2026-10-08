-- Turmas (cohorts): one database and one domain, logically segregated by cohort (docs/adr/0011-cohorts.md).
-- Foundation only: this migration creates the cohort catalogue, the user ↔ cohort membership and the bootstrap
-- cohort "Turma 2026", which owns every operational record that exists today. It changes no authorization: both
-- tables stay closed to anon/authenticated until the cohort authorization context ships.

create type public.cohort_status as enum ('PREPARING', 'ACTIVE', 'ARCHIVED');
create type public.cohort_membership_status as enum ('ACTIVE', 'INACTIVE');

create table public.cohorts (
  id uuid primary key default gen_random_uuid(),
  name text not null constraint cohorts_name_check check (char_length(name) between 3 and 80 and name = btrim(name)),
  year smallint not null constraint cohorts_year_check check (year between 2000 and 2100),
  slug text not null constraint cohorts_slug_check check (slug ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'),
  status public.cohort_status not null default 'PREPARING',
  -- The cohort served to anonymous visitors and joined by new sign-ups. Exactly one, never archived.
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cohorts_year_key unique (year),
  constraint cohorts_slug_key unique (slug),
  constraint cohorts_default_not_archived check (not (is_default and status = 'ARCHIVED'))
);

create unique index cohorts_single_default on public.cohorts (is_default) where is_default;

create trigger cohorts_set_updated_at
before update on public.cohorts
for each row execute function private.set_updated_at();

comment on table public.cohorts is
  'Turmas/gerações. Um único banco e domínio, com segregação lógica e de segurança por turma (ADR 0011).';

-- Bootstrap identifier of "Turma 2026" (docs/operations/cohort-cutover-runbook.md). Fixed and documented so the
-- backfill, the checks and every environment refer to the same row; never generated at runtime.
create function private.bootstrap_cohort_id()
returns uuid
language sql
immutable
set search_path = ''
as $$ select 'c0000000-0000-4000-8000-000000002026'::uuid $$;

insert into public.cohorts (id, name, year, slug, status, is_default)
values (private.bootstrap_cohort_id(), 'Turma 2026', 2026, '2026', 'ACTIVE', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from public.cohorts
    where id = private.bootstrap_cohort_id() and year = 2026 and slug = '2026' and status = 'ACTIVE' and is_default
  ) then
    raise exception 'COHORT_BOOTSTRAP_INCONSISTENT: Turma 2026 is missing or differs from the bootstrap definition';
  end if;
end;
$$;

create table public.user_cohorts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  cohort_id uuid not null references public.cohorts (id),
  status public.cohort_membership_status not null default 'ACTIVE',
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, cohort_id)
);

create index user_cohorts_cohort_status_idx on public.user_cohorts (cohort_id, status);

create trigger user_cohorts_set_updated_at
before update on public.user_cohorts
for each row execute function private.set_updated_at();

comment on table public.user_cohorts is
  'Participação de uma identidade global (profiles) em uma turma. A conta de autenticação nunca é duplicada.';

-- Every identity that exists today participates in Turma 2026, since it was the only cohort.
insert into public.user_cohorts (user_id, cohort_id, status, joined_at)
select profile.id, private.bootstrap_cohort_id(), 'ACTIVE', profile.created_at
from public.profiles profile
on conflict (user_id, cohort_id) do nothing;

-- New identities join the default cohort, as every sign-up did until now.
create function private.join_default_cohort()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_cohorts (user_id, cohort_id)
  select new.id, cohort.id from public.cohorts cohort where cohort.is_default
  on conflict (user_id, cohort_id) do nothing;
  return new;
end;
$$;

create trigger profiles_join_default_cohort
after insert on public.profiles
for each row execute function private.join_default_cohort();

alter table public.cohorts enable row level security;
alter table public.user_cohorts enable row level security;
revoke all on public.cohorts, public.user_cohorts from anon, authenticated;
revoke all on function private.bootstrap_cohort_id() from public, anon, authenticated;
revoke all on function private.join_default_cohort() from public, anon, authenticated;

-- Classification of the tables that belong to a cohort (ADR 0011). Single source for the expansion below, the
-- integrity report and the upgrade check. Tables absent from this list are global, or still undecided and listed
-- in the ADR, and never receive cohort_id by accident.
create table private.cohort_scoped_tables (
  table_name text primary key,
  domain text not null
);

insert into private.cohort_scoped_tables (table_name, domain) values
  ('categories', 'catalog'), ('products', 'catalog'), ('product_prices', 'catalog'), ('product_images', 'catalog'),
  ('product_stock_alerts', 'catalog'),
  ('promotions', 'promotions'), ('promotion_products', 'promotions'), ('promotion_channels', 'promotions'),
  ('promotion_versions', 'promotions'), ('promotion_redemptions', 'promotions'),
  ('promotion_percentage_rules', 'promotions'), ('promotion_fixed_unit_price_rules', 'promotions'),
  ('promotion_quantity_price_rules', 'promotions'), ('promotion_buy_pay_rules', 'promotions'),
  ('promotion_tiered_rules', 'promotions'), ('promotion_tiered_rule_tiers', 'promotions'),
  ('promotion_combo_rules', 'promotions'), ('promotion_combo_components', 'promotions'),
  ('promotion_coupon_rules', 'promotions'),
  ('stock_locations', 'inventory'), ('inventory_balances', 'inventory'), ('inventory_lots', 'inventory'),
  ('inventory_lot_balances', 'inventory'), ('inventory_lot_cost_states', 'inventory'), ('stock_movements', 'inventory'),
  ('stock_movement_items', 'inventory'), ('stock_movement_lot_allocations', 'inventory'),
  ('stock_reservations', 'inventory'), ('stock_reservation_items', 'inventory'), ('inventory_counts', 'inventory'),
  ('inventory_count_items', 'inventory'), ('stock_loss_reports', 'inventory'), ('stock_return_requests', 'inventory'),
  ('seller_stock_transfer_requests', 'inventory'), ('stock_loss_settings', 'inventory'),
  ('purchase_orders', 'procurement'), ('purchase_order_items', 'procurement'), ('purchase_receipts', 'procurement'),
  ('purchase_payable_entries', 'procurement'), ('purchase_payable_settlements', 'procurement'),
  ('sales', 'sales'), ('sale_items', 'sales'), ('sale_status_history', 'sales'), ('sale_attributions', 'sales'),
  ('payment_attempts', 'payments'), ('payment_attempt_status_history', 'payments'),
  ('payment_reconciliations', 'payments'), ('financial_ledger_entries', 'payments'),
  ('payment_link_charges', 'payments'), ('payment_link_charge_events', 'payments'),
  ('seller_shifts', 'cash'), ('cash_movements', 'cash'), ('seller_closeouts', 'cash'),
  ('seller_closeout_payment_summaries', 'cash'), ('seller_closeout_stock_counts', 'cash'),
  ('finance_manual_entries', 'finance'), ('finance_opening_positions', 'finance'),
  ('finance_opening_position_lines', 'finance'), ('fundraising_goal', 'finance'),
  ('commercial_reservations', 'reservations'), ('reservation_attributions', 'reservations'),
  ('reservation_settings', 'reservations'),
  ('raffle_campaigns', 'raffles'), ('raffle_numbers', 'raffles'), ('raffle_draws', 'raffles'),
  ('raffle_sale_buyers', 'raffles'), ('raffle_sale_refunds', 'raffles'),
  ('portal_events', 'communication'), ('portal_highlights', 'communication'), ('announcements', 'communication'),
  ('announcement_recipients', 'communication'), ('share_campaigns', 'communication'), ('share_visits', 'communication')
on conflict (table_name) do nothing;

alter table private.cohort_scoped_tables enable row level security;
revoke all on private.cohort_scoped_tables from public, anon, authenticated;
