# ADR 0010 — Payment Link e dinheiro físico

- Status: ACCEPTED
- Data: 2026-09-07
- Aprovação: plano de conclusão v2.2 aprovado pelo responsável pelo projeto.

## Decisão

O primeiro canal online será a API PicPay Payment Link, registrada como `PAYMENT_LINK`. Não reutilizar payloads, identificadores ou autenticação de outro produto Checkout. O ADR 0005 continua exigindo PicPay como único adquirente externo; dinheiro físico é um meio interno, sem provider PicPay fictício.

Dinheiro físico terá conta e método próprios, recebimento, troco calculado em centavos, conferência por vendedor/turno e divergências justificadas. O registro não é recebível PicPay nem liquidação bancária. Permissões, idempotência e efeitos atômicos de estoque/venda/financeiro continuam obrigatórios.

## Contrato oficial verificado

- [Introdução](https://developers-business.picpay.com/payment-link/docs/introduction): geração, consulta, expiração e estorno de links/transações.
- [Autenticação](https://developers-business.picpay.com/payment-link/docs/authentication): OAuth 2.0 client_credentials exclusivamente backend; tokens com validade documentada de cinco minutos.
- [Webhook](https://developers-business.picpay.com/payment-link/docs/webhook): API Key no header `authorization`; não presumir HMAC. A documentação apresenta `event_type` no texto e `event-type` no exemplo; confirmar o contrato efetivo em sandbox antes de ativar. Receipt durável, deduplicação e replay controlado permanecem requisitos internos.
- [Sandbox](https://developers-business.picpay.com/payment-link/docs/sandbox/): homologação segregada, sem transação financeira real.
- [Limitações](https://developers-business.picpay.com/payment-link/docs/sandbox/limitations): retenção limitada e cobertura incompleta de erros; complementar com testes controlados de falhas.

## Condições de implementação e habilitação

Documentação pública disponível não comprova credenciais, habilitação comercial, webhook configurado nem sandbox validado. Nesta revisão houve apenas consulta documental: nenhum segredo foi consultado, criado ou validado e nenhuma chamada financeira foi feita.

Antes de implementar o adapter, capturar os schemas oficiais completos e comprovar criação, consulta, inativação, reembolso e correlação em sandbox. Confirmar comportamento de repetição, múltiplos pagamentos por link, timeout sem resposta e expiração; não inferir idempotência remota. Configurar segredos diretamente nos ambientes governados, nunca em chat/Git.

Persistir intenção local antes de chamar o provedor fora da transação. Retorno do navegador não confirma pagamento. Pagamento tardio, valor divergente ou duplicado gera pendência recuperável sem segunda receita nem venda sem estoque. Reembolso solicitado não equivale a reembolso confirmado; o parcial preserva a venda e os itens não devolvidos. Sorteio concluído conserva sua evidência histórica.

## Consequências

Evoluir contratos de pagamento para URL, link, transação e reembolsos vinculados, sem alterar os canais manuais existentes. Flags online permanecem desligadas até homologação. Tap, V.A./V.R., TEF/SDK, SFTP e Open Finance continuam condicionados às decisões anteriores.
