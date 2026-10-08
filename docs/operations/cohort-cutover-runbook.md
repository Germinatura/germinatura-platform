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

## Fases seguintes

O PR 2 (autorização e isolamento: `NOT NULL`, contexto, ADMIN_MASTER) acrescenta a sua seção a este runbook, depois do
spike de isolamento e Realtime.
