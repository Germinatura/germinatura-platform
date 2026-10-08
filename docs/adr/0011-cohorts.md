# ADR 0011 — Turmas (multi-turma) e ADMIN_MASTER

- Status: ACCEPTED. Fundação de dados (PR 1) integrada; autorização e isolamento (PR 2) implementados sobre o mecanismo provado pelo spike de 08/10/2026.
- Data: 2026-10-08
- Aprovação: proposta técnica da Fase A, com os ajustes do responsável pelo projeto de 08/10/2026.

## Decisão

**Um único banco e domínio, com segregação lógica e de segurança por turma.** O Germinatura não é um SaaS multi-tenant
genérico: as turmas (2026, 2027, …) são gerações da mesma organização e compartilham a identidade, o catálogo de papéis,
a infraestrutura e a conta PicPay Empresas. Cada turma é dona de suas operações, seus livros e suas configurações.

- `cohorts` guarda as turmas: nome, ano (único), slug (único, `[a-z0-9-]`), status `PREPARING | ACTIVE | ARCHIVED` e `is_default`.
  Existe exatamente uma turma padrão, que nunca está arquivada. Ela atende o visitante anônimo e recebe os novos cadastros.
- A identidade continua global. `user_cohorts (user_id, cohort_id, status, joined_at)` registra a participação. Uma
  pessoa pode participar de várias turmas sem duplicar a conta de autenticação.
- **Turma 2026 de bootstrap.** O identificador fixo é `c0000000-0000-4000-8000-000000002026`, devolvido por
  `private.bootstrap_cohort_id()`. A criação é determinística e idempotente, sem UUID gerado em runtime. Todos os dados
  operacionais existentes pertencem a ela, e toda identidade existente participa dela.

## Classificação das entidades

A classificação fica em `private.cohort_scoped_tables`, a fonte única usada pela expansão, pelo relatório de integridade
(`private.cohort_integrity_report()`) e pelo teste de upgrade.

**Por turma** (73 tabelas, `cohort_id` desde o PR 1):

| Domínio | Tabelas |
| --- | --- |
| Catálogo | `categories`, `products`, `product_prices`, `product_images`, `product_stock_alerts` |
| Promoções e cupons | `promotions` e regras (`promotion_*`), `promotion_versions`, `promotion_redemptions` |
| Estoque | `stock_locations`, `inventory_balances`, `inventory_lots`, `inventory_lot_balances`, `inventory_lot_cost_states`, `stock_movements`, `stock_movement_items`, `stock_movement_lot_allocations`, `stock_reservations`, `stock_reservation_items`, `inventory_counts`, `inventory_count_items`, `stock_loss_reports`, `stock_return_requests`, `seller_stock_transfer_requests`, `stock_loss_settings` |
| Compras | `purchase_orders`, `purchase_order_items`, `purchase_receipts`, `purchase_payable_entries`, `purchase_payable_settlements` |
| Vendas e pagamentos | `sales`, `sale_items`, `sale_status_history`, `sale_attributions`, `payment_attempts`, `payment_attempt_status_history`, `payment_reconciliations`, `financial_ledger_entries`, `payment_link_charges`, `payment_link_charge_events` |
| Caixa | `seller_shifts`, `cash_movements`, `seller_closeouts`, `seller_closeout_payment_summaries`, `seller_closeout_stock_counts` |
| Financeiro da turma | `finance_manual_entries`, `finance_opening_positions`, `finance_opening_position_lines`, `fundraising_goal` |
| Reservas | `commercial_reservations`, `reservation_attributions`, `reservation_settings` |
| Rifas | `raffle_campaigns`, `raffle_numbers`, `raffle_draws`, `raffle_sale_buyers`, `raffle_sale_refunds` |
| Comunicação e eventos | `portal_events`, `portal_highlights`, `announcements`, `announcement_recipients`, `share_campaigns`, `share_visits` |

As tabelas filhas também recebem `cohort_id`, igual ao do pai. Assim o isolamento e os índices não dependem de JOIN, e o
relatório de integridade confere essa igualdade em cada chave estrangeira entre tabelas por turma.

**Globais:**
- identidade: `profiles`, `profile_preferences`, `notification_preferences`, `pdv_handoff_codes`, limites de recuperação e cadastro;
- segurança: `security_events`, `institutional_*`;
- catálogo de RBAC: `roles`, `permissions`, `role_permissions`;
- infraestrutura: `idempotency_keys`, `broadcast_notices`;
- inbox pessoal: `notifications`;
- **evidência externa do provedor:** `payment_webhook_receipts`, `payment_webhook_deliveries`, `payment_webhook_outcomes`,
  `picpay_source_imports`, `picpay_transactions`, `picpay_transaction_observations`, `picpay_receivable_installments`,
  `picpay_receivable_observations`, `picpay_statement_imports`, `picpay_statement_lines`,
  `picpay_statement_line_observations`, `picpay_statement_duplicate_conflicts`.

**Decididas com a autorização (PR 2, decisões de 08/10/2026):**

| Tabela | Decisão |
| --- | --- |
| `user_roles` | Por turma: o papel vale na turma em que foi concedido. |
| `suppliers` | Por turma, sem cadastro institucional compartilhado nesta etapa. |
| `finance_balance_checks` | Por turma: a conferência valida o livro e o saldo de uma turma. |
| `payment_terminals` | **Identidade global** (dispositivo físico que atravessa gerações), código único global e histórico preservado. A turma é autorizada por `cohort_payment_terminals (cohort_id, terminal_id, active)`, e o mesmo terminal pode atender várias turmas sem ser duplicado. |
| `feature_flags` | Catálogo global. Classificação pelo efeito encontrado no código: `payment_link`, `picpay_checkout`, `picpay_tap` e `meal_voucher` são infraestrutura ou credenciamento compartilhado, logo GLOBAIS e alterados só por ADMIN_MASTER. As demais (módulos e meios de pagamento da turma) valem por turma em `cohort_feature_flags`. |
| `picpay_transaction_links`, `picpay_statement_line_resolutions`, `payment_recovery_items`, `payment_link_refund_requests`, `payment_link_provider_refunds` | Atribuição com turma anulável: `NULL` = não atribuída; caso contrário, a turma da venda, tentativa ou lançamento atribuído. |
| `audit_logs`, `outbox_events` | Turma anulável: `NULL` = operação realmente global (identidade, turmas, ADMIN_MASTER, flags globais, identidade de terminal, importação de evidência). O histórico anterior às turmas pertence à Turma 2026. |
| `picpay_exception_resolutions`, `picpay_reconciliation_periods(_events)` | Continuam globais: tratam a conta e a evidência, não a atribuição a uma turma. |

## Financeiro: livros por turma, evidência PicPay global

A conta PicPay Empresas pode receber, no mesmo período e no mesmo arquivo exportado, operações de mais de uma turma.

- **Evidência externa é global:**
  - arquivos importados e seu SHA-256;
  - transações de Minhas vendas e suas observações;
  - recebíveis;
  - linhas do Extrato e sua deduplicação;
  - identificadores externos (`transaction_ref`, NSU).

  As garantias atuais continuam valendo: SHA único, `transaction_ref` único, deduplicação e idempotência. Um CSV é
  importado **uma única vez**, nunca uma vez por turma.
- **Atribuição e resultado são por turma:**
  - vendas e tentativas de pagamento;
  - receitas e despesas;
  - recebíveis internos e taxa atribuída à venda;
  - posição de abertura e saldos internos;
  - fechamentos e resultado.

  Uma transação PicPay ligada a uma venda tem a turma derivada da venda ou da tentativa de pagamento. Uma evidência sem
  vínculo fica global/não atribuída até a conciliação. O PR 2 modela o vínculo e a resolução como atribuição por turma.
- Para a Turma 2026, o comportamento de produção fica preservado integralmente: todos os livros e atribuições
  existentes são dela.

## Autorização (PR 2)

- **Contexto da requisição.**
  - O header `x-germinatura-cohort` traz um uuid ou `all` e é validado no banco por `private.cohort_scope()`.
  - `all` vale só para ADMIN_MASTER e só para leitura e agregação.
  - Toda escrita em tabela por turma exige uma turma concreta (`COHORT_REQUIRED`), inclusive para ADMIN_MASTER.
  - Operações sobre o catálogo global (criar ou arquivar turmas, conceder ADMIN_MASTER, identidade de terminal, flags
    globais) não pertencem a uma turma e são auditadas com turma `NULL`.
- **Fallback.**
  - Sem header, a requisição cai na Turma 2026. Isso é **só compatibilidade de rollout**
    (`private.cohort_fallback_enabled()`), restrita no PR 5.
  - O estado final já está implementado e testado atrás desse interruptor:
    - quem tem exatamente uma turma acessível tem a turma inferida;
    - quem tem várias precisa de contexto explícito;
    - ADMIN_MASTER nunca tem a turma inferida;
    - sem turma determinável, a requisição falha fechada.
- **RBAC.** `has_permission` exige ADMIN_MASTER, ou um papel na turma da requisição mais vínculo ativo nela.
  `get_my_session` informa os papéis da turma, a turma, o modo (`COHORT`/`ALL`/`NONE`), as turmas acessíveis e
  `admin_master`.
- **ADMIN_MASTER** é explícito (`admin_masters`, uma linha por pessoa) e não depende de `user_roles`.
  - Tem todas as turmas e todas as permissões, inclusive `cohorts.manage`.
  - É concedido e revogado só por outro ADMIN_MASTER (`set_admin_master`), e o último ativo não pode ser revogado.
  - **Bootstrap da capacidade global de administração:** é concedido a
    `institutional_bootstrap_state.completed_by`, de forma fail-closed. Com o bootstrap concluído, a migration
    exige que a identidade exista, esteja ativa e tenha onboarding concluído; senão, aborta sem fallback. Com o
    bootstrap pendente, `bootstrap_first_admin` concede no momento do bootstrap.
- **Vínculo.**
  - Desativar uma pessoa numa turma tira só o acesso àquela turma.
  - Sem nenhum vínculo ativo (e sem ser ADMIN_MASTER), a sessão é inativa, como era a desativação global.
- **Fan-out.**
  - Avisos chegam só aos membros ativos da turma.
  - O worker processa cada evento dentro da turma do evento, então `staff_with_permission` e as demais buscas de
    destinatários ficam restritas a ela.
- **Unicidades por turma:**
  - slug de categoria e de produto; SKU;
  - código de promoção e de cupom;
  - local central ativo; local do vendedor; turno aberto do vendedor;
  - documento de fornecedor;
  - versão da posição de abertura;
  - papel.

  Singletons por turma: meta de arrecadação, configuração de reservas e configuração de perdas. Identificadores de
  evidência externa e códigos públicos (link de compartilhamento, número de pedido do Payment Link, código de
  terminal) continuam globais.

## Resultado do spike de isolamento (08/10/2026)

O spike (`tools/spikes/cohort-isolation`; evidências em `REPORT.md`) converteu um recorte real com ledgers, triggers,
FKs nos dois sentidos, auto-FK e identity, em banco descartável. Resultado:

- isolamento 49/49 nos três cenários (banco limpo, banco populado e banco restaurado do backup), pela view, pela tabela
  base com RLS e pelos RPCs `SECURITY DEFINER` atuais, sem alterá-los;
- as 90 suítes pgTAP existentes passam sobre o banco convertido, salvo as verificações estruturais que procuram tabela
  em `public`;
- a conversão sobre banco populado preserva todas as linhas, valores e tuplas;
- a Data API funciona via HTTP real, inclusive embedding por FK através das views; o schema base não é exposto;
- **Realtime:** hoje não há tabela publicada nem assinatura no código. A view não pode ser publicada; a tabela base
  pode, e cada assinante recebe só os eventos das turmas em que participa, inclusive o anônimo, que recebe só a turma
  padrão;
- backup e restauração pelo procedimento corrigido do runbook (migrations + `data.sql`) reproduzem exatamente o banco.

**Decisão:** o PR 2 adota tabela base em `cohort_data` + view filtrada + policy restritiva por vínculo + guard de
escrita, com os tratamentos listados no README do spike:
- funções com assinatura no tipo-linha;
- views dependentes;
- default privileges;
- testes estruturais;
- ferramentas que enumeram `public`;
- guard de publicação.

Não é necessária arquitetura híbrida para preservar Realtime.

## Migração em produção (expand → backfill → validate → constrain)

1. `20261019090000_cohort_foundation`: cria `cohorts`, a Turma 2026, `user_cohorts` com o backfill dos perfis, o
   vínculo automático de novas identidades na turma padrão e a classificação.
2. `20261019090100_cohort_scope_columns`: adiciona `cohort_id` anulável com **default constante** da Turma 2026.
   - No PG ≥ 11, isso só altera o catálogo: nenhuma linha é reescrita e os ledgers imutáveis não recebem `UPDATE`.
   - A FK entra como `NOT VALID`.
   - `lock_timeout` de 5 s.
3. `20261019090200_cohort_scope_validation`:
   - backfill explícito e idempotente (no-op);
   - `VALIDATE` das FKs;
   - `private.cohort_integrity_report()`, que aborta a migration se houver qualquer violação.
4. PR 2, em três migrations:
   - `20261020090000_cohort_classification` expande as tabelas decididas. O histórico de atribuição e de log fica na
     Turma 2026 por default de catálogo, sem `UPDATE`: os vínculos e as resoluções PicPay são imutáveis.
   - `20261020090100_cohort_authorization` cria o contexto, o ADMIN_MASTER, o RBAC por turma e os guards.
   - `20261020090200_cohort_isolation`:
     - aborta antes de alterar qualquer coisa se houver publicação inesperada;
     - converte as 85 tabelas e aplica `NOT NULL`, unicidades e singletons por turma;
     - religa as views dependentes e recria as 15 funções de tipo-linha;
     - roda o relatório de integridade, que aborta a migration se houver violação.

Nenhuma migration é destrutiva. O teste de upgrade (`pnpm test:upgrade`, que roda na CI) prova a preservação sobre o
schema anterior populado. O runbook é `docs/operations/cohort-cutover-runbook.md`.

## Consequências

- Turma nova = linha em `cohorts` + vínculos + papéis. Não há banco, schema ou deploy por turma.
- Toda tabela operacional nova precisa ser classificada: entrar em `private.cohort_scoped_tables` com `cohort_id` ou
  ser documentada como global neste ADR.
- **Convenção para migrations depois do PR 2:**
  - Tabelas por turma são alteradas em `cohort_data.<tabela>`, seguidas de
    `select private.refresh_cohort_view('<tabela>')`. Um `ALTER TABLE public.<tabela>` falha, porque é uma view.
  - Uma tabela nova por turma entra em `private.cohort_scoped_tables` e passa pela mesma conversão: view, policy
    restritiva e guard.
  - `private.cohort_view_drift()` e o relatório de integridade (pgTAP) acusam qualquer divergência.
  - Funções não devem usar o tipo-linha da tabela base na assinatura.
  - Ferramentas que enumeram tabelas consideram `public`, `cohort_data` e `private`.
- O Realtime, quando for preciso, publica a tabela base em `cohort_data`, só onde houver necessidade real. A policy
  restritiva por escopo autoriza cada assinante, e o cliente entrega o JWT antes do join.
- Agregações em "Todas as turmas" somam apenas métricas que fazem sentido somadas e mostram sempre a quebra por turma.
- Ranking, fidelidade, comunidade nova e acréscimos por meio de pagamento serão construídos sobre esta fundação.
  Nada disso faz parte desta etapa.
