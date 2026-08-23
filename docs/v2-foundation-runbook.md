# Runbook local da fundação v2.1

Este runbook cobre apenas Portal, PDV, Supabase Auth, RBAC, RLS, Storage e health checks locais.

## Início limpo

1. Confirme Docker Desktop em execução.
2. Rode `pnpm install --frozen-lockfile`.
3. Rode `pnpm supabase:start`.
4. Consulte `node tools/run-supabase.mjs status -o env`.
5. Crie os arquivos `.env.local` a partir dos exemplos e preencha somente URL/chave pública locais.
6. Rode `pnpm supabase:reset` para aplicar migrations e fixtures locais.
7. Rode `pnpm dev`.

Não há Compose próprio, Prisma, PostgreSQL paralelo ou processo de geração de cliente de banco.

## Verificação

- `GET http://127.0.0.1:3000/api/v1/health` retorna apenas serviço e estado do Portal;
- `GET http://127.0.0.1:3001/api/v1/health` retorna apenas serviço e estado do PDV;
- ADMIN entra no Portal e no PDV;
- VENDEDOR entra no PDV;
- CONSUMIDOR entra no Portal e é bloqueado no PDV;
- usuários sem sessão são redirecionados ao login;
- logout invalida a sessão local.

## Reset e parada

- `pnpm supabase:reset`: recria a base local a partir das migrations e do seed;
- `pnpm supabase:stop`: encerra os serviços do Supabase CLI.

O reset destrói somente os dados do Supabase local. Nenhum projeto remoto é vinculado ou acessado.

## Escopo funcional

As áreas operacionais antigas não possuem rotas ativas. A interface informa o estado de implementação em vez de simular catálogo, estoque, venda ou pagamento. Consulte o [roadmap](v2.1-implementation-roadmap.md) e o [ADR greenfield](adr/0001-greenfield-v2.md).
