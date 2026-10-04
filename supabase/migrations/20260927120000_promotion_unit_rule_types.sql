-- Commit enum values separately so later migrations can safely use them.
alter type public.promotion_rule_type add value if not exists 'PERCENTUAL';
alter type public.promotion_rule_type add value if not exists 'VALOR_FIXO_UNITARIO';
