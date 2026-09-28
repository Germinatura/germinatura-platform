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
| PDV | Checkout, confirmação Maquininha/Área Pix, dinheiro físico com turno, troco e devolução física no estorno (PAY-009a), conferência financeira dos turnos, fechamento e PWA read-only | Método/terminal e dispositivos reais ("Minhas vendas"/pendências em PR) | 5 |
| Financeiro | Recebível/taxa/liquidação/divergência e reversão de venda comum transacionais; contas a pagar parciais/reversíveis integradas em staging | Contas/categorias gerais, despesas/importação/CSV e custo real consolidado nos relatórios | 3, 6 |
| Reservas | Backend ACTIVE/CONVERTED/CANCELLED/EXPIRED e consulta/cancelamento próprio | Compra/pagamento, preparação, pronta retirada e entrega | 8 |
| Rifas | Reserva concorrente, financeiro, criação/encerramento/sorteio e consultas | Compra consumidor/PDV, publicação/pausa/cancelamento e reembolso específico | 8 |
| Indicadores | Resumo explícito de 100 vendas recentes e contagens operacionais | Relatórios integrais por período, conciliação, custo/margem/perdas/meta | 9 |
| Operação assíncrona | Worker claim/lease/retry/ack e expiração; notificações in-app | Alertas, retenção, restore ensaiado, preferências/avise-me/segmentação | 9–11 |
| Pagamentos online | Documentação pública Payment Link verificada; contrato neutro no repo | Adapter, receipt e sandbox real não implementados/validados | 7 |
| Campanhas operacionais (Marco 1) | Sem jornada completa | Vitrine, campanhas/eventos, links/QR e atribuição ligados a cardápio, pedidos, reservas e vendas | 10 |
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
