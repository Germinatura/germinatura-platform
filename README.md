# Germinatura v2.2 — Greenfield

A Germinatura v2.2 é uma plataforma nova, composta por duas aplicações Next.js independentes no mesmo monorepo:

- `apps/portal`: Portal autenticado para consumidores e equipes internas;
- `apps/pdv`: shell mobile-first do ponto de venda, executado separadamente;
- `packages/`: contratos, autenticação, configuração, domínio, observabilidade, pagamentos genéricos e UI compartilháveis;
- `supabase/`: configuração local, migrations, seed de fixtures e testes SQL/RLS.

O Supabase é a única persistência planejada. Supabase Auth é a única infraestrutura de identidade, ligada a `profiles`, `user_roles`, `roles`, `permissions` e `role_permissions`. Todas as tabelas públicas da fundação usam RLS.

> A Germinatura v2.2 inicia com uma base nova. Nenhum dado operacional do sistema legado será migrado.

Não existe Prisma, banco PostgreSQL legado, dual-write, backfill, cutover de dados, Neon ou integração financeira ativa. A decisão está formalizada no [ADR 0001](docs/adr/0001-greenfield-v2.md).

## Estado funcional

O repositório contém a fundação autenticada, os health checks do Portal e do PDV, uma primitive compartilhada de dinheiro em centavos, a fundação persistente de idempotência e contratos neutros de pagamento que falham de forma fechada. A fundação de catálogo persiste categorias, produtos e histórico de preços em centavos com RLS, mas ainda não possui API nem tela. Nenhuma mutação de negócio consome idempotência ainda. Estoque, promoções, vendas, integrações de pagamento, reservas, rifas, financeiro, comunidade e notificações ainda não estão implementados. As telas antigas desses domínios foram retiradas da navegação e suas APIs foram removidas para não aparentarem funcionalidade sem um modelo transacional v2.

Papéis disponíveis, com suporte a múltiplos papéis por usuário:

- `CONSUMIDOR`;
- `VENDEDOR`;
- `ESTOQUE`;
- `FINANCEIRO`;
- `COMUNICACAO` (exibido como Comunicação);
- `MODERADOR`;
- `ADMIN`.

Permissões são verificadas no servidor e no banco; esconder itens de interface não concede nem remove autorização.

## Requisitos locais

- Node.js 20 ou superior;
- pnpm 11.19.0;
- Docker Desktop;
- portas locais usadas pelo Supabase CLI disponíveis.

## Preparação local

```powershell
pnpm install --frozen-lockfile
pnpm supabase:start
node tools/run-supabase.mjs status -o env
Copy-Item apps/portal/.env.example apps/portal/.env.local
Copy-Item apps/pdv/.env.example apps/pdv/.env.local
pnpm supabase:reset
pnpm dev
```

Copie `API_URL` para `NEXT_PUBLIC_SUPABASE_URL` e `PUBLISHABLE_KEY` para `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Nenhuma chave secreta ou service role é necessária nas aplicações desta fundação.

Nunca faça commit de `.env.local`, `.dev.vars`, tokens, dumps ou backups.

- Portal: `http://127.0.0.1:3000`;
- PDV: `http://127.0.0.1:3001`;
- Supabase Studio: `http://127.0.0.1:54323`.

Fixtures locais do `supabase/seed.sql`:

| Papel | Email | Senha |
| --- | --- | --- |
| Administrador | `admin@germinatura.test` | `Admin123!` |
| Vendedor | `vendedor@germinatura.test` | `Vendedor123!` |
| Consumidor | `consumidor@germinatura.test` | `Consumidor123!` |

Essas contas existem apenas após o reset local e não são dados de produção.

## Qualidade

A bateria oficial é:

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm supabase:start:test
pnpm supabase:reset
pnpm test:db
pnpm test:e2e --project=chromium
pnpm build
```

O workflow de CI executa essa fundação contra Supabase local. Ele não acessa Supabase remoto, não faz deploy e rejeita arquivos de ambiente, dumps, backups e padrões de credenciais proibidos.

## Documentação vigente

- [ADR 0001 — Germinatura v2.1 greenfield](docs/adr/0001-greenfield-v2.md);
- [PRD v2.2](docs/product/PRD.md);
- [Roadmap oficial v2.2](docs/product/ROADMAP.md);
- [Diagnóstico v2.2](docs/product/GAP_ANALYSIS.md);
- [Runbook da fundação local](docs/v2-foundation-runbook.md);
- [Baseline de segurança e classificação de endpoints](docs/security-baseline.md);
- `docs/specs/Germinatura_Especificacao_Funcional_Tecnica_v2.2.docx`: fonte funcional e técnica vigente, exceto por qualquer trecho de migração superado pelo ADR 0001.

Documentos v1, v2 e v2.1 permanecem como histórico e não representam decisões vigentes de pagamentos.

## Próximas entregas

O plano vigente e seus bloqueios estão em `docs/product/ROADMAP.md`. Staging continua condicionado ao provisionamento externo já documentado; integrações PicPay reais permanecem desligadas até documentação, credenciais e habilitação oficiais.
