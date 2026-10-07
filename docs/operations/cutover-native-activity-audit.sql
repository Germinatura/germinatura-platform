-- Read-only audit: native Germinatura financial activity on one São Paulo day (run in the Supabase SQL editor).
-- Used before the PicPay cutover to confirm that a day can be treated entirely as bank history (no double count).
-- Change the day below; nothing is written.
with params as (select date '2026-10-06' as day),
bounds as (
  select day, (day::timestamp at time zone 'America/Sao_Paulo') as starts, ((day + 1)::timestamp at time zone 'America/Sao_Paulo') as ends
  from params
)
select 'sales created' as record, count(*) as records, coalesce(sum(total_cents), 0) as amount_cents
from public.sales, bounds where created_at >= starts and created_at < ends
union all
select 'payment attempts approved or reconciled', count(*), coalesce(sum(amount_cents), 0)
from public.payment_attempts, bounds where created_at >= starts and created_at < ends and status in ('APPROVED', 'RECONCILED', 'RECONCILIATION_PENDING')
union all
select 'ledger: ' || entry_type::text, count(*), coalesce(sum(amount_cents), 0)
from public.financial_ledger_entries, bounds where created_at >= starts and created_at < ends group by entry_type
union all
select 'ledger entries (total)', count(*), coalesce(sum(amount_cents), 0)
from public.financial_ledger_entries, bounds where created_at >= starts and created_at < ends
union all
select 'supplier payments (total)', count(*), coalesce(sum(amount_cents), 0)
from public.purchase_payable_settlements, bounds where effective_on = day
union all
select 'manual entries (total)', count(*), coalesce(sum(amount_cents), 0)
from public.finance_manual_entries, bounds where occurred_on = day
union all
select 'payment reconciliations', count(*), coalesce(sum(observed_amount_cents), 0)
from public.payment_reconciliations, bounds where created_at >= starts and created_at < ends
union all
select 'supplier payments (' || entry_type || ', ' || case when payment_method ilike '%dinheiro%' then 'dinheiro' else 'PicPay' end || ')', count(*), coalesce(sum(amount_cents), 0)
from public.purchase_payable_settlements, bounds where effective_on = day group by entry_type, payment_method ilike '%dinheiro%'
union all
select 'manual entries (' || kind::text || ', ' || account::text || ')', count(*), coalesce(sum(amount_cents), 0)
from public.finance_manual_entries, bounds where occurred_on = day group by kind, account
union all
select 'cash drawer movements', count(*), coalesce(sum(amount_cents), 0)
from public.cash_movements, bounds where created_at >= starts and created_at < ends
union all
select 'PicPay statement imports', count(*), coalesce(sum(inflow_cents - outflow_cents), 0)
from public.picpay_statement_imports, bounds where created_at >= starts and created_at < ends
union all
select 'opening positions recorded', count(*), 0 from public.finance_opening_positions
union all
select 'balance checks recorded', count(*), 0 from public.finance_balance_checks
order by 1;
