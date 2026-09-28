-- PAY-009: physical cash is an internal channel, never a PicPay product. Commit the enum values first.
alter type public.payment_integration_channel add value if not exists 'DINHEIRO';
alter type public.financial_ledger_entry_type add value if not exists 'CASH_RECEIPT';
