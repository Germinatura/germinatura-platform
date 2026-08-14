# Runbook da fundação v2

## Fluxo local

1. Inicie o Docker Desktop.
2. Rode `pnpm install --frozen-lockfile`.
3. Rode `pnpm legacy-db:start` e `pnpm legacy-db:push` para manter disponíveis as telas que ainda usam Prisma.
4. Rode `pnpm supabase:start` e consulte `node tools/run-supabase.mjs status -o env`.
5. Crie `apps/portal/.env.local` e `apps/pdv/.env.local` a partir dos respectivos exemplos; não copie chaves server-side para o PDV.
6. Rode `pnpm supabase:reset` para aplicar migrations, RLS, Storage e fixtures.
7. Suba Portal e PDV com `pnpm dev`.

Para a suíte automatizada, `pnpm supabase:start:test` inicia o perfil mínimo usado pela CI, sem Studio, Storage API e serviços auxiliares. O schema e as policies de Storage continuam sendo validados na migration.

## Compatibilidade temporária

O Portal continua usando o schema Prisma legado para catálogo, reservas, rifas, vendas e financeiro. `profiles.legacy_user_id` faz a ponte entre `auth.users` e `Usuario`. Usuários sem vínculo podem autenticar, mas operações que gravam entidades legadas retornam conflito 409.

## Migração futura de dados

A próxima branch receberá um dump criptografado ou acesso somente leitura e fará importação auditável de usuários, vendas, transações financeiras e pedidos de rifa pagos. Catálogo, reservas pendentes e estoque operacional não serão importados; os itens históricos manterão snapshots de nome e preço.

## Segurança

- Supabase Auth substitui o JWT próprio.
- APIs são protegidas no middleware e novamente nas rotas sensíveis.
- Mutações por cookie exigem `Origin` permitido; integrações usam autenticação própria.
- O código executado pelas APIs não usa `$queryRawUnsafe` ou `$executeRawUnsafe`.
- Chaves de serviço permanecem exclusivamente no servidor.
