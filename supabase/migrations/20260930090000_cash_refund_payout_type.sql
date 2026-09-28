-- PAY-009a: physical cash handed back from a seller drawer when a confirmed cash sale is refunded.
alter type public.cash_movement_type add value if not exists 'REFUND_PAYOUT';
