# Diagnóstico v2.2 — estado atual e conclusão

Auditoria atualizada em 28/09/2026: `main=95c4209`, `develop=1476741`; `main` é ancestral de `develop` desde a PR #75. As PRs #78–#82 integraram percentual, preço fixo, PROMO-004, leve/pague, a estabilização do E2E de checkout e a escalonada. A PR #73 integrou em staging a rastreabilidade por lote/local, custo consumido e histórico de movimentos (homologação física pendente). A PR #74 integrou a administração transacional de `QUANTIDADE_PRECO`. A PR #76 tornou o RBAC fail-closed. Produção não foi acessada.

A [matriz de requisitos](REQUIREMENTS_MATRIX.md) é a referência detalhada de evidência por camada; o [roadmap](ROADMAP.md) define ordem e critérios. O diagnóstico anterior misturava auditoria de agosto com incrementos de setembro e foi substituído por esta base explícita.

| Área | Evidência atual | Lacuna real | Marco |
| --- | --- | --- | --- |
| Identidade | Cadastro verificado, credenciais, papéis, revogação, bootstrap e recuperação; gestão de usuários em staging | Homologação SMTP/bootstrap; UI de desbloqueio, conta/sessões e handoff seguro Portal→PDV | 9, 11 |
| Catálogo | Categorias, produtos, preços, imagens Storage e GET anônimo integrados | Smoke autenticado de uma oferta completa em staging | 1 |
| Estoque | Ledger, saldo/localizações, reservas, distribuição, transferência com aceite, devolução, perdas, inventário físico, ajustes aprovados e “Meu estoque” integrados em staging | Homologação física da rastreabilidade por lote | 2, 3, 11 |
| Compras | Fornecedores, pedidos, recebimento parcial e liquidação/reversão de obrigações integrados em staging; lote opcional conforme produto | Rastreabilidade integrada; homologar fisicamente e consolidar custo nos indicadores | 3 |
| Pricing | QUANTIDADE_PRECO (PR #74), PERCENTUAL e VALOR_FIXO_UNITARIO (PR #78), LEVE_PAGUE (PR #80), ESCALONADA (PR #82), COMBO_MIX (PR #84) e CUPOM na cotação, checkout e administração versionada; política PROMO-004 | Homologação autenticada das jornadas de cupom e limites em staging | 4 |
| PDV | Checkout, confirmação Maquininha/Área Pix, dinheiro físico com turno, troco e devolução física no estorno (PAY-009a), conferência financeira dos turnos, "Minhas vendas"/pendências, fechamento e PWA read-only | Dispositivos reais | 5 |
| Financeiro | Recebível/taxa/liquidação/divergência e reversão de venda comum transacionais; contas a pagar parciais/reversíveis integradas em staging; consulta de vendas e estorno pela tela Financeiro › Vendas (#91); plano de categorias, contas e lançamentos manuais auditados (#92); extrato consolidado com CSV (em PR) | Contas/categorias gerais, despesas/importação/CSV e custo real consolidado nos relatórios | 3, 6 |
| Reservas | Backend ACTIVE/CONVERTED/CANCELLED/EXPIRED e consulta/cancelamento próprio | Compra/pagamento, preparação, pronta retirada e entrega | 8 |
| Rifas | Reserva concorrente, financeiro, sorteio auditável, ciclo de vida completo e privacidade dos compradores | Compra consumidor/PDV e estorno de rifa paga | 8 |
| Indicadores | Resumo explícito de 100 vendas recentes e contagens operacionais | Relatórios integrais por período, conciliação, custo/margem/perdas/meta | 9 |
| Operação assíncrona | Worker claim/lease/retry/ack e expiração; notificações in-app | Alertas, retenção, restore ensaiado, preferências/avise-me/segmentação | 9–11 |
| Pagamentos online | Payment Link: intenção, adapter pela OpenAPI oficial, webhook no worker, recibos, deduplicação, recuperação, replay, inativação, consulta periódica, estorno pelo provedor e reconciliação de incertezas (flag desligada); Secrets de sandbox configurados no worker de staging | Telas do vendedor, do financeiro e do consumidor; validação no sandbox; webhook bloqueado externamente (o painel PicPay atual não mostra "Meu checkout / URL de notificação", sem API Key); API do sandbox indisponível em 29/09/2026 (OAuth funciona; consultas sem resposta e criação/estorno com HTTP 502 do gateway PicPay) | 7 |
| Campanhas operacionais (Marco 1) | Código completo: avisos, preferências/avise-me, divulgação rastreável, eventos e campanhas (EVT-001), vitrine do Início (VIT-001) e atribuição de vendas pagas e do PDV com links por vendedor (GROW-002) | Segmentação por turma (depende de cadastro de turmas) e cards automáticos (condicionais) | 10 |
| Rede Social Germinare (Marco 2) | Fora do Marco 1 por decisão de 28/09/2026 | Mural, posts, comentários, sugestões, enquetes, denúncias e moderação, depois do site operacional em produção | Marco 2 |

## Divergências resolvidas documentalmente

- DOCX login por código → ADR 0009/PRD/código credenciais: preservar a decisão posterior; código verifica cadastro/recuperação, login usa senha.
- Roadmap DONE de catálogo/estoque/promoções/financeiro → código parcial: decompor fundação e jornada; nenhuma tela de consulta comprova escrita operacional.
- Declarações antigas de staging bloqueado e apps shells → CI/deploy e interfaces atuais: removidas; os gates humanos ainda não comprovados continuam pendentes.
- Checkout genérico → documentação fornecida de Payment Link: registrar produto e contratos próprios no ADR 0010, sem inventar merchantChargeId nesse produto.
- Provider PicPay para todos os pagamentos → dinheiro físico aprovado: adquirência externa continua PicPay; caixa interno recebe identidade própria.
- Congelamento 10/09 e lançamento 11/09 → plano aprovado de conclusão não opcional por marcos; sem nova data artificial.

## Estratégia de redução do caminho crítico

Estoque/compras, promoções, pagamentos/financeiro, Portal consumidor/crescimento e gestão/qualidade avançam em trilhas paralelas com contratos explícitos. Custos e promoções desbloqueiam mais jornadas e entram antes das telas dependentes. Intenção de pagamento, receipt, deduplicação e adapter fail-closed avançam antes das credenciais; sandbox real continua sendo gate externo. Homologação acompanha cada merge em staging para evitar concentrar concorrência, acessibilidade, performance, dispositivos e restore no final.

## Bloqueios e riscos

Habilitação, credenciais e execução de sandbox ainda não foram comprovadas; não acessar segredos para produzir evidência documental. Confirmar schemas completos e comportamento de timeout/múltiplos pagamentos por link antes de ativar. Materiais públicos não autorizam integrações privadas de Tap/TEF/SDK, nem V.A./V.R. sem credenciamento.

Quarenta e sete migrations formam o schema integrado atual (a mais recente é `20260929090100_promotion_coupons_limits.sql`); a consolidação acrescenta uma migration que remove as funções `get_pricing_quote_inputs` v1–v4, sem tabelas ou dados. Promoção requer revisão cumulativa, sem reset/seeds de produção. Greenfield não autoriza apagar o histórico que vier a ser criado. Preservar restituições por evento compensatório e elegibilidade histórica de sorteios.

## Dívidas técnicas a resolver antes do release candidate

Registradas em 30/09/2026; cada uma em PR própria antes do RC, sem bloquear as entregas em andamento.

- **Taxas de maquininha que sobram em Recebíveis (registrada em 05/10/2026, resolvida em 07/10/2026):** a transação de Minhas vendas vinculada à venda do PDV lança a taxa real (tarifa, custo fixo e taxa de parcelamento) em Taxas, saindo de Recebíveis PicPay. Recebíveis fica com o líquido que o PicPay vai pagar. Venda sem transação vinculada continua com o bruto em Recebíveis e aparece como pendência "Venda do PDV sem transação PicPay".
- **Liquidação em dobro de venda na maquininha (registrada em 05/10/2026, resolvida em 07/10/2026):** `reconcile_payment_attempt`, a função por trás de `POST /api/v1/payments/:id/reconciliations`, recusa tentativas `MAQUININHA` e `TAP` com `PAYMENT_RECONCILIATION_PICPAY_ONLY`. Vale também para chamada direta ao banco e para a origem `IMPORT`. Esses canais são liquidados só pela Conciliação PicPay. Conciliações antigas não mudam, e Área Pix e pagamentos online seguem aceitos.
- **Liquidação nativa sem recebível interno (registrada em 05/10/2026, detectada em 07/10/2026):** Recebíveis de venda continua sendo transferência automática depois de `operating_since`. A liquidação por dia compara o Extrato com o líquido esperado em Minhas vendas e mostra Excedente ou "Liquidação sem explicação" quando falta recebível. `finance_balances` continua apontando conta negativa.
- **Saldo dependia da classificação (registrada e resolvida em 07/10/2026):** linhas do Extrato a revisar não entravam no saldo, e o saldo livre calculado ficava acima do banco exatamente pelo líquido delas (homologação: 30 Pix enviados e 2 devolvidos, R$ 12.389,07). A migration `20261018090000` faz toda linha canônica mover a conta uma vez desde a importação, e a classificação só dá a categoria. Também separa pendência de linha: `EXTRATO_NAO_CLASSIFICADO` não pode ser silenciada, e o status do período exige zero linhas a revisar. Decisões manuais antigas continuam como histórico.
- **Importação antiga só do Extrato (registrada e resolvida em 07/10/2026):** a migration `20261017090000` removeu `import_picpay_statement` e `preview_picpay_statement`. Os testes passaram a usar `import_picpay_file`, e a Conciliação PicPay é o único caminho de importação. As importações já gravadas continuam legíveis.

- **Testes unitários do Portal fora da CI (resolvida em 30/09/2026):** o `pnpm test:unit` da raiz passou a incluir `apps/portal/**/*.test.ts`, com `.next`, `dist` e `node_modules` excluídos. Os testes do Portal rodam na CI pelo vitest da raiz, sem depender do ambiente do Vinext.
- **E2E foundation com estado compartilhado (resolvida em 30/09/2026):** em banco recém-resetado, a suíte `e2e/foundation.spec.ts` foi rodada sozinha e sem retries. O fechamento do vendedor não depende mais de sobras de outras suítes, e o checkout prepara o próprio estoque. As falhas que restavam eram de tempo: cadastro e recuperação dependem do envio do código por e-mail e da primeira compilação das páginas. Essas duas jornadas ganharam folga de navegação (45 s) e de teste (3 min).
  - **Pendente para o RC:** algumas E2E de outras suítes ainda podem se afetar em retries, quando uma tentativa deixa dados que a seguinte encontra (visto em `seller-stock-transfers` na CI do #119). Os seletores novos esperam pela resposta filtrada, e novos casos devem seguir essa prática.
