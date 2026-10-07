-- Spec 5.8 (FIN-001, FIN-002, FIN-003, FIN-007): values of the PicPay reconciliation across the three official exports
-- of PicPay Empresas (Minhas vendas, Recebíveis and Extrato). Enum values live in a migration of their own because
-- PostgreSQL does not let the transaction that adds a value use it.
--   picpay_source_type          which export a file is, detected from its header, never from its name
--   picpay_transaction_status   Aprovada, Negada and Devolvida as PicPay reports them; anything else is OUTRO
--   picpay_payment_kind         Pix, credit, debit, PicPay wallet or another method
--   CONCILIADA_PICPAY           a statement line explained by the acquirer evidence (a historical Pix received or
--                               refunded): a transfer between the Pix clearing account and PicPay Empresas, never revenue
create type public.picpay_source_type as enum ('PICPAY_SALES', 'PICPAY_RECEIVABLES', 'PICPAY_STATEMENT');
create type public.picpay_transaction_status as enum ('APROVADA', 'NEGADA', 'DEVOLVIDA', 'OUTRO');
create type public.picpay_payment_kind as enum ('PIX', 'CREDITO', 'DEBITO', 'PICPAY', 'OUTRO');
alter type public.picpay_statement_resolution add value if not exists 'CONCILIADA_PICPAY';
