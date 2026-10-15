# Spike — isolamento por turma (candidato do PR 2, ADR 0011)

Prova automatizada, **somente local e descartável**, da arquitetura candidata ao isolamento por turma:

- tabela base no schema não exposto `cohort_data`;
- uma view `public.<nome>` com o mesmo nome da tabela original, `security_invoker`, `security_barrier` e
  `with cascaded check option`, filtrada pelo escopo da requisição;
- uma policy restritiva de turma na tabela base;
- um trigger `a_cohort_guard`, que preenche e valida `cohort_id`, recusa escrita em "Todas" e em turma arquivada e
  impede trocar a turma de uma linha.

Nada aqui é migration. `spike.sql` foi o protótipo do PR 2, que virou as migrations `20261020090000`–`20261020090200`; o spike roda
sobre o schema anterior a elas (`develop` c0b6e34) e fica como evidência histórica.

```bash
node tools/spikes/cohort-isolation/run.mjs --out=<diretório> [--skip-suite]
```

O stack local precisa do Realtime para a verificação ponta a ponta. O `pnpm supabase:start:test` o exclui, então use:

```bash
node tools/run-supabase.mjs start -x imgproxy,studio,edge-runtime,logflare,vector,supavisor,postgres-meta
```

## O que é provado

| Item pedido | Onde |
| --- | --- |
| Tabela mestre simples, pai + filha com FK, ledger imutável, tabela com trigger | Recorte: `categories`, `products`, `product_prices`, `product_images`, `product_stock_alerts`, `finance_manual_entries` (auto-FK de estorno), `portal_highlights` (identity) |
| INSERT, UPDATE, DELETE, RETURNING, ON CONFLICT, FOR UPDATE | `spike_test.sql`, pelos RPCs existentes e por uma função definer equivalente |
| FK entrando e saindo; FK entre turmas | O guard recusa pai de outra turma (`COHORT_MISMATCH`); a filha sem turma herda a do pai; as FKs vindas de outras tabelas continuam na tabela base |
| RPC `SECURITY DEFINER` | Os RPCs atuais, sem nenhuma alteração, só enxergam e gravam a turma da requisição |
| Data API | HTTP real ao PostgREST: anon, admin de cada turma, header de turma, embedding por FK através das views, schema base não exposto (406), escrita direta negada |
| Grants, policies antigas | As views recebem exatamente os grants da base, depois de revogar os default privileges do `public`; as policies antigas seguem com a tabela |
| Sequences/defaults | Identity de `portal_highlights` e defaults das bases funcionam através da view |
| Funções com `public.<tabela>` | Todas resolvem para a view em tempo de execução: a suíte pgTAP existente roda sobre o banco convertido |
| Dependência de OID/regclass | Views dependentes são religadas da base para a view; funções com assinatura no tipo-linha da tabela são recriadas sobre o tipo da view |
| Migrations posteriores com ALTER TABLE | `ALTER` na view falha. A convenção é `ALTER` em `cohort_data.<t>` + `private.refresh_cohort_view('<t>')`, e `private.cohort_view_drift()` acusa divergência |
| Realtime | A view não pode ser publicada; a base pode. Com a policy restritiva por vínculo, cada assinante recebe só os eventos das turmas em que participa |
| Backup/restore, pg_dump/schema diff | Diff de schema por `supabase db dump`; backup por `db dump --data-only`; restauração pelo procedimento do runbook (migrations → esvaziar → `data.sql`), comparação de snapshot e teste de isolamento no banco restaurado |
| Upgrade | Conversão sobre banco populado: todas as linhas, valores e **tuplas** preservados (`SET SCHEMA` não reescreve dados) |

## Achados que o PR 2 precisa tratar

1. **11 funções** usam o tipo-linha de uma tabela por turma na assinatura e ficariam presas à tabela base:
   `claimed_payment_link_charge`, `current_finance_opening_position`, `finance_manual_entry_effects`,
   `payment_link_charge_json`, `portal_event_over`, `portal_highlight_json`, `raffle_campaign_json`,
   `raffle_refund_block`, `share_campaign_json`, `transition_payment_attempt`, `transition_sale_state`.
   A migration as recria explicitamente sobre o tipo da view.
2. **Views dependentes** (públicas e `private.picpay_*`) são religadas às views filtradas.
3. **Views novas herdam os default privileges do schema `public`** (ALL para anon/authenticated). É preciso revogar
   antes de replicar os grants da base.
4. **Testes estruturais** que procuram `public.<tabela>` como tabela (`has_table`, índices, RLS) passam a apontar para
   `cohort_data`. O relatório de integridade do PR 1 também passa a olhar `cohort_data`.
5. **Ferramentas que enumeram tabelas base de `public`** passam a incluir `cohort_data`. Exemplo: o `devseed.remap()`
   do dataset rico.
6. **Backup:** o `supabase db dump` exclui os schemas `auth` e `storage`, então o `schema.sql` não traz as policies de
   Storage nem o trigger de cadastro. Restauração = migrations + `data.sql` (runbook corrigido).
7. **Realtime:** hoje não há tabela publicada nem assinatura no código. Uma publicação futura usa a **tabela base**,
   e o assinante precisa entregar o JWT antes do join (`realtime.setAuth`); sem isso a assinatura vira `anon` e vê só
   a turma padrão, o que é fail-closed. O PR 2 inclui um guard que aborta a migration se alguma tabela convertida
   estiver publicada (produção pode ter publicações feitas pelo painel).
8. **Autorização** continua um passo separado: no spike, os papéis ainda são globais. O isolamento de dados independe
   do RBAC, e o PR 2 torna `has_permission` dependente da turma.
