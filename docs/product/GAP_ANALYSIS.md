# Diagnóstico v2.2 — estado atual x estado-alvo

Data da auditoria: 2026-08-25. Base: `b58f93e`. Fonte-alvo: especificação v2.2. “Implementado” exige comportamento e teste; shells e nomes de pacotes não contam como domínio entregue.

| Requisito | Estado atual | Gap | Prioridade | Dependências | Risco | Ação |
| --- | --- | --- | --- | --- | --- | --- |
| GOV-001 Fonte de verdade v2.2 | PARCIAL — DOCX recebido, não versionado | Organizar e declarar vigência | P0 | PR/CI | Médio | Versionar em `docs/specs` e atualizar docs vigentes |
| ARCH-001 Monorepo Portal + PDV | IMPLEMENTADO | Apps ainda são shells | P1 | Domínios | Baixo | Preservar estrutura e evoluir por módulos |
| ARCH-002 Monólito modular | PARCIAL | Packages existem; casos de uso ausentes | P1 | Contratos | Médio | Introduzir módulos por fatias, sem microserviços |
| AUTH-001 Supabase Auth | IMPLEMENTADO | Fluxos avançados/sessões ativas ausentes | P1 | Supabase | Médio | Manter e ampliar com testes |
| AUTH-002 RBAC múltiplos papéis | IMPLEMENTADO | Permissões de domínios futuros ainda genéricas | P1 | Novos casos de uso | Alto | Evoluir catálogo de permissões com cada módulo |
| AUTH-003 Autorização server-side/RLS | PARCIAL | Cobertura só da fundação ativa | P0 | Cada nova tabela/rota | Alto | Rota/policy/teste juntos |
| SEC-001 Secrets e proteção web | PARCIAL | Scan/headers/CSRF básicos; rate limit/monitoramento ausentes | P0 | Borda/staging | Alto | Preservar gates; completar por ambiente |
| CAT-001 Catálogo normalizado | AUSENTE | Sem tabelas, API ou UI funcional | P1 | Auth, storage | Médio | Entregar antes de pricing/estoque |
| PRICE-001 Dinheiro sem Float | PARCIAL | Sem domínio monetário; PIX legado usa `parseFloat` | P0 | Contratos | Alto | Criar Money em centavos; retirar legado no fluxo correto |
| PRICE-002 Pricing server authority | AUSENTE | Nenhum motor/cotação | P0 | Catálogo | Crítico | Endpoint/RPC recalcula tudo |
| PROMO-001 Promoções por regras | AUSENTE | Nenhum motor | P1 | Catálogo, pricing | Alto | Implementar funções puras + casos obrigatórios |
| INV-001 Ledger imutável | AUSENTE | Nenhuma tabela de estoque | P0 | Migration/RPC | Crítico | Projetar ledger e saldos transacionais |
| INV-002 Localizações/vendedor | AUSENTE | Sem saldo/localização | P0 | INV-001 | Crítico | Criar central e localizações operacionais |
| INV-003 Reserva concorrente | AUSENTE | Sem locks/reservas | P0 | INV-001, SALE-001 | Crítico | RPC atômica e teste da última unidade |
| SALE-001 Checkout idempotente | AUSENTE | Sem venda/checkout | P0 | Pricing, estoque | Crítico | Idempotency-Key + transação |
| SALE-002 Conclusão/cancelamento reversível | AUSENTE | Sem lifecycle | P0 | Outbox, financeiro | Crítico | Máquina de estados e reversões |
| PAY-001 Contrato neutro de provider | PARCIAL | Interface mínima e estados insuficientes | P0 | ADR 0005 | Alto | Ampliar contrato/testes sem rede |
| PAY-002 PicPay único em produção | LEGADO A SUBSTITUIR | Roadmap v2.1 ainda planeja Mercado Pago | P0 | Decisão v2.2 | Alto | Novo roadmap + ADR; antigo fica histórico |
| PAY-003 PicPay Checkout/API | BLOQUEADO POR DECISÃO EXTERNA | Sem adapter, docs/credenciais/habilitação no repo | P1 | Contrato comercial, sandbox | Crítico | Somente contrato/flag até confirmação oficial |
| PAY-004 Maquininha/Tap controlado | AUSENTE | Sem payment attempt/confirmação manual auditada | P1 | Modelo de vendas | Alto | Modelar canal e origem de confirmação; não iniciar terminal |
| PAY-005 V.A./V.R. | BLOQUEADO POR DECISÃO EXTERNA | Sem credenciamento Alelo/Ticket | P1 | CNPJ/rede/Maquininha | Crítico | Flag desligada; não mascarar como crédito |
| PAY-006 Webhook/idempotência | AUSENTE | Sem receipt, assinatura ou replay | P0 | PicPay oficial, outbox | Crítico | Implementar apenas com documentação oficial |
| FIN-001 Ledger financeiro/conciliação | AUSENTE | Nenhuma tabela/fluxo | P1 | Vendas/pagamentos | Crítico | Eventos idempotentes e pendências de conciliação |
| RES-001 Reservas | AUSENTE | Domínio removido no greenfield | P2 | Estoque/pricing | Alto | Reimplementar atomicamente com snapshot |
| RAF-001 Rifas | AUSENTE | Domínio removido no greenfield | P2 | Pagamentos/financeiro | Alto | Reserva concorrente e sorteio auditável |
| PROC-001 Fornecedores/compras | AUSENTE | Sem origem/custo do estoque | P2 | Catálogo/ledger | Médio | Compras e recebimentos parciais |
| CLOSE-001 Fechamento de vendedor | AUSENTE | Sem turnos/contagens | P2 | Estoque/vendas/financeiro | Alto | Conferência auditável e reabertura motivada |
| OBS-001 Logs/auditoria/outbox | PARCIAL | Logger/redação e request id básicos; audit/outbox ausentes | P0 | Schema | Alto | Criar junto ao primeiro caso transacional |
| CI-001 Gates locais/CI | IMPLEMENTADO | CI não faz deploy; staging bloqueado | P1 | Docker para DB/E2E | Médio | Manter qualidade; provisionar staging separadamente |
| PWA-001 PDV instalável | AUSENTE | Shell mobile-first, sem manifest/service worker | P2 | Fluxo PDV | Baixo | Implementar após checkout confiável |
| COM-001 Comunidade/notificações | AUSENTE | Sem domínio | P3 | Outbox/moderação | Médio | Pós-MVP |

## Riscos P0/P1

- Não existe ainda qualquer garantia transacional para dinheiro, estoque ou venda; esses fluxos devem permanecer indisponíveis até os respectivos invariantes existirem.
- A documentação v2.1 planeja Mercado Pago e foi superada; reutilizá-la sem consultar v2.2 causaria divergência financeira.
- Confirmação manual presencial pode ser confundida com confirmação automática se a origem não for persistida e exibida.
- Staging e credenciais externas não estão provisionados; mocks não podem ser promovidos como adapters reais.
- O ADR 0001 greenfield prevalece sobre trechos de migração histórica da especificação: não há dados legados a converter.

## Dívidas que bloqueiam evolução

1. Domínios vazios: contratos centrais, dinheiro, idempotência e estado precisam preceder telas.
2. `apps/pdv/lib/pix.ts` usa `parseFloat` e representa PIX estático genérico; não deve orientar a nova implementação.
3. A matriz de permissões precisará ganhar ações granulares com cada módulo.
4. Outbox, audit log e receipt de webhook precisam nascer junto do primeiro fluxo crítico, não depois.
