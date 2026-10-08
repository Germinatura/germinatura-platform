# ADR 0011 — Turmas (multi-turma) e ADMIN_MASTER

- Status: ACCEPTED (fundação de dados, PR 1). A autorização por turma e o mecanismo de isolamento são PROPOSED até o spike do PR 2.
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

**Decididas no PR 2, com o modelo de autorização:**

| Tabela | Questão em aberto |
| --- | --- |
| `user_roles` | Papel por turma. |
| `audit_logs`, `outbox_events` | `cohort_id` anulável; nulo significa operação global. |
| `feature_flags` | Separar chaves globais (integrações e homologação) de chaves por turma (módulos). |
| `suppliers` | Cadastro compartilhado ou por turma. |
| `payment_terminals` | Equipamento físico. |
| `finance_balance_checks` | Saldo observado da conta × saldo interno da turma. |
| `payment_recovery_items`, `payment_link_refund_requests`, `payment_link_provider_refunds` | Venda opcional: a evidência fica sem atribuição até o vínculo. |
| `picpay_transaction_links`, `picpay_statement_line_resolutions`, `picpay_exception_resolutions`, `picpay_reconciliation_periods`, `picpay_reconciliation_period_events` | Atribuição da evidência ou fechamento da conta. |

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

## Autorização (PR 2, sem efeito no PR 1)

- RBAC por turma: usuário + turma + papel. `user_roles` ganha a turma, e `has_permission` passa a avaliar a turma do
  contexto. Um ADMIN comum administra apenas as turmas em que recebeu o papel.
- **ADMIN_MASTER** é modelado explicitamente, sem bypass de RLS:
  - acesso a todas as turmas;
  - cria, altera, arquiva e reativa turmas;
  - gerencia vínculos e papéis;
  - continua autenticado, auditado como ator normal e sujeito às proteções do domínio.
- **Bootstrap da capacidade global de administração.** O primeiro ADMIN_MASTER é
  `institutional_bootstrap_state.completed_by`, de forma fail-closed. A migration falha com mensagem explícita, sem
  fallback para outro administrador, se o campo estiver vazio, se o perfil não existir ou se a identidade estiver
  inativa ou sem onboarding.
- **Contexto da turma.** Cada requisição declara a turma (uuid) ou `all`, e o banco valida o vínculo ou o
  ADMIN_MASTER. `all` serve só para leitura e agregação. Toda escrita exige uma turma concreta.
- **Fallback.** Sem turma declarada, a requisição cai na Turma 2026. Isso é **apenas compatibilidade de rollout**,
  restrito no PR 5. No estado final:
  - quem participa de exatamente uma turma tem a turma inferida;
  - quem participa de várias precisa de contexto explícito;
  - o ADMIN_MASTER sem turma selecionada nunca escreve em 2026 por acidente.
- **Isolamento.** As funções `SECURITY DEFINER` pertencem a `postgres`, que tem `BYPASSRLS`, então RLS sozinho não
  isola os RPCs. O candidato é "tabela base em schema não exposto + view filtrada `security_invoker` com o nome atual
  + trigger de escrita". Só será adotado depois da prova automatizada do spike do PR 2, que inclui Realtime,
  publications, Data API, grants, policies, OID/regclass, migrations posteriores, backup/restore e diff de schema.
  Uma arquitetura híbrida é aceitável onde a prova exigir.

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
4. `NOT NULL`, o default por contexto e as restrições por turma ficam para o PR 2, depois da validação em staging e
   em produção.

Nenhuma migration é destrutiva. O teste de upgrade (`pnpm test:upgrade`, que roda na CI) prova a preservação sobre o
schema anterior populado. O runbook é `docs/operations/cohort-cutover-runbook.md`.

## Consequências

- Turma nova = linha em `cohorts` + vínculos + papéis. Não há banco, schema ou deploy por turma.
- Toda tabela operacional nova precisa ser classificada: entrar em `private.cohort_scoped_tables` com `cohort_id` ou
  ser documentada como global neste ADR.
- Agregações em "Todas as turmas" somam apenas métricas que fazem sentido somadas e mostram sempre a quebra por turma.
- Ranking, fidelidade, comunidade nova e acréscimos por meio de pagamento serão construídos sobre esta fundação.
  Nada disso faz parte desta etapa.
