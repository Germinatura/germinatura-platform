# Roadmap oficial — Germinatura v2.2

Estados: `TODO`, `IN PROGRESS`, `BLOCKED`, `DONE`. Evidência atual foi auditada em `b58f93e`; documentação histórica não prova implementação.

## Fase 0 — Auditoria e segurança

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Auth Supabase, RBAC/RLS e baseline web | DONE | P0 | — | AUTH-001/002, SEC-001 | Migration, testes SQL/E2E e CI em `b58f93e` |
| Fonte v2.2, PRD, gaps e ADRs | IN PROGRESS | P0 | PR | GOV-001 | Docs em `main`, CI verde e v2.1 marcada histórica |
| Granularidade futura de autorização | TODO | P0 | Cada domínio | AUTH-002 | Rota + permission + RLS + teste de abuso |
| Staging segregado | BLOCKED | P1 | Supabase/Cloudflare/GitHub Environment/domínios | SEC-001, OBS-001 | Deploy e smoke reais sem produção |

## Fase 1 — Fundação

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Monorepo Portal/PDV/packages | DONE | P1 | — | ARCH-001/002 | Builds/apps/packages em CI |
| Contratos de pagamentos auditáveis | IN PROGRESS | P0 | ADR 0005/0006 | PAY-001/002/003/008 | Estados/transições/adapters indisponíveis testados |
| Money, erros, cursor e idempotência comuns | TODO | P0 | Contratos | PRICE-001, IDEM-001 | Tipos/testes sem Float/duplicação |
| Audit log e transactional outbox | TODO | P0 | Migration | AUD-001, OBS-001 | Evento no mesmo commit + worker idempotente |

## Fase 2 — Estoque confiável

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Catálogo/preços base | TODO | P0 | Fundação | CAT-001, PRICE-001 | Migration/RLS/API/testes |
| Ledger, saldos e localizações | TODO | P0 | Catálogo/outbox | INV-001/002 | Movimentos imutáveis e saldo explicável |
| Reserva/concorrência/inventário | TODO | P0 | Ledger | INV-003/004, CONC-001 | Última unidade e simultaneidade testadas |

## Fase 3 — PDV

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Pricing e promoções server-side | TODO | P0 | Catálogo | PRICE-002, PROMO-001/002 | Casos puros + API ignora total cliente |
| Checkout/venda/cancelamento | TODO | P0 | Pricing/ledger/outbox | SALE-001/002/003 | Atomicidade e duplicação testadas |
| PWA/estoque vendedor/fechamento | TODO | P1 | Venda/transferência | PDV-001, PWA-001, CLOSE-001 | Offline read-only e fechamento auditado |

## Fase 4 — PicPay

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Tentativa e confirmação manual controlada | TODO | P0 | Venda/permissões | PAY-002/003/005 | Origem manual explícita, idempotente e auditada |
| Área Pix PicPay operacional | BLOCKED | P1 | Conta/política homologadas | PAY-003/005 | Fluxo autorizado, sem alegar webhook |
| Checkout/API e webhook | BLOCKED | P1 | Habilitação, docs e credenciais oficiais | PAY-004/007 | Sandbox, assinatura, dedupe, consulta e E2E |
| Maquininha/Tap e conciliação | BLOCKED | P1 | Terminal/operador/processo | PAY-005/008, FIN-003 | Sem iniciação remota fictícia; extrato conciliado |
| V.A./V.R. | BLOCKED | P1 | Credenciamento Alelo/Ticket | PAY-006 | Flag + elegibilidade e operação aprovadas |

## Fase 5 — Financeiro

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Lançamentos/taxas/conciliação | TODO | P1 | Venda/pagamento/outbox | FIN-001/002/003 | Uma origem, um efeito; divergências preservadas |
| Compras/fornecedores/custo | TODO | P2 | Catálogo/ledger | PROC-001 | Recebimento parcial gera lote/movimento/despesa |
| Fechamentos e dashboards | TODO | P2 | Estoque/venda/financeiro | CLOSE-001, ADMIN-001 | Indicadores reconciliados e reabertura auditada |

## Fase 6 — Venda online e crescimento

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Portal de compra/reservas/rifas | TODO | P2 | Checkout PicPay/estoque | PORTAL-001, RES-001, RAF-001 | Fluxos concorrentes e financeiros testados |
| Campanhas, links e notificações | TODO | P2 | Outbox/Portal | GROW-001, NOTIF-001 | Falha assíncrona não afeta transação |

## Fase 7 — Comunidade

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Mural moderado | TODO | P3 | Auth/auditoria/moderação | COMM-001 | XSS, denúncia e permissões testados |

## Fase 8 — Evoluções opcionais

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| SFTP/integração privada/TEF/SDK PicPay | BLOCKED | P3 | Oferta oficial | PAY-008 | Adapter homologado sem mudar domínio |
| Open Finance para conciliação | BLOCKED | P3 | Caso real/consentimento | FIN-004 | Nunca autoriza venda; ADR revisado |
| Web Push, app nativo, chat, analytics | TODO | P3 | Evidência de uso | NOTIF-001, COMM-001 | Decisão própria e métricas |

## Próxima fatia recomendada

Após os contratos de pagamento desta sessão: consolidar tipos de dinheiro/idempotência e preparar o desenho testável do catálogo + ledger. Não iniciar checkout, PicPay real ou migration financeira antes desses invariantes.
