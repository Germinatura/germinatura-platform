# Runbook — Link de pagamento PicPay (Payment Link)

Decisão: ADR 0010. Requisitos: PAY-004 e PAY-007. Estado: fundação implementada e **desligada** (flag `payment_link` = off); homologação em sandbox pendente.

## Como funciona

1. O vendedor pede o link para uma venda pendente (`request_payment_link`). A intenção fica gravada (`payment_link_charges`, status `REQUESTED`) antes de qualquer chamada ao PicPay. Só existe um link aberto por tentativa de pagamento.
2. O worker `germinatura-jobs` (único serviço com credenciais PicPay) pega os pedidos a cada minuto, cria o link (`POST /paymentlink/create`) e grava o resultado (`ACTIVE`). Recusa definitiva vira `FAILED` (pode pedir de novo). Timeout, falha de rede, 5xx ou resposta ilegível viram `UNCERTAIN`: o link pode existir, então nada é recriado automaticamente e o financeiro recebe um item de recuperação.
3. O PicPay envia o webhook para o worker. O worker confere a API Key do header `authorization` (comparação em tempo constante), grava o corpo bruto e imutável (`payment_webhook_receipts`) e o banco aplica uma única vez por transação e status. Pagamento confirmado gera os mesmos efeitos dos meios manuais: baixa da reserva de estoque, `RECEIVABLE_PICPAY`, venda `CONFIRMED`, tentativa `APPROVED` com origem `WEBHOOK`.
4. Link desconhecido, valor diferente, pagamento depois da expiração, segundo pagamento, estorno confirmado e formato não reconhecido não geram receita: abrem itens em `payment_recovery_items`. O financeiro pode reprocessar um recibo (`replay_payment_webhook_receipt`) e encerrar um item com justificativa (`resolve_payment_recovery_item`).

Sem configuração completa o worker não pega pedidos e o endpoint do webhook responde 503 (fail-closed). Com a flag desligada, `request_payment_link` recusa com `FEATURE_DISABLED`.

## Credenciais e configurações necessárias

Nenhum valor abaixo deve ser enviado por chat nem versionado. Todos são configurados como **Secret** no worker de jobs (Cloudflare → Workers & Pages → `germinatura-jobs-staging` → Settings → Variables and Secrets → Add → tipo *Secret*), ou pelo terminal de quem tem acesso à conta Cloudflare:

```bash
pnpm --filter @germinatura/jobs exec wrangler secret put PICPAY_PAYMENT_LINK_CLIENT_ID --env staging
```

| Nome | Valor para o sandbox | Onde obter |
| --- | --- | --- |
| `PICPAY_PAYMENT_LINK_TOKEN_URL` | `https://api.ms.qa.limbo.work/oauth2/token` | Documentação oficial, página "Configuração" do sandbox |
| `PICPAY_PAYMENT_LINK_API_BASE_URL` | `https://api.ms.qa.limbo.work/sandbox/v1` | Idem |
| `PICPAY_PAYMENT_LINK_CLIENT_ID` | client_id de sandbox | Painel Lojista → Integrações → Credenciais Sandbox → card "Link de pagamento" → Gerar |
| `PICPAY_PAYMENT_LINK_CLIENT_SECRET` | client_secret de sandbox (exibido uma única vez) | Mesmo lugar |
| `PICPAY_PAYMENT_LINK_WEBHOOK_KEY` | API Key do webhook | Painel Lojista → Configurações → Meu checkout → URL de notificação → Salvar alterações |

Os cinco valores são Secrets (não *Text*) para que um `wrangler deploy` não os apague. As URLs de produção não são publicadas na documentação pública para os endpoints `/paymentlink` (só o token: `https://ecommerce-api.svc.picpay.com/oauth2/token`); confirmar com o PicPay antes da produção. Nada aqui usa credenciais genéricas publicadas em exemplos.

URL de notificação a cadastrar no Painel Lojista (HTTPS, sem query string, sem IP):

`https://germinatura-jobs-staging.germinatura.workers.dev/webhooks/picpay/payment-link`

Gerar uma nova credencial revoga a anterior em 7 dias; guardar o `client_secret` em cofre antes de fechar a tela.

## Verificação automática do sandbox (sem webhook)

O workflow manual **Payment Link Sandbox Check** (GitHub Actions → Payment Link Sandbox Check → Run workflow) chama `POST /diagnostics/payment-link-sandbox` no worker de staging, autenticado pelo segredo do Supabase que o workflow já recebe.

- **Recusas:** o worker só roda se as URLs configuradas forem exatamente as do sandbox; caso contrário responde 409. Não grava nada no banco e mostra apenas quais configurações existem (sim/não) e o resultado de cada passo.
- **Passos:** OAuth; link inexistente (404); transações vazias; falha de transações (500); criação de um link de R$ 1,00; consulta; transações do link; inativação duas vezes (a segunda prova a idempotência); consulta após inativar; estorno aceito e estorno recusado, com os IDs de teste documentados.

Ele não cobre o webhook nem um pagamento real, porque o sandbox não simula o pagamento do cliente.

## Homologação no sandbox (antes de ligar a flag)

1. Configurar os cinco Secrets no worker de staging e conferir `GET /health` do worker.
2. Ligar `payment_link` somente em staging (Administração → flags) e pedir um link para uma venda de teste no PDV.
3. Confirmar no log do worker `payment_link.webhook.received` e, no banco, venda `CONFIRMED` com `RECEIVABLE_PICPAY` único.
4. Validar os pontos que a documentação deixa em aberto:
   - nome efetivo do header do tipo de evento (`event_type` ou `event-type`);
   - se o sandbox envia webhook (a página do sandbox lista só criação, consulta e estorno);
   - se `paymentLinkId` do webhook é o último segmento de `link` da criação (a página de cenários de teste indica que sim);
   - formato de `expired_at` (data) e o horário em que o link expira nesse dia;
   - comportamento de repetição da criação (a API não documenta idempotência);
   - se um link aceita vários pagamentos (`maxPaymentQuantity`);
   - `allow_create_pix_key` (enviado como `false`) e `card_max_installment_number` (enviado como 1).
5. Exercitar os IDs de teste do sandbox (link inexistente, falha ao buscar transações, estorno com sucesso/erro).
6. Desligar a flag ao final se algum ponto divergir e registrar o resultado no ADR 0010.

## Operação

- Itens de recuperação: `list_payment_recovery_items` (financeiro). `UNCERTAIN_CREATION` pede conferência no painel PicPay antes de gerar outro link; `DUPLICATE_PAYMENT`/`LATE_PAYMENT` pedem decisão de estorno; `REFUND_CONFIRMED` pede a reversão correspondente da venda.
- Reprocessar um recibo depois de corrigir a causa: `replay_payment_webhook_receipt`. Recibo já aplicado não muda nada.
- Rotação da API Key do webhook: salvar a nova no painel e atualizar `PICPAY_PAYMENT_LINK_WEBHOOK_KEY` em seguida; entregas no intervalo recebem 401 e o PicPay reenvia.
