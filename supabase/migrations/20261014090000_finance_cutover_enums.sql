-- Spec 5.8 (FIN-002, FIN-007): values used by the PicPay cutover. Enum values are added in a migration of their
-- own because PostgreSQL does not let the transaction that adds a value use it.
--   RECEITA_HISTORICA  money the commission really raised before the operation moved to the Germinatura
--                      (statement lines dated before operating_since). Never a sale, never the opening balance.
--   VINCULADA          an imported line whose effect is already in an existing record (supplier payment or manual
--                      entry); the line adds nothing of its own.
alter type public.finance_category add value if not exists 'RECEITA_HISTORICA';
alter type public.picpay_statement_resolution add value if not exists 'VINCULADA';
