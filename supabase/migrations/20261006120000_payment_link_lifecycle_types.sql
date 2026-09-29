-- Enum values used by 20261006120100_payment_link_lifecycle.sql; added in their own migration so they are
-- committed before any function uses them.
alter type public.payment_recovery_kind add value if not exists 'INACTIVATION_FAILED';
alter type public.payment_recovery_kind add value if not exists 'REFUND_UNCERTAIN';
create type public.payment_link_refund_status as enum ('REQUESTED', 'ACCEPTED', 'CONFIRMED', 'FAILED', 'UNCERTAIN');
