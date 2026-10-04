-- Enum values used by 20261007090100_raffle_lifecycle.sql, committed before any function uses them.
alter type public.raffle_campaign_status add value if not exists 'DRAFT';
alter type public.raffle_campaign_status add value if not exists 'PAUSED';
