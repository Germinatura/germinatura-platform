-- Commit the enum value separately so the next migration can use it safely.
alter type public.promotion_rule_type add value if not exists 'COMBO_MIX';
