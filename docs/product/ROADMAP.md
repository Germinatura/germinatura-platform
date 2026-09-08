# Roadmap oficial — conclusão Germinatura v2.2

Replanejado em 07/09/2026 pelo plano aprovado. Substitui congelamento em 10/09 e promoção em 11/09 por marcos de aceite, sem nova promessa de data. Fonte: especificação v2.2, PRD e ADRs 0001–0010. A matriz em [REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md) distingue backend, interface, testes, staging e produção.

Estados: `TODO`, `IN PROGRESS`, `BLOCKED`, `DONE`. DONE exige jornada completa, testes e homologação do marco. Um backend integrado não torna o módulo inteiro concluído. Integração indisponível não conta como implementação.

## Base auditada

`main` em `95c4209`: fundação, catálogo público, ledger, reserva técnica e pricing. `develop` em `8e11422`: vendas, confirmação manual, financeiro básico, autenticação atual, fechamentos, reservas/rifas, interfaces e PWA read-only. São 2/33 commits exclusivos e 13 migrations adicionais em develop, não 33 features faltantes em produção. Quality `34171066032` e Deploy Staging `34171066091` verdes nessa revisão; não houve acesso a produção.

## Marcos de entrega

| Etapa | Estado | Dependências | Entregas e aceite |
| --- | --- | --- | --- |
| 0 — Reconciliação | DONE | Aprovação do plano | Especificação, PRD, gaps, matriz e ADR Payment Link/dinheiro coerentes; revisão documental, PR e CI. Consulta oficial feita; acesso sandbox ainda não validado |
| 1 — Catálogo administrável | IN PROGRESS | 0 | Produtos/categorias, SKU automático, imagens Storage, canais, reserva/lote e preços auditados por RPC; snapshots preservados |
| 2 — Operação de estoque | TODO | 1 | Distribuição, solicitação/aceite de transferência entre vendedores, devolução, perda, inventário e ajustes aprovados; nenhum saldo direto |
| 3 — Compras e custos | TODO | 1, 2 | Fornecedor, pedidos, custos/frete, recebimento parcial, lotes/validade e obrigação financeira sem duplicação; custo rastreável |
| 4 — Promoções completas | TODO | 1 | Administração e regras percentual, preço fixo, quantidade, leve/pague, combo mix, escalonada e cupom; limites concorrentes e economia explicada |
| 5 — PDV e caixa | IN PROGRESS | 2, 4 | Completar turno, histórico, pendências, dinheiro/troco, método/terminal e fechamento; instalação/atualização PWA nos dispositivos-alvo |
| 6 — Administração comercial/financeira | IN PROGRESS | 3, 5 | Vendas, reversões, contas/categorias, despesas, taxas, recebíveis, conciliação, importação validada por arquivo oficial e CSV real |
| 7 — Payment Link | TODO | 0, 6, sandbox autorizado | Adapter, OAuth backend, consulta/inativação, webhook, replay, reconciliação e estorno; falhas não duplicam efeitos |
| 8 — Compra, reservas e rifas | IN PROGRESS | 4, 7 | Carrinho/pedido/pagamento; preparar/retirar reserva; compra de números e rifa no PDV; publicação/pausa/cancelamento e reembolso seguro |
| 9 — Gestão e indicadores | IN PROGRESS | 3, 6, 8 | Auditoria, configurações, desbloqueios, conta/sessões, Portal→PDV e indicadores completos por período; meta pública configurável |
| 10 — Campanhas e comunidade | TODO | 8, 9 | Vitrine, eventos, links/QR, atribuição, divulgação, preferências/avise-me, segmentação, mural, sugestões, enquetes e moderação |
| 11 — Homologação e release | TODO | 1–10 | Jornada por papel, carga/acessibilidade, backup restaurado, alertas, runbooks, migrations revisadas e promoção autorizada |

## Execução incremental

Cada etapa comporta PRs pequenos e completos. Começar pela administração transacional do catálogo, sem antecipar integrações financeiras. Preservar Next.js/monorepo, contratos Zod, banco transacional e design system aprovado. Investigar contrato e acesso ao sandbox desde a etapa 0; o avanço independente do catálogo não depende de credenciais PicPay.

Por mutação: permission + rota/allowlist + RLS + RPC + idempotência + interface + teste de abuso. Preço é do servidor, histórico é imutável e tarefas secundárias usam outbox. Se a cotação mudar antes de cobrar, confirmar novamente; a reserva comercial conserva o snapshot.

O PWA já integrado permite somente shell/catálogo público datado, primeira página até 50 produtos, TTL 24h e indicação de parcialidade. Nunca cachear sessão, saldo, carrinho ou pagamentos; nenhuma fila offline. O service binding PDV→Portal foi integrado no PR #51, com smoke de catálogo/sessão; instalação real continua pendente.

## Gates e lançamento

Aplicar lint, typecheck, unitários, SQL, integração concorrente, E2E Chromium, builds Next/Vinext e scan conforme a mudança. Exigir CI verde, revisão e smoke funcional em staging, além de homologação humana onde indicada na matriz. Alteração documental requer integridade e QA visual do DOCX, links e coerência; não exige recriar runtime.

Casos transversais: última unidade/número, limites promocionais, duplo checkout/recebimento/confirmação/cancelamento, webhook duplicado/fora de ordem, timeout e pagamento tardio, reembolso parcial, dinheiro/troco, retirada, OTP/revogação/último admin, PWA seguro e relatórios além de 100 registros em intervalos fechado-abertos de São Paulo.

Branches curtas de develop, Conventional Commits, PR e squash; nunca force push. Merge automático em develop somente após revisão e CI verde, seguido de CI/deploy/smokes. Promoção consolidada develop→main exige autorização explícita após CI/revisão; a mesma autorização cobre deploy governado e smokes. Nenhum acesso antecipado a produção. A data final depende dos marcos e da homologação Payment Link.

## Evoluções condicionais

App nativo, chat privado, cards automáticos, Web Push, SFTP, Open Finance e integração remota de terminal não bloqueiam o lançamento não opcional. Tap/V.A./V.R. exigem habilitação e processo próprios; permanecem indisponíveis até comprovação. Notificações in-app, campanhas e mural moderado fazem parte deste lançamento. Dinheiro físico foi aprovado com conta/controle próprios (ADR 0010).

## Incremento de categorias — 08/09/2026

A etapa 0 foi integrada no PR #52, develop `6030b14`, com Quality `34175115950` e Staging `34175115940` verdes. A consulta oficial de Payment Link foi concluída; sandbox/credenciais continuam sem validação.

Primeira fatia da etapa 1: categorias com criação, edição, ordenação e inativação por `save_catalog_category` e `POST /api/v1/admin/catalog/categories`. Exige `catalog.manage`, motivo e chave idempotente; revisão otimista rejeita edição concorrente, auditoria guarda antes/depois e tabelas continuam sem escrita direta. Interface `/admin/catalogo/categorias` mostra até 50 por página, permite avançar e explica a inativação. Produtos, preços, imagens e hierarquia continuam pendentes; nenhuma integração financeira foi habilitada.

Evidência local específica: 19 pgTAP novos e teste de concorrência real para uma revisão vencedora e criação repetida. Evidência de integração remota será registrada no PR/handoff após os gates; esta descrição de código não é homologação de staging.
