-- FIN-007: PicPay "Cofrinho" (money set aside inside PicPay) is a treasury account of its own. Moving money
-- between it and the PicPay Empresas account is a transfer, never revenue or expense.
alter type public.finance_account add value if not exists 'COFRINHO_PICPAY';
