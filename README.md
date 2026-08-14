# Germinatura v2 — Foundation

Este repositório contém dois produtos web no mesmo monorepo:

- `apps/portal`: Portal público, consumidor e administração.
- `apps/pdv`: PDV mobile-first, executado separadamente.

Regras e contratos compartilhados ficam em `packages/`. O banco Prisma atual permanece temporariamente em `packages/legacy-db`; novas identidades, papéis, permissões, RLS e Storage são versionados em `supabase/`.

## Requisitos locais

- Node.js 20 ou superior.
- pnpm 11.19.0.
- Docker Desktop em execução.

## Preparação

```powershell
Copy-Item apps/portal/.env.example apps/portal/.env.local
Copy-Item apps/pdv/.env.example apps/pdv/.env.local
pnpm install --frozen-lockfile
pnpm legacy-db:start
pnpm legacy-db:push
pnpm supabase:start
pnpm supabase:reset
pnpm dev
```

Após `supabase:start`, substitua as chaves ilustrativas nos dois arquivos locais pelos valores exibidos por `node tools/run-supabase.mjs status -o env`. O PDV recebe somente variáveis públicas; service role, banco legado e pagamentos ficam exclusivamente no Portal. Nunca faça commit desses arquivos.

- Portal: `http://127.0.0.1:3000`
- PDV: `http://127.0.0.1:3001`
- Supabase Studio: `http://127.0.0.1:54323`

Identidades locais são criadas por `supabase/seed.sql`, todas no domínio reservado `.test`:

| Perfil | Email | Senha |
| --- | --- | --- |
| Administrador | `admin@germinatura.test` | `Admin123!` |
| Vendedor | `vendedor@germinatura.test` | `Vendedor123!` |
| Consumidor | `consumer@germinatura.test` | `Consumer123!` |

O PostgreSQL da raiz (`docker compose`) existe apenas para manter as telas Prisma legadas funcionando durante a transição. Ele não substitui o banco local do Supabase. Para executar somente os testes de fundação, use `pnpm supabase:start:test`, que inicia apenas os serviços necessários a Auth, PostgREST, migrations e RLS.

## Qualidade

```powershell
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm supabase:reset
pnpm test:db
pnpm build
pnpm test:e2e
```

O código novo usa lint estrito. Portal e PDV carregam temporariamente avisos herdados do monólito, sem permitir erros de lint. A dívida é isolada para remoção posterior.

## Limites desta branch

Esta fundação não migra o domínio operacional para o novo modelo. Estoque ledger, dinheiro em centavos, migração histórica, motor de promoções e idempotência completa serão implementados em `feat/v2-core-domain`. Pagamentos e conciliação ficam em `feat/v2-payments-finance`.

O webhook AbacatePay permanece desabilitado por padrão e rejeita chamadas quando `PAYMENTS_ENABLED` e o segredo não estão configurados.
