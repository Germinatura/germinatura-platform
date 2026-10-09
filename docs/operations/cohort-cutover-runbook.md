# Runbook — multi-turma (cutover das migrations de turmas)

Referências: ADR 0011 (`docs/adr/0011-cohorts.md`), teste de upgrade (`tools/upgrade-check`), relatório de integridade
(`private.cohort_integrity_report()`).

> Nada aqui é executado em produção sem autorização explícita do responsável. O agente prepara e valida em local e
> staging, e para antes da produção.

## Identificadores de bootstrap

| Item | Valor |
| --- | --- |
| Turma 2026 | `c0000000-0000-4000-8000-000000002026` (`private.bootstrap_cohort_id()`), slug `2026`, ano 2026, `ACTIVE`, padrão |
| Primeiro ADMIN_MASTER (PR 2) | `institutional_bootstrap_state.completed_by`, fail-closed, sem fallback |

## Fase 1 — fundação de dados (PR 1)

### Migrations e impacto esperado

| Migration | O que faz | Bloqueio |
| --- | --- | --- |
| `20261019090000_cohort_foundation` | Cria `cohorts`, Turma 2026, `user_cohorts` + backfill dos perfis, vínculo automático de novos cadastros, `private.cohort_scoped_tables` | Só objetos novos, mais um trigger `AFTER INSERT` em `profiles` |
| `20261019090100_cohort_scope_columns` | `cohort_id uuid` anulável com default constante da Turma 2026 em 73 tabelas, FK `NOT VALID` | `ACCESS EXCLUSIVE` por milissegundos em cada tabela (só catálogo, sem reescrita); `lock_timeout` 5 s |
| `20261019090200_cohort_scope_validation` | Backfill idempotente (no-op), `VALIDATE` das FKs, relatório de integridade e aborto se houver violação | `SHARE UPDATE EXCLUSIVE` durante a varredura de validação |

**O que muda:**
- Nenhuma linha existente é reescrita, e os hashes e versões de tupla ficam idênticos (provado pelo teste de upgrade).
- Toda leitura de linha existente passa a mostrar `cohort_id = Turma 2026`.
- Linhas novas recebem a Turma 2026 pelo default.

**O que não muda:**
- A autorização é a mesma.
- `cohorts` e `user_cohorts` ficam fechadas para anon/authenticated.
- O aplicativo em produção continua igual. As respostas que devolvem linhas inteiras passam a incluir `cohort_id`, e
  os contratos do Portal descartam chaves desconhecidas.

**Duração medida:**
- local, com o dataset do teste de upgrade (27 mil linhas): `migration up` em 1,5–4 s;
- produção (volume bem menor): esperado abaixo de 5 s.

Se uma transação longa segurar uma tabela, o `lock_timeout` faz a migration falhar em 5 s. Nesse caso ela é desfeita
por inteiro (cada arquivo roda numa transação). Repita num horário calmo.

### Checklist antes da produção

- [ ] PR 1 integrado em `develop`, com Quality verde, incluindo o passo "Upgrade check" e o relatório no resumo do job.
- [ ] Deploy Staging verde, smokes verdes e relatório de integridade de staging sem violações (consulta abaixo).
- [ ] Backup feito **e** verificado (seção seguinte).
- [ ] Snapshot "antes" de produção salvo (`before.json`).
- [ ] Janela calma, sem venda em andamento, de preferência fora de evento.
- [ ] Autorização explícita do responsável para a promoção `develop → main` e o deploy de produção.

### Backup (compatível com o Supabase atual, plano Free)

O plano Free não garante backup baixável pelo painel. Confira **Database › Backups**: se houver backup listado, anote
data e hora. O **backup obrigatório** é o dump lógico, feito pelo responsável, na máquina dele:

```bash
supabase link --project-ref <ref-de-producao>
```
```bash
supabase db dump --linked -f backup-AAAAMMDD/data.sql --data-only --use-copy -x storage.buckets_vectors,storage.vector_indexes
```

As duas tabelas excluídas são internas do Storage (vetores), vazias e graváveis só pela plataforma.
```bash
supabase db dump --linked -f backup-AAAAMMDD/schema.sql
```

Na mesma hora, salve também o snapshot de produção (`before.json`, seção seguinte) e a versão das migrations aplicadas:

```sql
select max(version) from supabase_migrations.schema_migrations;
```

Regras do dump:
- A senha do banco é digitada no prompt do `link`. Nunca vai para Git, chat, log, PR ou documento.
- Os arquivos ficam **fora** do repositório: o `.gitignore` não é proteção suficiente para dados reais.
- Calcule o SHA-256 de cada arquivo (`sha256sum backup-AAAAMMDD/*.sql`) e anote os valores junto com data e hora.

**O schema vem das migrations, não do `schema.sql`.** O `supabase db dump` exclui os schemas `auth` e `storage`.
Por isso o `schema.sql` não contém:
- as policies de Storage criadas pelas migrations (fotos de perfil, imagens de produto, fotos de perda, capas de evento);
- o trigger de cadastro em `auth.users`.

Uma restauração "roles + schema + data" deixaria os arquivos sem regras de acesso e quebraria o cadastro. Isso foi
comprovado pelo spike de isolamento (`tools/spikes/cohort-isolation`). O `schema.sql` serve só de referência para diff.

**Verificação do backup** (sem tocar produção): restaure num Supabase local descartável e compare com produção.
O mesmo roteiro, com as credenciais do projeto novo, vale para um desastre real.

1. Faça o checkout local do commit que está em produção (mesmas migrations; a versão anotada acima deve ser a última).
2. `pnpm supabase:start`, depois `node tools/run-supabase.mjs db reset --no-seed`. Isso aplica todas as migrations sem
   dados de exemplo e cria o schema completo, inclusive Storage e `auth`.
3. Esvazie os dados da aplicação e os buckets criados pelas migrations, que voltam pelo dump:
   ```bash
   echo "do \$\$ declare v text; begin select string_agg(format('%I.%I', n.nspname, c.relname), ', ') into v from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','private','cohort_data'); execute 'truncate ' || v || ', storage.objects, storage.buckets cascade'; end \$\$;" | docker exec -i supabase_db_germinatura psql -U postgres -v ON_ERROR_STOP=1
   ```
4. Carregue os dados em modo replica (sem disparar triggers), numa única transação:
   ```bash
   cat <(echo "set session_replication_role = replica;") backup-AAAAMMDD/data.sql | docker exec -i supabase_db_germinatura psql -U postgres --single-transaction -v ON_ERROR_STOP=1
   ```
5. Rode o snapshot (abaixo) no banco restaurado e compare com o `before.json` de produção:
   ```bash
   pnpm test:upgrade --compare=before.json,restaurado.json
   ```
   O resultado esperado é contagens e hashes iguais.

Os **arquivos** do Storage (imagens e fotos) não estão no dump do banco, que traz só os metadados. Estas migrations
não tocam no Storage. O backup dos arquivos é um item à parte da prontidão de release (`release-readiness.md`).

### Snapshot de preservação (antes e depois)

É uma consulta **somente leitura**: um único `SELECT` que devolve um JSON. Rode pelo SQL Editor ou por
`psql -At -f arquivo.sql -o saida.json` com a conexão do responsável.

1. Gere o SQL do "antes": `pnpm --silent test:upgrade --emit-sql --per-row > snapshot-before.sql`.
2. Rode em produção **antes** do deploy e salve o resultado como `before.json`.
3. Depois do deploy, gere o SQL do "depois" com as mesmas colunas:
   `pnpm --silent test:upgrade --emit-sql --per-row --columns=before.json > snapshot-after.sql`.
   Rode em produção e salve como `after.json`.
4. Compare: `pnpm test:upgrade --compare=before.json,after.json --live`.
   - `--live` aceita linhas novas criadas pelo tráfego entre os snapshots, mas recusa qualquer linha anterior ausente
     ou alterada nas colunas preexistentes.
   - A comparação também recusa colunas novas fora das 73 tabelas por turma.
   - Os totais de domínio (vendas por status, pagamentos, ledger, estoque, caixa, financeiro, evidência e atribuição
     PicPay) aparecem lado a lado. Com `--live`, diferenças nos totais são informativas e precisam ser explicadas pelo
     tráfego da janela.

**Dados críticos a conferir no relatório:**
- `sales_by_status`, `payment_attempts_by_status`, `ledger_by_type`, `manual_entries_by_kind`;
- `inventory_balances`, `inventory_lot_balances`, `stock_movements_by_type`, `cash_movements_by_type`;
- `opening_positions`, `picpay_evidence`, `picpay_attribution`, `balance_checks`, `payables`;
- `reservations_by_status`, `raffle_numbers_by_status`.

### Deploy (somente após autorização)

1. PR de promoção para `main`, conforme o padrão da #171 (branch de `main` com merge cuja árvore é a de `develop`).
   Revisar o diff, aguardar a CI e fazer o squash merge.
2. `deploy-production.yml` com `confirm=PRODUCAO`. O workflow roda `supabase db push --dry-run` e depois
   `supabase db push`. Conferir que o dry-run lista **exatamente** as três migrations acima.
3. Smokes de produção e login por papel. Não é preciso registrar operação de teste.

### Checks pós-migration (produção, somente leitura)

```sql
select * from private.cohort_integrity_report() where violations <> 0;   -- esperado: nenhuma linha
select id, name, year, slug, status, is_default from public.cohorts;      -- esperado: só a Turma 2026
select (select count(*) from public.profiles) as perfis,
       (select count(*) from public.user_cohorts where cohort_id = 'c0000000-0000-4000-8000-000000002026' and status = 'ACTIVE') as vinculos;  -- iguais
```

Depois, o snapshot "depois" e a comparação acima.

### Rollback e forward-fix

- **Falha durante a migration:** cada arquivo roda numa transação. Uma falha (lock, integridade) desfaz o arquivo
  inteiro, e o `db push` para. Os arquivos anteriores já aplicados são aditivos e não mudam comportamento. Corrija e
  rode de novo (forward-fix).
- **Problema depois de aplicada:** a preferência é uma migration de correção (forward-fix). As colunas e tabelas novas
  não alteram o comportamento do app, então mantê-las é seguro enquanto se corrige.
- **Remoção da fundação** (último recurso, exige autorização porque é DDL destrutivo, ainda que só de metadados novos).
  Ordem:
  1. remover as FKs `<tabela>_cohort_id_fkey` e as colunas `cohort_id` das 73 tabelas;
  2. remover o trigger `profiles_join_default_cohort` e `private.join_default_cohort()`;
  3. remover `private.cohort_integrity_report()`, `private.cohort_scoped_tables`, `public.user_cohorts`,
     `public.cohorts`, `private.bootstrap_cohort_id()` e os tipos `cohort_status` e `cohort_membership_status`.

  Nenhum dado anterior se perde, porque nada anterior foi alterado.
- **Restauração do dump:** só em perda catastrófica, pelo roteiro de verificação acima aplicado a um projeto novo
  (migrations → esvaziar → `data.sql`). Ela descarta as escritas feitas depois do backup, então exige decisão
  explícita do responsável.

## Fase 2 — autorização e isolamento (PR 2)

### Migrations e impacto esperado

| Migration | O que faz | Bloqueio |
| --- | --- | --- |
| `20261020090000_cohort_classification` | `cohort_id` em `suppliers`, `finance_balance_checks`, `user_roles`, `audit_logs`, `outbox_events` (default constante, sem reescrita) e nas tabelas de atribuição PicPay/Payment Link (anulável, backfill a partir da venda/lançamento); `cohort_payment_terminals` (todas as maquininhas autorizadas para a Turma 2026); `feature_flags.scope` + `cohort_feature_flags` (valores atuais copiados para a Turma 2026) | Catálogo em quase tudo; `UPDATE` só nas linhas de atribuição e nas 4 flags globais |
| `20261020090100_cohort_authorization` | Contexto da requisição, `admin_masters` + bootstrap fail-closed, `has_permission`/`get_my_session` por turma, RPCs de turmas/vínculos/ADMIN_MASTER, fan-out por turma, wrapper do worker, guards | Só funções e tabelas novas |
| `20261020090200_cohort_isolation` | Aborta se houver publicação inesperada; move as 85 tabelas para `cohort_data` e cria as views `public.<tabela>`; RLS restritiva por escopo; guards; `NOT NULL`; unicidades/singletons por turma; maquininhas e flags globais em `private`; religa views dependentes; recria as 15 funções de tipo-linha; relatório de integridade (aborta se houver violação) | `ACCESS EXCLUSIVE` breve por tabela (`SET SCHEMA`, troca de constraints, validação de `NOT NULL`); `lock_timeout` 5 s |

**Comportamento visível depois do PR 2** (com o app atual, sem header de turma, tudo cai na Turma 2026):
- O Portal e o PDV continuam iguais para a Turma 2026, e `get_my_session` ganha campos (`admin_master`, `cohort`,
  `cohort_mode`, `cohorts`) que o app atual ignora.
- **Flags globais** (`payment_link`, `picpay_checkout`, `picpay_tap`, `meal_voucher`) passam a ser alteradas só por
  ADMIN_MASTER, que é o administrador do bootstrap.
- **Maquininhas:**
  - um terminal usado só pela turma continua editável por ela;
  - um terminal compartilhado é editado só por ADMIN_MASTER;
  - autorizar um terminal existente para outra turma também é exclusivo de ADMIN_MASTER.
- **"Desativar usuário"** passa a desativar o vínculo com a turma. Como hoje só existe a Turma 2026, o efeito é o
  mesmo: a sessão fica inativa.

### Checks antes da produção (somente leitura)

```sql
-- 1. Nenhuma tabela publicada (a migration aborta se houver).
select pubname, schemaname, tablename from pg_publication_tables;
select pubname from pg_publication where puballtables;
-- 2. Bootstrap institucional consistente (a migration aborta sem fallback se não estiver).
select b.completed_at is not null as concluido, p.id is not null as tem_perfil, p.active, p.onboarding_completed_at is not null as onboarding
from public.institutional_bootstrap_state b left join public.profiles p on p.id = b.completed_by;
-- 3. Só a Turma 2026 existe e a fundação está íntegra.
select id, name, status, is_default from public.cohorts;
select * from private.cohort_integrity_report() where violations <> 0;
```

Esperado: (1) nenhuma linha; (2) `concluido`, `tem_perfil`, `active` e `onboarding` verdadeiros; (3) uma turma e
nenhuma violação. Mais o snapshot `before.json` e o backup (Fase 1).

### Checks depois da produção (somente leitura)

```sql
select * from private.cohort_integrity_report() where violations <> 0;      -- nenhuma linha
select * from private.cohort_view_drift();                                  -- nenhuma linha
select user_id from public.admin_masters;                                   -- o administrador do bootstrap
select count(*) from private.cohort_scoped_tables;                          -- 85
select key, scope, enabled from public.feature_flags order by key;          -- mesmos valores de antes
```

Depois, o snapshot "depois" e a comparação `--live`. Colunas novas esperadas: `cohort_id` e `feature_flags.scope`.
Tabelas movidas para `cohort_data`/`private` são comparadas pelo nome.

### Rollback e forward-fix

- Cada arquivo roda numa transação. Uma publicação inesperada, um bootstrap inconsistente, uma violação de
  integridade ou um lock acima de 5 s desfazem o arquivo inteiro.
- Problema depois de aplicado: forward-fix. O app atual não depende do header, então a correção pode ser feita sem
  pressa.
- **Reverter a conversão** (último recurso, com autorização, DDL sem perda de dados):
  1. remover as views `public.<tabela>`;
  2. `ALTER TABLE cohort_data.<tabela> SET SCHEMA public` para as 85 tabelas;
  3. devolver `feature_flags` e `payment_terminals` a `public`;
  4. recriar as views dependentes e as 15 funções de tipo-linha sobre as tabelas.

  `cohort_id` e as tabelas novas podem ficar, porque não mudam o comportamento.

## Fase 3 — contexto no Portal e no PDV (PR 3)

### Migration e impacto esperado

`20261021090000_cohort_context_api` (aditiva, `lock_timeout` de 5 s, uma transação):

- `alter table public.pdv_handoff_codes add column cohort_id uuid references public.cohorts` (anulável, sem default:
  só catálogo). Os códigos emitidos antes ficam `NULL`; eles expiram em 60 s, e o PDV pede a turma.
- Novas funções:
  - `list_cohort_users`;
  - `private.cohort_member_visible`;
  - `complete_admin_provisioned_profile` com turma (6 argumentos). A versão de 5 argumentos continua existindo.
- Recriadas: `create_pdv_handoff`, que grava a turma, e `consume_pdv_handoff`, que a devolve.
- `set_user_access`, `unlock_password_recovery`, `unlock_signup_code_requests` e `set_cohort_membership`:
  - as originais são renomeadas para `private.<nome>_in_cohort`, sem mudança de corpo;
  - os nomes públicos viram envoltórios que recusam pessoa fora da turma da requisição;
  - as assinaturas não mudam, então o app anterior continua funcionando durante a promoção.
- Nenhuma linha existente é alterada (provado por `pnpm test:upgrade`, que compara contagens, hashes, tuplas e
  agregados).

### Ordem do deploy

1. Migration.
2. Portal.
3. PDV.

O Portal novo funciona com o PDV antigo, que ainda não manda header e por isso recebia o fallback da Turma 2026 (desligado no PR 5). O PDV
novo exige o Portal novo, por causa de `consume_pdv_handoff` com turma e do header nas chamadas. O deploy governado
publica os dois juntos.

### Checks depois da produção (somente leitura)

- Depois de alguns minutos, os novos códigos de handoff têm turma:
  `select count(*) from public.pdv_handoff_codes where cohort_id is null and created_at > now() - interval '5 minutes'`
  tende a 0.
- Os quatro envoltórios existem: `select count(*) from pg_proc where pronamespace = 'private'::regnamespace and
  proname in ('set_user_access_in_cohort', 'unlock_password_recovery_in_cohort', 'unlock_signup_code_requests_in_cohort',
  'set_cohort_membership_in_cohort')` → 4.
- Smokes: abrir o PDV pelo Portal; listar usuários; trocar de turma no seletor; uma escrita em "Todas" deve dar 409.

### Rollback e forward-fix

- A migration roda numa transação: qualquer erro desfaz o arquivo inteiro.
- Depois de aplicada, o caminho é forward-fix. Reverter, só com autorização:
  1. remover os envoltórios públicos;
  2. devolver `private.<nome>_in_cohort` a `public` com o nome original;
  3. recriar `create_pdv_handoff`/`consume_pdv_handoff` da migration `20261020090200`.

  A coluna `cohort_id` e as funções novas podem ficar. Nenhuma reversão apaga dados.
- **Não criar uma segunda turma em produção** antes da autorização explícita da comissão, mesmo com o PR 3 aplicado.

## Fase 4 — visão consolidada e vínculos (PR 4)

### Migration e impacto esperado

`20261022090000_cohort_consolidated`: só funções, `lock_timeout` de 5 s, uma transação.

- **Pré-checagens:** a migration aborta antes de criar qualquer coisa se:
  - não houver exatamente uma turma padrão, ou ela estiver arquivada;
  - faltar alguma função dos PRs 2 e 3;
  - houver vínculo sem perfil.
- **Funções novas:**
  - `private.membership_blockers` e `private.cohort_open_operations`;
  - `public.user_cohort_memberships`, `public.cohort_overview`, `public.picpay_evidence_overview`, `public.audit_log_cohorts`.
- **Substituídas, mesma assinatura:**
  - `public.set_cohort_membership` passa a recusar a inativação com operações em aberto;
  - `public.update_cohort` passa a recusar o arquivamento com operações em aberto.
- **Dados:** nenhuma linha, tabela ou coluna muda. `pnpm test:upgrade` compara contagens, hashes, tuplas e agregados.

### Ordem do deploy

1. Migration.
2. Portal e PDV juntos (deploy governado).

O Portal anterior continua funcionando com a migration nova: as assinaturas não mudaram. O Portal novo depende das
funções novas.

### Checks depois da produção (somente leitura)

- `select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('user_cohort_memberships',
  'cohort_overview', 'picpay_evidence_overview', 'audit_log_cohorts')` → 4.
- `select count(*) from public.cohorts where is_default` → 1.
- Smokes:
  - em "Todas", a visão geral comparada abre;
  - uma tela só por turma vai para `/selecionar-turma`;
  - `GET /api/v1/admin/finance/payables` em "Todas" → 409.

### Rollback e forward-fix

- A migration roda numa transação: qualquer erro desfaz tudo.
- Depois de aplicada, o caminho é forward-fix. Reverter, só com autorização:
  - recriar `set_cohort_membership` (envoltório do PR 3) e `update_cohort` (PR 2) pelas definições das migrations
    `20261021090000` e `20261020090100`;
  - remover as funções novas.

  Nenhum dado é apagado.
- **Não criar a Turma 2027 em produção** antes da autorização explícita da comissão.

## Fase 5 — contexto explícito e turma padrão (PR 5)

### Migration e impacto esperado

`20261023090000_cohort_explicit_context`: uma transação, `lock_timeout` de 5 s.

- **Pré-checagens fail-closed:**
  - exatamente uma turma padrão, ATIVA;
  - nenhuma linha de tabela por turma sem turma;
  - nenhuma coluna `cohort_id` com default (o PR 2 já removeu);
  - relatório de integridade limpo.
- **Funções:**
  - o fallback é desligado;
  - o escopo de visitante passa a aceitar só turma ATIVA resolvida no servidor;
  - o guard de escrita deixa de usar a turma padrão;
  - a auditoria e o outbox ficam fail-closed;
  - cadastro explícito (`join_default_cohort`, `handle_new_auth_user`);
  - novas: `set_default_cohort`, `resolve_public_cohort`, `storage_entity_in_scope`, `close_seller_shift_on_behalf`;
  - `record_share_visit` e `set_user_access` são substituídas (mesma assinatura).
- **Trigger** `cohorts_default_active`: a turma padrão é sempre ATIVA.
- **Storage:** `ALTER POLICY` em 4 políticas (imagens de produto, capas de evento, fotos de perda). Nenhum arquivo muda.
- **Links de vendedor:** `list_my_share_links` (mesma assinatura): `mine` sempre booleano. O rollback dessa função volta ao corpo de `20261010210000_sale_attribution`.
- **Dados:** nenhuma linha muda (`pnpm test:upgrade`).

### O que muda para as pessoas

- **ADMIN_MASTER e quem tem várias turmas:** escolhem a turma ao entrar (`/selecionar-turma`); antes, recebiam a Turma 2026 sem escolher.
- **Quem tem uma turma só:** nada muda.
- **PDV:** nada muda; ele já exigia turma explícita.

### Ordem do deploy

1. Migration.
2. Portal e PDV juntos (deploy governado).

O Portal anterior com a migration nova:
- quem tem uma turma continua igual;
- master e multi-turma sem seleção passam a ver "sem turma" até escolher no seletor, que já existe.

### Checks depois da produção (somente leitura)

- `select private.cohort_fallback_enabled()` → `false`.
- `select count(*) from public.cohorts where is_default and status = 'ACTIVE'` → 1.
- `select count(*) from pg_proc where proname in ('set_default_cohort', 'resolve_public_cohort', 'storage_entity_in_scope', 'close_seller_shift_on_behalf')` → 4.
- **Smokes:**
  - `/api/v1/catalog/products` anônimo → 200;
  - `?turma=nao-existe` → 404;
  - um link `/d/` da Turma 2026 abre o catálogo;
  - master sem seleção → `/selecionar-turma`.

### Rollback e forward-fix

- A transação desfaz tudo em qualquer erro.
- Depois de aplicada, o caminho é forward-fix. Reverter, só com autorização e sem perda de dados:
  - recriar as funções pelas definições das migrations `20261020090100`, `20261021090000` e `20261022090000`;
  - `cohort_fallback_enabled` voltando a `true`;
  - remover o trigger `cohorts_default_active` e as funções novas;
  - restaurar as 4 políticas de Storage pela migration que as criou.
- **Não trocar a turma padrão em produção nem criar a Turma 2027** sem autorização explícita da comissão.
