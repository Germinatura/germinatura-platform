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
| PRICE-002 Pricing server authority | IMPLEMENTADO — cotação e checkout resolvem preço e `QUANTIDADE_PRECO` no banco, em centavos, rejeitando totais do cliente | Administração de regras e demais tipos continuam incrementais | P0 | Catálogo | Médio | Preservar cálculo server-side e explicação por linha |
| PROMO-001/002 Promoções por regras | PARCIAL — produto, canal, prioridade, cumulatividade, vigência `[)`, limites e `QUANTIDADE_PRECO` alimentam cotação e snapshots da venda | Consumo de limites, administração transacional e demais tipos permanecem ausentes | P1 | Catálogo, pricing | Alto | Ampliar tipos somente com prioridade determinística e testes econômicos |
| INV-001 Ledger imutável | IMPLEMENTADO NA FUNDAÇÃO — movimentos, itens, ajuste, transferência e reversão em `3db74fc` | Consumo por venda e reconciliação ampla ainda ausentes | P0 | Migration/RPC | Crítico | Manter saldo mutável somente pelo ledger e ampliar por movimentos atômicos |
| INV-002 Localizações/vendedor | IMPLEMENTADO NA FUNDAÇÃO — central, localização por vendedor, saldo derivado e RLS em `77f7fc2` | Operação do vendedor ainda depende dos casos de uso seguintes | P0 | INV-001 | Alto | Preservar constraints e acesso restrito |
| INV-003 Reserva concorrente | IMPLEMENTADO NA FUNDAÇÃO — `d4d1489` cria reserva, liberação e expiração idempotentes com locks determinísticos | Consumo pela venda permanece adiado | P0 | INV-001, SALE-001 | Alto | Preservar o teste concorrente da última unidade e integrar somente por casos de uso server-side |
| SALE-001 Checkout idempotente | IMPLEMENTADO — `checkout_sale` recalcula preço, persiste snapshots, reserva estoque e cria tentativa neutra atomicamente; mesma chave reproduz o resultado e payload divergente falha | Interface operacional do PDV ainda não consome o contrato | P0 | Pricing, estoque | Médio | Preservar testes reais de última unidade e duplo Cobrar |
| IDEM-001 Fundação idempotente | IMPLEMENTADO NA FUNDAÇÃO — persistência, replay e conflito consumidos pelo ledger e pelas reservas | Novos domínios ainda precisam adotar o contrato | P0 | RPCs de domínio | Alto | Integrar incrementalmente em cada mutação crítica |
| SALE-002 Conclusão/cancelamento reversível | PARCIAL — `cancel_sale` cancela venda e tentativa pendentes, libera o hold uma vez e mantém históricos append-only | Confirmação e cancelamento confirmado permanecem fail-closed até estoque e financeiro criarem efeitos/reversões atômicos | P0 | Outbox, financeiro | Crítico | Não abrir confirmação ou reversão sem os ledgers correspondentes |
| PAY-001 Provider neutro/PicPay em produção | IMPLEMENTADO NA ARQUITETURA — interfaces neutras, adapter fail-closed e ADR 0005; documentação v2.1 está histórica | Configuração e integração reais permanecem bloqueadas | P0 | Habilitação oficial | Alto | Preservar contratos e não configurar outro provider em produção |
| PAY-002 Estados e transições | PARCIAL — tentativas e histórico são persistidos; nesta fatia o banco permite apenas `CREATED → CANCELLED` | Confirmação manual e demais transições aguardam regras de canal, permissão e efeitos financeiros | P0 | Venda | Alto | Abrir cada transição somente com efeito atômico e teste de abuso |
| PAY-003 Tentativa auditável | PARCIAL — checkout cria tentativa ligada à venda, no valor exato, com operador, chave e correlação; canal/origem ficam nulos | Confirmação manual auditada ainda não existe | P0 | Venda, idempotência | Alto | Selecionar `MAQUININHA` ou `PIX_AREA` apenas no fluxo manual governado |
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

- Pricing, venda e reserva já formam checkout transacional, mas confirmação e financeiro ainda não existem; nenhuma tentativa pode ser apresentada como paga antes da próxima fatia auditada.
- A documentação v2.1 planeja Mercado Pago e foi superada; reutilizá-la sem consultar v2.2 causaria divergência financeira.
- Confirmação manual presencial pode ser confundida com confirmação automática se a origem não for persistida e exibida.
- Staging e produção estão provisionados e tiveram deploy/smoke reais; domínio próprio, SMTP/capacidade de OTP, backup/PITR e alertas continuam pendências operacionais e não podem ser simulados.
- O ADR 0001 greenfield prevalece sobre trechos de migração histórica da especificação: não há dados legados a converter.
- Comparar o domínio por sufixo ou confiar apenas no texto enviado pelo cliente pode admitir endereços externos ou semelhantes; a elegibilidade deve usar o e-mail normalizado e verificado pelo provedor.
- O bootstrap administrativo não pode virar uma elevação permanente por e-mail, nem criar usuário com senha padrão; deve ser único, idempotente, auditado e encerrado após a primeira concessão válida.

## Dívidas que bloqueiam evolução

1. A confirmação manual de `MAQUININHA` e `PIX_AREA` ainda precisa consumir a tentativa neutra com valor exato, permissão e efeitos atômicos.
2. O recebimento e uso único do OTP, a jornada administrativa remota e o fechamento efetivo do bootstrap ainda precisam de homologação operacional em staging.
3. A matriz de permissões precisará ganhar ações granulares com cada módulo.
4. A outbox ainda não possui consumidor operacional; receipt de webhook só pode nascer com documentação oficial do PicPay.
