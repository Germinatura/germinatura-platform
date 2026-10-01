# Prontidão de release — Marco 1

Revisão de 30/09/2026, atualizada em 01/10/2026, para a promoção `develop → main`. Este documento não autoriza a promoção: ela depende de autorização explícita do responsável, e o deploy de produção só roda pelo workflow `deploy-production.yml` (`workflow_dispatch`, confirmação `PRODUCAO`, somente a partir de `main`).

## O que o Marco 1 entrega

| Etapa | Situação | Referências |
| --- | --- | --- |
| 1–5 — Catálogo, estoque, compras, promoções, PDV/caixa | Integradas em staging | ver `docs/product/ROADMAP.md` |
| 6 — Comercial e financeiro | Código completo: vendas, estornos, contas a pagar, lançamentos, extrato consolidado e importação do extrato PicPay Empresas no formato real exportado (FIN-007) | #91, #92, #94 e a PR da importação; `docs/product/PRD.md` (FIN-007) |
| 7 — Payment Link | Código completo; **homologação bloqueada externamente** (sandbox PicPay com timeout/502 e sem chave de webhook). Flag `payment_link` desligada | #103–#113; `docs/operations/payment-link-runbook.md` |
| 8 — Compra, reservas e rifas | Integrada: ciclo de vida da rifa, compra online, venda no PDV, estorno, avisos e compradores, entrega de pedido pago online | #114–#119 |
| 9 — Gestão e indicadores | Integrada: indicadores por período, meta de arrecadação, auditoria e registro de segurança, desbloqueios, chaves funcionais, abertura do PDV pelo Portal, sessões ativas | #120–#124, #127–#129 |
| 10 — Campanhas operacionais | Código completo após auditoria: avisos, preferências, divulgação rastreável, eventos e campanhas, vitrine do Início e atribuição de vendas pagas e do PDV | #98–#102 e as PRs de eventos, vitrine e atribuição; `docs/product/ROADMAP.md` |
| Dívidas pré-RC | Resolvidas: testes unitários do Portal na CI (#125) e foundation E2E em banco limpo (#126) | `docs/product/GAP_ANALYSIS.md` |

## Portões de qualidade

Cada PR integrado passou por: `pnpm lint` (com orçamento de warnings), `pnpm typecheck`, `pnpm test:unit` (29 arquivos, 211 testes), `pnpm test:db` (pgTAP, ~1.990 testes), `pnpm test:integration`, `pnpm test:e2e --project=chromium`, `pnpm build` e `pnpm security:scan` na CI, seguidos de Quality pós-merge, Deploy Staging e smokes (saúde do Portal, PDV e jobs; catálogo público; catálogo pelo service binding do PDV; sessão anônima recusada no PDV).

## Revisão de migrations (`main..develop`)

- 84 migrations novas desde `main`; **nenhuma migration já integrada foi alterada ou removida**.
- **Nenhuma operação destrutiva de dados:** não há `drop table`, `drop column`, `truncate` nem `delete` fora de funções.
- Ocorrências revisadas, todas seguras:
  - `drop constraint` seguido da mesma constraint recriada em forma atualizada (compras, caixa, reservas, rifas);
  - `drop function` apenas para trocar assinaturas, com a nova função criada na mesma migration (checkout, reserva, insumos de preço legados);
  - `drop policy` para substituir políticas (imagens do catálogo) ou fechar leitura direta de números de rifa em favor de RPCs (privacidade);
  - `alter function … set schema private` / `rename`, sempre com a função pública substituta criada na mesma migration (estorno, detalhe de venda, processador da outbox);
  - `create or replace` de funções de leitura (extrato consolidado e indicadores) para incluir as linhas importadas do extrato PicPay, sem mudar assinatura nem dados;
  - `alter type … add value` em migrations próprias, antes do uso;
  - backfills pontuais (`profiles`, `raffle_campaigns.published_at`) e relaxamento de `not null` em `inventory_lots` (ampliação).
- O banco de produção é greenfield (sem dados legados). `supabase db push --dry-run` roda antes do `push` no workflow de produção.

## Segurança e privacidade

- RLS em todas as tabelas expostas; tabelas sensíveis sem grants (limites de autenticação, compradores de rifa, eventos de segurança, códigos de handoff).
- Segredos só no servidor; o front nunca recebe tokens do PicPay; o scan de segredos roda na CI.
- Auditoria investigável por correlação e registro de logins, falhas e acessos negados, sem senhas, tokens ou IPs.
- Handoff Portal→PDV por código de uso único de 60 s, guardado só como hash e transportado no fragmento da URL.
- Extrato PicPay importado sem guardar o arquivo bruto: só data, movimento, valor e descrição com números de documento mascarados, legíveis apenas por quem tem `finance.manage`. O extrato consolidado e a auditoria nomeiam o movimento, nunca a contraparte. O CSV real usado como referência de formato não está no Git; os testes usam fixture anonimizada.

## Acessibilidade

`e2e/accessibility.spec.ts` roda o axe (WCAG 2.1 A/AA) nas telas principais de cada papel: login, início, catálogo, reservas, rifas e perfil do consumidor; visão geral, indicadores, vendas, auditoria, configurações, usuários e rifas do administrador; PDV do vendedor. Antes de auditar, cria e publica uma rifa, para que as telas mostrem dados e não só o estado vazio. Falha em qualquer violação séria ou crítica. Na revisão de 30/09/2026 havia quatro, todas corrigidas: contraste do subtítulo do login; lista de definições inválida no cartão da rifa; área de rolagem principal sem acesso por teclado; rótulo ARIA sem papel no carregamento de usuários.

## Pendências que dependem do responsável

Nenhuma destas foi feita pelo agente, por exigir acesso, custo ou autorização externos:

1. **Alertas:** o destino escolhido é `germinatura@gmail.com`. Cadastrá-lo só como destinatário, sem guardar a senha dele em lugar nenhum do projeto: (a) nas notificações da conta Cloudflare, para os Workers `germinatura-portal-production`, `germinatura-pdv-production` e `germinatura-jobs-production`; (b) como membro da organização Supabase de produção, para receber os avisos de uso, saúde e backups; (c) nas notificações de falha dos workflows `deploy-production.yml` e `quality.yml`, pela conta GitHub que os dispara (Settings › Notifications › Actions) ou encaminhando-as a esse endereço. Outbox parada continua visível nas pendências de Indicadores e nos smokes; um alerta ativo para ela exige um serviço de envio de e-mail e fica para depois do primeiro deploy.
2. **Carga:** um teste de carga em staging, com volume e janela combinados (não executado para não afetar o ambiente compartilhado).
3. **Homologação física:** PDV nos dispositivos-alvo, maquininha e Área Pix, fechamento de caixa com contagem real.
4. **PicPay:** homologação do link de pagamento no sandbox (bloqueio externo). As credenciais de produção **não** foram usadas nem configuradas; a flag `payment_link` segue desligada, e o Worker `germinatura-jobs-production` será criado no primeiro deploy de produção sem os segredos do PicPay.
5. **E-mail institucional:** homologar o SMTP de produção para códigos de cadastro e recuperação.
6. **Promoção:** autorizar o PR `develop → main` e o disparo do deploy de produção.

### Depois do primeiro deploy

- **Backup e restauração:** a produção é greenfield e começa vazia, então restaurar backup não é condição para o primeiro deploy. A obrigação começa quando houver dados reais: confirmar o plano de backup do projeto Supabase de produção (Database › Backups) e restaurar um backup num projeto descartável, registrando data e resultado, antes de depender desses dados para fechamento financeiro.
- **Extratos PicPay:** importar os extratos reais da conta em Financeiro › Extrato PicPay e revisar as linhas pendentes.

## Roteiro da promoção (após autorização)

1. Abrir o PR `develop → main`, revisar o diff e aguardar a CI.
2. Fazer o squash merge e acompanhar o Quality em `main`.
3. Disparar `deploy-production.yml` com `confirm=PRODUCAO`. O workflow aplica lint, typecheck e testes unitários, configura a autenticação, roda `db push --dry-run` e `db push`, publica Portal, PDV e jobs e verifica a saúde dos três.
4. Rodar os smokes em produção (os mesmos de staging) e conferir login por papel.
5. Manter `payment_link` desligada até a homologação do PicPay.

## Reversão

- **Aplicação:** reverter o merge em `main` por um novo PR e disparar de novo o deploy de produção; os Workers voltam à versão anterior.
- **Banco:** as migrations são aditivas; a correção é por nova migration (forward-fix), nunca editando uma já aplicada. Dados financeiros e de estoque são ledgers imutáveis e se corrigem por lançamento compensatório.
- **Funcionalidades:** as chaves funcionais (Configurações) desligam recursos sem deploy, com motivo auditado.
