-- Supabase Free (docs/operations/supabase-free-performance.md): the jobs Worker claims outbox events and reads
-- the outbox metrics every minute, with or without traffic. Published events stay in the table, so without these
-- indexes each claim and each metric count read the whole table. With them, the claim's two branches (pending and
-- due, or processing with an expired lease) are found through partial indexes and combined, and every metric is an
-- index scan. Claim order, lease recovery, retries and the metrics themselves are unchanged.
create index outbox_events_processing_lease_idx
  on public.outbox_events (locked_at) where status = 'PROCESSING';
create index outbox_events_failed_idx
  on public.outbox_events (created_at) where status = 'FAILED';
