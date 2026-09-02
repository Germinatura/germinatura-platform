# Roadmap oficial — Germinatura v2.2

Estados: `TODO`, `IN PROGRESS`, `BLOCKED`, `DONE`. Evidência de `main` foi auditada até `9f618fd`; documentação histórica não prova implementação.

## Fase 0 — Auditoria e segurança

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Auth Supabase, RBAC/RLS e baseline web | DONE | P0 | — | AUTH-001/002, SEC-001 | Migration, testes SQL/E2E e CI em `b58f93e` |
| Fonte v2.2, PRD, gaps e ADRs | DONE | P0 | PR | GOV-001 | `0640c11` em `main`, CI `32852994966` verde e v2.1 marcada histórica |
| Cadastro verificado e login por credenciais | IN PROGRESS | P0 | Supabase Auth, SMTP, segredo server-side, rate limit | AUTH-003/006, SEC-002 | Backend e telas base em staging; código de 6–10 dígitos, um reenvio após 90s, troca de e-mail e desbloqueios auditados prontos; falta homologação visual/SMTP pelo operador |
| Papel base e provisionamento de vendedor | IN PROGRESS | P0 | Cadastro institucional, RBAC, auditoria | AUTH-004, PDV-001, AUD-001 | `fix/credential-auth-flow` preserva `CONSUMIDOR`, provisiona conta auditada e restringe PDV a credenciais; gestão administrativa completa segue pendente |
| Bootstrap do primeiro administrador | IN PROGRESS | P0 | Acesso institucional, procedimento seguro de bootstrap | AUTH-005, AUD-001 | RPC e interface locais aceitam somente a identidade verificada definida no ADR 0009, são idempotentes e fecham após sucesso; bootstrap real continua operacionalmente pendente |
| Granularidade futura de autorização | TODO | P0 | Cada domínio | AUTH-002 | Rota + permission + RLS + teste de abuso |
| Staging segregado | DONE | P1 | Supabase/Cloudflare/GitHub Environment/domínios | SEC-001, OBS-001 | Deploy `33294264656`, CI `33294264662` e smokes remotos verdes em `develop`; domínios próprios permanecem dívida operacional aceita |

## Fase 1 — Fundação

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Monorepo Portal/PDV/packages | DONE | P1 | — | ARCH-001/002 | Builds/apps/packages em CI |
| Contratos de pagamentos auditáveis | DONE | P0 | ADR 0005/0006 | PAY-001/002/003/008 | `fdd4425`: estados/transições e adapter indisponível; 5 testes + lint/typecheck |
| Money compartilhado | DONE | P0 | Contratos | PRICE-001 | `a769f50` em `main`; CI pós-merge `33094580327` verde |
| Idempotência persistente | DONE | P0 | Money | IDEM-001 | `62ae97c` em `main`; 61 testes SQL e CI pós-merge `33097920723` verde. Consumo por mutações permanece incremental |
| Erros e cursor comuns | IN PROGRESS | P1 | Contratos | ARCH-002 | `084ebda` adiciona primeiro consumidor real com erro e cursor compartilhados; generalização segue incremental |
| Audit log e transactional outbox | DONE | P0 | Migration/worker | AUD-001, OBS-001 | Claim concorrente, lease, ack, retry exponencial, dead-letter lógico e métricas são consumidos pelo worker agendado; falhas assíncronas não revertem a transação principal |

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
| Pricing e promoções server-side | DONE | P0 | Catálogo | PRICE-002, PROMO-001/002 | `86238e1` promoveu a cotação autoritativa para `PORTAL`/`PDV`; staging/produção e rejeição de total adulterado foram validados |
| Checkout/venda/cancelamento | DONE | P0 | Pricing/ledger/outbox | SALE-001/002/003 | RPC e API recalculam preço, congelam snapshots, reservam estoque e criam tentativa em uma transação; replay/conflito, concorrência real e cancelamento pendente com liberação única são testados. Venda confirmada permanece fail-closed até reversões financeira e de estoque |
| PWA/estoque vendedor/fechamento | IN PROGRESS | P1 | Venda/transferência | PDV-001, PWA-001, CLOSE-001 | A interface do PDV consome catálogo/saldo via RLS e executa cotação, checkout, confirmação manual e cancelamento pelos contratos transacionais; fechamento visual e cache PWA seguem pendentes |

## Fase 4 — PicPay

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Tentativa e confirmação manual controlada | DONE | P0 | Venda/permissões | PAY-002/003/005 | `MAQUININHA` e `PIX_AREA` confirmam somente venda própria no valor exato, com origem `MANUAL`, referência não sensível, idempotência, estoque e recebível atômicos |
| Área Pix PicPay operacional | IN PROGRESS | P1 | Conta/política homologadas | PAY-003/005 | Contrato manual está implementado sem chamada remota; procedimento humano de homologação ainda é necessário |
| Checkout/API e webhook | BLOCKED | P1 | Habilitação, docs e credenciais oficiais | PAY-004/007 | Sandbox, assinatura, dedupe, consulta e E2E |
| Maquininha/Tap | BLOCKED | P1 | Terminal/operador/processo | PAY-005/008 | Maquininha manual existe sem iniciação remota; Tap e integrações privadas seguem indisponíveis |
| V.A./V.R. | BLOCKED | P1 | Credenciamento Alelo/Ticket | PAY-006 | Flag + elegibilidade e operação aprovadas |

## Fase 5 — Financeiro

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Lançamentos/taxas/conciliação | DONE | P1 | Venda/pagamento/outbox | FIN-001/002/003 | Recebível, divergência, taxa e liquidação são append-only; Admin/Financeiro conciliam por referência única, mismatch vira pendência e replay não duplica efeitos |
| Reembolso/reversão confirmada | TODO | P0 | Venda/estoque/financeiro | SALE-002, FIN-002 | Cancelamento confirmado exige reversões de estoque e financeiro, nunca exclusão |
| Compras/fornecedores/custo | TODO | P2 | Catálogo/ledger | PROC-001 | Recebimento parcial gera lote/movimento/despesa |
| Fechamentos e dashboards | IN PROGRESS | P2 | Estoque/venda/financeiro | CLOSE-001, ADMIN-001 | Snapshot de vendas/pagamentos/estoque e reabertura motivada implementados; dashboard visual segue pendente |

## Fase 6 — Venda online e crescimento

| Item | Status | Prioridade | Dependências | PRD | Critério de conclusão |
| --- | --- | --- | --- | --- | --- |
| Portal de compra/reservas/rifas | IN PROGRESS | P2 | Checkout PicPay/estoque | PORTAL-001, RES-001, RAF-001 | Backend de reservas/rifas, concorrência e expiração pelo worker entregues; padrão visual foi aprovado e documentado, telas de consumidor seguem na próxima fatia |
| Campanhas, links e notificações | IN PROGRESS | P2 | Outbox/Portal | GROW-001, NOTIF-001 | Notificações in-app listáveis/marcáveis e materialização idempotente entregues; e-mail, push e campanhas seguem pós-MVP |

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

## Direção visual aprovada e próxima fatia

O gate visual foi aprovado em 01/09/2026. Tokens, componentes-base e regras normativas estão em `docs/design/DESIGN_SYSTEM.md`; o Portal autenticado já usa o shell claro e o PDV usa a linguagem escura operacional. A próxima fatia deve implementar as telas administrativas e, depois, as jornadas de consumidor sem alterar regras de domínio. Checkout/API, webhook, Tap remoto e demais integrações privadas continuam fail-closed.
