# Diagnóstico v2.2 — estado atual x estado-alvo

Data da auditoria: 2026-08-29. Base: `9e2ca83` em `main`, com CI pós-merge `33263783862` verde, mais a persistência em desenvolvimento na branch `feat/promotion-rules-schema`. Fonte-alvo: especificação v2.2. “Implementado” exige comportamento e teste; shells e nomes de pacotes não contam como domínio entregue.

| Requisito | Estado atual | Gap | Prioridade | Dependências | Risco | Ação |
| --- | --- | --- | --- | --- | --- | --- |
| GOV-001 Fonte de verdade v2.2 | IMPLEMENTADO | — | P0 | PR/CI | Baixo | Preservar especificação, PRD, roadmap e ADRs versionados |
| ARCH-001 Monorepo Portal + PDV | IMPLEMENTADO | Apps ainda são shells | P1 | Domínios | Baixo | Preservar estrutura e evoluir por módulos |
| ARCH-002 Monólito modular | PARCIAL | Packages existem; casos de uso ausentes | P1 | Contratos | Médio | Introduzir módulos por fatias, sem microserviços |
| AUTH-001 Supabase Auth | IMPLEMENTADO | Fluxos avançados/sessões ativas ausentes | P1 | Supabase | Médio | Manter e ampliar com testes |
| AUTH-002 Autorização server-side/RLS e múltiplos papéis | PARCIAL | Fundação, catálogo e estoque estão cobertos; permissões dos domínios futuros ainda são genéricas | P0 | Cada nova tabela/rota | Alto | Entregar rota, permission, policy e teste juntos |
| AUTH-003 Acesso institucional por código | EM IMPLEMENTAÇÃO — `04e5597` em `develop` contém OTP, domínio exato no banco, rate limit persistente e E2E com Mailpit; template, migration e apps foram publicados em staging | Solicitação remota retornou 202, mas recebimento, uso único e expiração do código ainda precisam de validação humana sem expor o token | P0 | Supabase Auth, SMTP | Alto | Homologar o código remoto por canal seguro antes de marcar DONE |
| AUTH-004 Papel base e ativação do vendedor | EM IMPLEMENTAÇÃO — criação mantém apenas `CONSUMIDOR`; RPC administrativa troca papéis cumulativos, ativa/inativa e audita; PDV verifica perfil ativo | Migration está em staging; interface administrativa completa e revogação remota seguem na fatia operacional | P0 | AUTH-003, RBAC, auditoria | Alto | Validar abuso e revogação em staging e integrar à UI administrativa |
| AUTH-005 Primeiro administrador | EM IMPLEMENTAÇÃO — bootstrap único/idempotente e interface restrita ao endereço verificado definidos no ADR 0009 | A operação real não foi executada e não deve usar credencial em Git/chat | P0 | AUTH-003, procedimento seguro | Crítico | Executar somente após OTP de staging/produção estar validado e registrar evidência não sensível |
| SEC-001 Secrets e proteção web | PARCIAL | Scan/headers/CSRF básicos; rate limit/monitoramento ausentes | P0 | Borda/staging | Alto | Preservar gates; completar por ambiente |
| CAT-001 Catálogo normalizado | IMPLEMENTADO NA FUNDAÇÃO — categorias, produtos, histórico de preços, RLS e testes em `4898755` | Imagens e administração/UI ainda ausentes | P1 | Auth, storage | Médio | Preservar invariantes e evoluir a administração em fatia própria |
| CAT-002 API pública versionada | IMPLEMENTADO — `GET /api/v1/catalog/products` em `1abd440` usa visão `anon`, preço vigente, cursor e limite máximo 50 | Busca, disponibilidade, promoções e ordenação editorial ficaram fora do contrato inicial | P1 | CAT-001, RLS | Médio | Evoluir o contrato somente com consumidor e testes correspondentes |
| PRICE-001 Dinheiro sem Float | IMPLEMENTADO NA FUNDAÇÃO — `MoneyCents`, schema Zod, contratos e preços `BIGINT` limitados ao safe integer | Pricing de negócio ainda ausente | P0 | Catálogo | Médio | Manter validação nas fronteiras e histórico sem sobreposição |
| PRICE-002 Pricing server authority | PARCIAL — `9e2ca83` calcula preço-base e `QUANTIDADE_PRECO` em centavos, com explicação e falha fechada | Preços e promoções vigentes ainda não são resolvidos juntos por uma API server-only | P0 | Catálogo | Crítico | Expor cotação autoritativa que rejeite valores enviados pelo cliente |
| PROMO-001/002 Promoções por regras | PARCIAL — a branch atual persiste produto, canal, prioridade, cumulatividade, vigência `[)`, limites e `QUANTIDADE_PRECO`, com consulta vigente e RLS | Sem API de cotação, consumo de limites, administração transacional ou demais tipos | P1 | Catálogo, pricing | Alto | Integrar a visão vigente ao motor puro antes de ampliar tipos |
| INV-001 Ledger imutável | IMPLEMENTADO NA FUNDAÇÃO — movimentos, itens, ajuste, transferência e reversão em `3db74fc` | Consumo por venda e reconciliação ampla ainda ausentes | P0 | Migration/RPC | Crítico | Manter saldo mutável somente pelo ledger e ampliar por movimentos atômicos |
| INV-002 Localizações/vendedor | IMPLEMENTADO NA FUNDAÇÃO — central, localização por vendedor, saldo derivado e RLS em `77f7fc2` | Operação do vendedor ainda depende dos casos de uso seguintes | P0 | INV-001 | Alto | Preservar constraints e acesso restrito |
| INV-003 Reserva concorrente | IMPLEMENTADO NA FUNDAÇÃO — `d4d1489` cria reserva, liberação e expiração idempotentes com locks determinísticos | Consumo pela venda permanece adiado | P0 | INV-001, SALE-001 | Alto | Preservar o teste concorrente da última unidade e integrar somente por casos de uso server-side |
| SALE-001 Checkout idempotente | EM IMPLEMENTAÇÃO — `feat/sales-foundation` adiciona venda, snapshots imutáveis, totais em centavos, RLS, auditoria e outbox | RPC de checkout, reserva e tentativa idempotentes ainda não existem | P0 | Pricing, estoque | Crítico | Integrar cotação e hold em uma única transação na próxima fatia |
| IDEM-001 Fundação idempotente | IMPLEMENTADO NA FUNDAÇÃO — persistência, replay e conflito consumidos pelo ledger e pelas reservas | Novos domínios ainda precisam adotar o contrato | P0 | RPCs de domínio | Alto | Integrar incrementalmente em cada mutação crítica |
| SALE-002 Conclusão/cancelamento reversível | PARCIAL — máquina interna aceita apenas `DRAFT → AWAITING_PAYMENT → CONFIRMED` e cancelamento pendente; histórico é append-only | Cancelamento confirmado permanece fail-closed até estoque e financeiro criarem reversões atômicas | P0 | Outbox, financeiro | Crítico | Não abrir a transição confirmada para cancelada sem ledgers de reversão |
| PAY-001 Provider neutro/PicPay em produção | IMPLEMENTADO NA ARQUITETURA — interfaces neutras, adapter fail-closed e ADR 0005; documentação v2.1 está histórica | Configuração e integração reais permanecem bloqueadas | P0 | Habilitação oficial | Alto | Preservar contratos e não configurar outro provider em produção |
| PAY-002 Estados e transições | PARCIAL — estados e transições válidas estão testados no package de pagamentos | Persistência e máquina transacional ainda ausentes | P0 | Venda | Alto | Persistir tentativas e validar transições no servidor/banco |
| PAY-003 Tentativa auditável | PARCIAL — contratos tipam valor, idempotência, canal, operador e origem | Nenhuma tentativa é persistida ou ligada a venda | P0 | Venda, idempotência | Alto | Criar tentativa junto do checkout sem alegar confirmação automática |
| PAY-004 Checkout/API PicPay | BLOQUEADO POR DECISÃO EXTERNA | Sem adapter, docs, credenciais ou habilitação no repo | P1 | Contrato comercial, sandbox | Crítico | Implementar somente com documentação oficial |
| PAY-005 Maquininha/Tap controlado | PARCIAL — contratos manuais e adapter indisponível existem | Sem tentativa persistida/confirmação manual auditada; iniciação remota bloqueada | P1 | Venda, permissões, operação | Alto | Modelar canal e origem manual sem iniciar terminal remotamente |
| PAY-006 V.A./V.R. | BLOQUEADO POR DECISÃO EXTERNA | Sem credenciamento Alelo/Ticket | P1 | CNPJ/rede/Maquininha | Crítico | Flag desligada; não mascarar como crédito |
| PAY-007 Webhook | BLOQUEADO POR DECISÃO EXTERNA | Sem receipt, assinatura, dedupe ou replay porque não há documentação/habilitação oficial | P1 | PicPay oficial, outbox | Crítico | Implementar somente com contrato verificável do provedor |
| PAY-008 Adapter privado futuro | IMPLEMENTADO NA ARQUITETURA — borda substituível sem acoplar o domínio | Integração privada/TEF/SDK não ofertada | P3 | Oferta oficial | Alto | Manter indisponível até homologação |
| FIN-001 Ledger financeiro/conciliação | AUSENTE | Nenhuma tabela/fluxo | P1 | Vendas/pagamentos | Crítico | Eventos idempotentes e pendências de conciliação |
| RES-001 Reservas | PARCIAL — bloqueio de estoque atômico implementado em `d4d1489` | Snapshot de preço e lifecycle comercial dependem de pricing/venda | P2 | Estoque/pricing | Alto | Reutilizar a primitive sem confundir `reservable` comercial com hold de inventário |
| RAF-001 Rifas | AUSENTE | Domínio removido no greenfield | P2 | Pagamentos/financeiro | Alto | Reserva concorrente e sorteio auditável |
| PROC-001 Fornecedores/compras | AUSENTE | Sem origem/custo do estoque | P2 | Catálogo/ledger | Médio | Compras e recebimentos parciais |
| CLOSE-001 Fechamento de vendedor | AUSENTE | Sem turnos/contagens | P2 | Estoque/vendas/financeiro | Alto | Conferência auditável e reabertura motivada |
| OBS-001 Logs/auditoria/outbox | PARCIAL — audit log, outbox transacional e claim/ack/retry estão em `3db74fc` | Consumidor, retenção, alertas e monitoramento ainda ausentes | P0 | Worker/staging | Alto | Criar consumidor testável; ativação operacional depende de ambiente |
| CI-001 Gates locais/CI | IMPLEMENTADO | CI não faz deploy; staging bloqueado | P1 | Docker para DB/E2E | Médio | Manter qualidade; provisionar staging separadamente |
| PWA-001 PDV instalável | AUSENTE | Shell mobile-first, sem manifest/service worker | P2 | Fluxo PDV | Baixo | Implementar após checkout confiável |
| COM-001 Rede Social Germinare/notificações | AUSENTE | Sem domínio | P3 | AUTH-003, outbox, moderação | Médio | Mural institucional moderado; recursos avançados no pós-MVP |

## Riscos P0/P1

- Estoque já possui invariantes transacionais, mas pricing, venda e financeiro ainda não formam um fluxo completo; checkout deve permanecer indisponível até esses domínios existirem juntos.
- A documentação v2.1 planeja Mercado Pago e foi superada; reutilizá-la sem consultar v2.2 causaria divergência financeira.
- Confirmação manual presencial pode ser confundida com confirmação automática se a origem não for persistida e exibida.
- Staging e produção estão provisionados e tiveram deploy/smoke reais; domínio próprio, SMTP/capacidade de OTP, backup/PITR e alertas continuam pendências operacionais e não podem ser simulados.
- O ADR 0001 greenfield prevalece sobre trechos de migração histórica da especificação: não há dados legados a converter.
- Comparar o domínio por sufixo ou confiar apenas no texto enviado pelo cliente pode admitir endereços externos ou semelhantes; a elegibilidade deve usar o e-mail normalizado e verificado pelo provedor.
- O bootstrap administrativo não pode virar uma elevação permanente por e-mail, nem criar usuário com senha padrão; deve ser único, idempotente, auditado e encerrado após a primeira concessão válida.

## Dívidas que bloqueiam evolução

1. Pricing-base, `QUANTIDADE_PRECO` e sua consulta vigente existem, mas o servidor ainda não os compõe em uma cotação autoritativa; checkout permanece bloqueado até essa API.
2. O onboarding institucional por código, o papel base `CONSUMIDOR`, a ativação administrativa de `VENDEDOR` e o bootstrap do primeiro `ADMIN` ainda não existem.
3. A matriz de permissões precisará ganhar ações granulares com cada módulo.
4. A outbox ainda não possui consumidor operacional; receipt de webhook só pode nascer com documentação oficial do PicPay.
