-- Supabase Free (docs/operations/supabase-free-performance.md): indexes for lookups the hot paths make, and no
-- more double maintenance of identical indexes on tables written by every transaction.

-- Every sale status change (confirmation, cancellation) and every reservation cancel, expiry or conversion runs a
-- trigger that updates the redemptions of that sale or reservation. The unique keys lead with promotion_id, so
-- those updates read the whole table.
create index promotion_redemptions_sale_id_idx
  on public.promotion_redemptions (sale_id) where sale_id is not null;
create index promotion_redemptions_reservation_id_idx
  on public.promotion_redemptions (reservation_id) where reservation_id is not null;

-- The per-minute raffle expiry and the raffle confirmation, refund and handover paths look numbers up by sale;
-- the existing index leads with campaign_id.
create index raffle_numbers_sale_id_idx
  on public.raffle_numbers (sale_id) where sale_id is not null;

-- 20261009150000_audit_explorer created these under new names with `if not exists`, next to identical indexes
-- that already existed. The originals stay and keep serving the audit explorer's correlation lookups.
drop index public.audit_logs_correlation_idx;
drop index public.stock_movements_correlation_idx;
drop index public.financial_ledger_entries_correlation_idx;
drop index public.sales_correlation_idx;
