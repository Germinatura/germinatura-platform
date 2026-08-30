# Roadmap oficial — Germinatura v2.2

Estados: `TODO`, `IN PROGRESS`, `BLOCKED`, `DONE`. Evidência de `main` foi auditada até `9f618fd`; documentação histórica não prova implementação.

## Fase 0 — Auditoria e segurança

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Auth Supabase, RBAC/RLS e baseline web | DONE | P0 | — | AUTH-001/002, SEC-001 | Migration, testes SQL/E2E e CI em `b58f93e` |
| Fonte v2.2, PRD, gaps e ADRs | DONE | P0 | PR | GOV-001 | `0640c11` em `main`, CI `32852994966` verde e v2.1 marcada histórica |
| Acesso institucional por código de e-mail | TODO | P0 | Supabase Auth, serviço de e-mail, rate limit | AUTH-003, SEC-002 | Domínio exato `@institutojef.org.br`; código de uso único; rejeição de domínio externo, código expirado e replay; testes E2E |
| Papel base e ativação de vendedor | TODO | P0 | Acesso institucional, RBAC, auditoria | AUTH-004, PDV-001, AUD-001 | Nova conta recebe somente `CONSUMIDOR`; múltiplos papéis funcionam; PDV permanece bloqueado até ativação administrativa auditada de `VENDEDOR` |
| Bootstrap do primeiro administrador | TODO | P0 | Acesso institucional, procedimento seguro de bootstrap | AUTH-005, AUD-001 | Somente `theo.martins@institutojef.org.br` verificado recebe a primeira concessão `ADMIN`; operação idempotente, auditada e sem segredo versionado |
| Granularidade futura de autorização | TODO | P0 | Cada domínio | AUTH-002 | Rota + permission + RLS + teste de abuso |
| Staging segregado | IN PROGRESS | P1 | Supabase/Cloudflare/GitHub Environment/domínios | SEC-001, OBS-001 | PR #17 prepara ambientes e pipeline; deploy e smoke reais dependem de merge autorizado e execução validada |

## Fase 1 — Fundação

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Monorepo Portal/PDV/packages | DONE | P1 | — | ARCH-001/002 | Builds/apps/packages em CI |
| Contratos de pagamentos auditáveis | DONE | P0 | ADR 0005/0006 | PAY-001/002/003/008 | `fdd4425`: estados/transições e adapter indisponível; 5 testes + lint/typecheck |
| Money compartilhado | DONE | P0 | Contratos | PRICE-001 | `a769f50` em `main`; CI pós-merge `33094580327` verde |
| Idempotência persistente | DONE | P0 | Money | IDEM-001 | `62ae97c` em `main`; 61 testes SQL e CI pós-merge `33097920723` verde. Consumo por mutações permanece incremental |
| Erros e cursor comuns | IN PROGRESS | P1 | Contratos | ARCH-002 | `084ebda` adiciona primeiro consumidor real com erro e cursor compartilhados; generalização segue incremental |
| Audit log e transactional outbox | IN PROGRESS | P0 | Migration | AUD-001, OBS-001 | Persistência e claim/ack/retry em `3db74fc`; consumidor e monitoramento continuam pendentes |

## Fase 2 — Estoque confiável

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Catálogo/preços base | DONE | P0 | Fundação | CAT-001, PRICE-001 | `4898755` em `main`; schema/RLS/histórico e CI pós-merge `33099929575` verdes |
| API pública de produtos | DONE | P1 | Catálogo/RLS/contratos | CAT-002, AUTH-002 | `1abd440` em `main`; GET v1 limitado e paginado consulta sempre como anon; CI pós-merge `33193987691` verde |
| Localizações e saldos protegidos | DONE | P0 | Catálogo | INV-002 | `77f7fc2` em `main`; constraints/RLS e CI pós-merge `33102680002` verdes |
| Ledger imutável | DONE | P0 | Localizações/outbox | INV-001 | `3db74fc` em `main`; ajuste, transferência e reversão atômicos; CI pós-merge `33173021796` verde |
| Reserva/concorrência/inventário | DONE | P0 | Ledger | INV-003/004, CONC-001 | `4cb84c8` em `main`; reserva/liberação/expiração idempotentes; 218 SQL + teste concorrente real da última unidade e reserva x transferência |

## Fase 3 — PDV

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Pricing e promoções server-side | IN PROGRESS | P0 | Catálogo | PRICE-002, PROMO-001/002 | `9f618fd` cobre domínio e persistência; PR #17 adiciona cotação autoritativa para `PORTAL`/`PDV`, com cálculo em centavos e promoções explicadas |
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
| Rede Social Germinare / mural moderado | TODO | P3 | Auth/auditoria/moderação | COMM-001 | Acesso institucional verificado, XSS, denúncia e permissões testados |

## Fase 8 — Evoluções opcionais

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| SFTP/integração privada/TEF/SDK PicPay | BLOCKED | P3 | Oferta oficial | PAY-008 | Adapter homologado sem mudar domínio |
| Open Finance para conciliação | BLOCKED | P3 | Caso real/consentimento | FIN-004 | Nunca autoriza venda; ADR revisado |
| Web Push, app nativo, chat, analytics | TODO | P3 | Evidência de uso | NOTIF-001, COMM-001 | Decisão própria e métricas |

## Próxima fatia recomendada

Após a cotação autoritativa ser mesclada, iniciar `feat/sales-foundation`: persistir venda rascunho, itens com snapshot e máquina de estados auditável, ainda sem concluir pagamento ou chamar PicPay.
