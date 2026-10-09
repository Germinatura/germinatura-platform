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
- **Fallback (desligado no PR 5).**
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

## Contexto da turma no Portal e no PDV (PR 3)

- **Um mecanismo só** (`apps/portal/lib/cohort-context.ts`):
  1. A seleção viaja no header `x-germinatura-cohort` (uuid ou `all`) ou, no navegador do Portal, no cookie httpOnly
     `germinatura_cohort`, gravado por `POST /api/v1/session/cohort` depois de o banco aceitar a turma. O header vence.
  2. O proxy do Portal resolve a sessão com essa seleção (`get_my_session` valida vínculo ativo ou ADMIN_MASTER).
     Seleção malformada → 400 `INVALID_COHORT_CONTEXT`; seleção que o banco não aceitou (turma inexistente, sem vínculo,
     `all` sem ADMIN_MASTER) → 403 `COHORT_FORBIDDEN`. Nas páginas, o cookie é apagado e a página recarrega.
  3. O proxy repassa à rota só a seleção validada, no mesmo header. Os clientes Supabase da rota o anexam a toda chamada,
     e `private.cohort_scope()` valida de novo. Nenhum `cohort_id` vindo do cliente é usado como autoridade.
- **Escrita exige turma concreta.** Fora de `COHORT`, o proxy recusa toda escrita com 409 `COHORT_REQUIRED`, exceto as
  rotas marcadas `cohort: "global"` em `api-security.ts`: perfil, sessões e notificações da própria pessoa, a seleção
  de turma, o bootstrap, a administração de turmas (`/api/v1/admin/cohorts`) e a concessão de ADMIN_MASTER. O banco
  recusa de novo (`cohort_write_id()`).
- **ADMIN_MASTER no Portal.**
  - A sessão traz `adminMaster`, `cohortMode`, `cohort` e `cohorts`. ADMIN_MASTER aparece como papel de sessão
    (`ADMIN_MASTER` em `roles`), nunca em `user_roles`.
  - O seletor de turma (barra abaixo do topo) lista as turmas da pessoa. Para ADMIN_MASTER, lista também "Todas as
    turmas", que é somente consulta.
  - `/admin/turmas` cria, renomeia, arquiva e reativa turmas. A gestão de usuários concede e revoga ADMIN_MASTER, com
    motivo auditado.
- **Gestão de usuários** (`list_cohort_users`, com a sessão da própria pessoa; o service role não lista mais ninguém):
  - ADMIN vê, conta e busca só pessoas da turma da requisição;
  - ADMIN_MASTER vê uma turma, ou todas em `all`, com filtro por turma e os papéis de cada turma separados;
  - filtros (busca, situação, cadastro, papéis com QUALQUER/TODOS) e paginação no servidor.
  - Operações sobre uma pessoa (papéis, vínculo, desbloqueios) exigem que ela pertença à turma da requisição; senão,
    `USER_NOT_FOUND`. Trazer alguém de outra turma é só do ADMIN_MASTER.
  - O provisionamento coloca a conta só na turma da requisição. A identidade recém-criada é marcada pelo Portal
    (`app_metadata.germinatura_provisioning`, gravável só pelo service role) e nunca entrou. Só ela sai da turma padrão,
    onde o trigger de cadastro a colocou. Pessoa existente nunca é reprovisionada.
- **PDV** (`apps/pdv/lib/pdv-cohort.ts`): opera sempre numa turma concreta, nunca em `all`.
  - A turma fica no cookie `germinatura_pdv_cohort`, revalidado pelo proxy do PDV em cada página com `get_my_session`
    na turma. A turma precisa estar aberta, e a pessoa precisa de ADMIN/VENDEDOR nela ou ser ADMIN_MASTER.
  - O `apiFetch` envia a turma como header ao Portal, que valida de novo. O cookie é legível pela página e não tem
    autoridade: qualquer valor alterado é recusado.
  - Entrada:
    - **handoff:** a turma vem do código de uso único gravado pelo Portal (`pdv_handoff_codes.cohort_id`), nunca da URL;
    - **senha:** se houver uma única turma elegível, ela é usada;
    - nos demais casos, a turma é escolhida em `/turma`, que lista só as turmas confirmadas pelo banco.
  - As rotas próprias do PDV (`/api/auth/login|handoff|cohort`) não são encaminhadas ao Portal pelo Worker.
  - A cópia offline do catálogo público é de cada turma (PR 5, ver "PDV offline" abaixo).
- **Fallback temporário (removido no PR 5, ver abaixo).** Sem seleção, o banco usa a Turma 2026 (`private.cohort_fallback_enabled()`).
  O Portal e o PDV não dependem mais dele para quem escolheu uma turma. Pontos que mudam no PR 5:
  - o interruptor no banco;
  - o comentário em `cohort-context.ts`;
  - o PDV, que já exige seleção explícita para mais de uma turma.

## Visão consolidada e vínculos (PR 4)

- **"Todas as turmas" é uma visão consolidada, não um contexto genérico.**
  - Fora das telas consolidadas, o proxy do Portal manda "Todas" para `/selecionar-turma`. A pessoa escolhe a turma
    explicitamente e volta à tela.
  - Uma API só lê em "Todas" se a regra dela estiver marcada `all: "read"`; qualquer outra leitura recebe 409
    `COHORT_REQUIRED`. Toda escrita que não seja global também é recusada, inclusive em rotas públicas. É fail-closed:
    uma rota ou tela nova nasce "só por turma".
  - Consolidado nunca soma turmas em um número único. Listas rotulam cada registro com a turma. Agregados são
    calculados dentro de cada turma, com a turma explícita no header, e mostrados lado a lado. A coluna "Soma dos livros"
    aparece só para métricas aditivas, nunca para caixa, margem ou ticket.
- **Inventário de telas** (`apps/portal/lib/consolidated-screens.ts`):

  | Tela | Em "Todas" | Motivo |
  |---|---|---|
  | Visão geral | Comparação lado a lado + evidência PicPay global | Cada turma pelo próprio livro |
  | Indicadores | Tabela por turma; soma só do aditivo | Margem, ticket e caixa não se somam; caixa do livro não é saldo bancário |
  | Vendas | Lista com a turma de cada venda; filtro por turma; estorno exige a turma | Cada venda pertence a uma turma |
  | Auditoria | Turma de cada registro (Global para operações globais); filtro por turma | Leitura pura |
  | Usuários | Turmas e papéis por turma; vínculos (ADMIN_MASTER) | Dados relacionais por turma |
  | Turmas | Vínculos, papéis e operações em aberto | Operação global |
  | Saldo, extrato, importação, conciliação PicPay | Só por turma | A conta PicPay é global e o extrato não se divide em saldos por turma; a atribuição acontece dentro de uma turma |
  | Contas a pagar, lançamentos, turnos, maquininhas, pagamentos online | Só por turma | Livro de uma turma; somar sugeriria um caixa único |
  | Estoque, lotes, fechamentos, compras | Só por turma | Operações nos locais de uma turma |
  | Catálogo, promoções, reservas, rifas, comunicação e eventos, configurações | Só por turma | Cada turma tem os próprios produtos, campanhas, públicos e módulos |

- **Conta PicPay.** No consolidado, a conta aparece como evidência global: extratos, entradas e saídas, linhas pendentes,
  linhas classificadas como globais e linhas atribuídas a cada turma (`picpay_evidence_overview`). Nenhum saldo por turma
  é derivado do extrato.
- **Vínculos.** `user_cohorts` + `user_roles` por turma; nunca um array no perfil.
  - ADMIN_MASTER vê todas as turmas de uma pessoa (`user_cohort_memberships`).
  - Ele adiciona, inativa e reativa vínculos e atribui papéis separadamente em cada turma. Cada ação vai para a turma
    escolhida pelo header, nunca para "Todas".
  - Inativar um vínculo (`set_cohort_membership(false)`) é recusado, com `MEMBERSHIP_HAS_OPEN_OPERATIONS`, quando a
    pessoa tem naquela turma:
    - turno de caixa aberto;
    - estoque no local de vendedor;
    - transferência ou devolução pendente;
    - venda aguardando pagamento;
    - ou quando é o último ADMIN ativo da turma.
  - A revogação imediata de acesso (`set_user_access` com `active=false`) continua sempre possível, por segurança.
  - O vínculo inativo e os papéis ficam como histórico, e cada mudança é auditada na turma.
- **Turmas.**
  - `cohort_overview` mostra vínculos ativos e inativos, pessoas por papel e operações em aberto.
  - Arquivar é recusado (`COHORT_HAS_OPEN_OPERATIONS`) enquanto houver turno aberto, venda ou pagamento pendente, link de
    pagamento ativo, reserva, transferência, aprovação pendente ou rifa ativa.
  - A troca de turma padrão ficou para o PR 5. Correção registrada no PR 5: as colunas `cohort_id` já não tinham
    default desde o PR 2; a dependência implícita estava no guard de escrita e no fallback de escopo.

## Contexto explícito e turma padrão (PR 5)

- **Nenhum registro cai numa turma por ausência de contexto.**
  - Desde o PR 2 nenhuma coluna `cohort_id` tem default. A dependência implícita estava em três lugares:
    - o guard de escrita completava a turma ausente com a turma padrão quando quem escrevia era sistema ou service role;
    - o fallback de escopo dava a turma padrão a quem chegava sem turma;
    - o cadastro gravava o papel `CONSUMIDOR` sem turma.
  - Os três foram removidos (`20261023090000`).
  - Escrita em tabela por turma sem turma determinável falha com `COHORT_REQUIRED`.
  - Auditoria e outbox: `NULL` só para tipo de entidade classificado como global; o resto sem turma falha.
- **Classificação dos fluxos:**

  | Categoria | Fluxos | Como a turma chega |
  |---|---|---|
  | Operação global | Turmas, turma padrão, ADMIN_MASTER, perfil, sessões, notificações, login e senha, evidência PicPay (extratos), identidade de maquininha, flags globais | Sem turma (auditoria `cohort_scope = GLOBAL` ou tipo global classificado) |
  | Turma explícita obrigatória | Toda escrita em tabela por turma pelo Portal, PDV, workers e RPCs; provisionamento; handoff | Header ou cookie validados; vínculo único resolvido; linha-pai; `enter_cohort_context` do evento no worker; parâmetro explícito (`p_cohort_id`) |
  | Pública com turma resolvida | Catálogo e cotação anônimos; links `/d/`; cadastro novo | Turma padrão ATIVA, ou slug resolvido no servidor (`resolve_public_cohort`), ou a turma da campanha do link (`record_share_visit`) |
  | Migração / legado | Backfill do PR 1, verificação de integridade, seed local, fixtures de teste, ferramenta de upgrade | `private.bootstrap_cohort_id()` e contexto explícito do seed |

- **Sem turma determinável:**
  - quem tem exatamente um vínculo ativo tem a turma resolvida pelo vínculo (determinístico, não é default);
  - ADMIN_MASTER e quem tem várias turmas ficam em `NONE`, e o Portal manda para `/selecionar-turma`;
  - o PDV já exigia turma explícita.
- **Turma padrão:**
  - serve para a entrada pública (visitante e cadastro novo), nunca como destino de escrita;
  - o ADMIN_MASTER define (`set_default_cohort`), com motivo e auditoria global;
  - existe exatamente uma, sempre ATIVA: índice único mais trigger `cohorts_default_active`;
  - não pode ser arquivada nem voltar a PREPARING sem antes escolher outra;
  - trocas concorrentes são serializadas (lock nas linhas de `cohorts`).
- **Visitantes:**
  - sem referência, veem a turma padrão;
  - com `?turma=<slug>`, o servidor resolve o slug para uma turma ATIVA; slug desconhecido, malformado, PREPARING ou ARCHIVED responde 404, sem cair na padrão;
  - um `cohort_id` da URL nunca é aceito;
  - o slug segue uma regra única: de 1 a 32 caracteres, letras minúsculas, números e hífen, começando e terminando com letra ou número;
    - a mesma regra vale no banco (`cohorts_slug_check`), no contrato (`COHORT_SLUG_PATTERN`), na API, no formulário, no `?turma=` e no service worker do PDV;
    - o slug é definido na criação e nunca é editado;
  - o link `/d/<código>` resolve a campanha e a turma no servidor, registra a visita nela e abre o catálogo com o slug;
  - logado, o `?turma=` só seleciona a turma se a pessoa tiver vínculo nela; senão, é descartado.
- **Cadastro novo:** entra na turma padrão ATIVA. O vínculo e o papel `CONSUMIDOR` são gravados explicitamente nessa turma. Sem turma padrão ativa, o cadastro falha.
- **Storage:** as políticas de imagens de produto, capas de evento e fotos de perda exigem que a entidade do caminho esteja na turma da requisição (`storage_entity_in_scope`).
- **Revogação imediata:**
  - "Conta ativa" continua revogando na hora, e o retorno lista as pendências (`pending_operations`), sem alterá-las;
  - outro ADMIN ou o FINANCEIRO assume pelas ferramentas da turma: `close_seller_shift_on_behalf` (novo, justificativa obrigatória, auditoria com o vendedor), `transfer_stock`, `cancel_sale`, `resolve_seller_stock_transfer`, `resolve_stock_return`.
- **Menu em "Todas":** itens só por turma aparecem marcados "por turma", com o motivo; nada é escondido.
- **PDV offline (Cache Storage do service worker):**
  - Uma cópia por turma concreta, no cache `germinatura-pdv-catalog-v2:<id da turma>`. Não existe cópia anônima, compartilhada ou da turma padrão; a ativação apaga a cópia única da versão anterior (`-v1`).
  - A home do PDV pede a cópia da turma da sessão. O worker busca o catálogo público dessa turma sem sessão (`?turma=<slug>`) e só grava se o Portal responder com a mesma turma no header `x-germinatura-cohort`. Uma resposta 404 (turma não pública) apaga a cópia daquela turma.
  - A tela offline lê o cookie `germinatura_pdv_cohort` e abre só o cache dessa turma. A cópia precisa dizer a mesma turma, e as imagens também vêm desse cache.
  - Sem turma concreta (nenhuma, `all` ou valor malformado), ou sem cópia da turma, nada aparece. Cópia vencida (24 h) também não aparece. Nunca se mostra a cópia de outra turma.
  - Trocar de turma não reaproveita cópia. Sair do PDV, abrir o login ou concluir um login/handoff apaga todas as cópias; sair também apaga o cookie de turma.
  - **Outras persistências locais revisadas:**
    - O carrinho de reserva do Portal (`sessionStorage`) agora é um por turma; sem turma, não é guardado.
    - O cookie de origem dos links `/d/` guarda só o código da campanha. A atribuição o procura pela view da turma da requisição, então o código de outra turma é ignorado.
    - Os demais itens são preferências de interface ou o e-mail do cadastro, sem dado por turma.
- **O que ainda menciona a Turma 2026, e por quê:**
  - `private.bootstrap_cohort_id()`: id fixo do bootstrap, usado só nas migrations históricas do PR 1 e do PR 2 e na checagem "a turma de bootstrap existe" do relatório de integridade;
  - seed local e fixtures de teste: nomeiam a Turma 2026 explicitamente;
  - ferramenta de upgrade e spike: base histórica;
  - a turma padrão atual é a Turma 2026, por escolha explícita, trocável pelo ADMIN_MASTER.
  - Nenhum fluxo de produção, online ou offline, atribui 2026 ou a turma padrão por ausência de contexto.

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
2. `20261019090100_cohort_scope_columns`: adiciona `cohort_id` anulável com **default constante** da Turma 2026 (o PR 2
   removeu esses defaults; nenhuma coluna `cohort_id` tem default hoje).
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

5. PR 3: `20261021090000_cohort_context_api`.
   - Coluna anulável `pdv_handoff_codes.cohort_id`; os códigos antigos ficam `NULL` e valem só 60 s.
   - `list_cohort_users`.
   - Os quatro RPCs de pessoa passam a envoltórios que checam a turma; as versões originais vão para `private`, sem
     mudança.
   - Provisionamento com turma.
   - A migration é aditiva e não altera nenhuma linha.

6. PR 4: `20261022090000_cohort_consolidated`.
   - Só funções; nenhuma tabela, coluna ou linha muda. A migration tem pré-checagens fail-closed.
   - Novas: `membership_blockers`, `user_cohort_memberships`, `cohort_open_operations`, `cohort_overview`,
     `picpay_evidence_overview` e `audit_log_cohorts`.
   - Substituídas, com a mesma assinatura: `set_cohort_membership` (trava de operações em aberto) e `update_cohort`
     (trava de arquivamento).

7. PR 5: `20261023090000_cohort_explicit_context`.
   - Só funções, um trigger em `cohorts` e políticas de Storage (`ALTER POLICY`); nenhuma linha muda.
   - Pré-checagens:
     - exatamente uma turma padrão, e ATIVA;
     - nenhuma linha por turma sem turma;
     - nenhum default em `cohort_id`;
     - relatório de integridade limpo.
   - Pós-checagens: fallback desligado; guard sem referência à turma padrão.
   - Também corrige `list_my_share_links`, com a mesma assinatura: campanha da equipe (sem vendedor) volta `mine: false`, não `null`. O `null` derrubava a tela "Divulgação" do PDV sempre que a Comunicação criava uma campanha na turma.

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
