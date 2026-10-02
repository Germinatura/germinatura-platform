# Operação dentro do Supabase Free — auditoria e plano

**Restrição do Marco 1:** o Supabase fica no plano Free em staging e em produção. É uma decisão arquitetural e econômica: nenhum upgrade, compute pago ou projeto adicional pago faz parte do plano. O Cloudflare Workers Paid já está contratado e continua. O SMTP está funcionando, e a flag `payment_link` segue desligada.

O objetivo é a aplicação operar de forma estável dentro dos recursos do Free, sem enfraquecer nenhuma garantia transacional nem os critérios de aceite de `stability-report.md`.

## Como a auditoria foi feita

- **Código:** proxy, resolução de sessão, rotas, RPCs, RLS e o Worker de jobs, em `develop` `e29cc33`.
- **Banco local:** `pg_stat_statements` com `track = all`, que conta também as instruções internas de cada função. Cada RPC quente foi chamada isoladamente e contada.
- **Volume sintético:** 200 mil eventos publicados na outbox, porque os eventos `PUBLISHED` nunca são removidos e staging acumula as rodadas de carga.
- **Dados de staging informados pelo responsável:** Query Performance e Performance Advisor do Supabase. São estatísticas acumuladas, usadas como indicação de hot path.

## Mapa de custo de uma requisição

Caminho: Worker → proxy → sessão → rota → sessão → RPC → RLS → ledger, auditoria e outbox.

| Fluxo | Proxy | Rota | RPCs de negócio | Trabalho interno (local, por chamada) |
| --- | --- | --- | --- | --- |
| Leitura autenticada (notificações, eventos, minhas vendas) | JWT local + `get_my_session` | JWT local + `get_my_session` | 1 consulta; eventos e vitrine fazem também 1 a 2 leituras de `feature_flags` | Leitura sob RLS. Várias policies chamam `has_permission(...)` e `auth.uid()` sem `(select …)`, então o cálculo se repete por linha |
| Checkout (PDV) | idem | idem; `requirePermission` | `checkout_sale` | 89 execuções internas, ~26 ms. Inclui 2 `has_permission`, `price_cart` (1 `pricing_candidates` por item), idempotência (insert + update), venda, itens, reserva de estoque (movimento, itens, saldo), tentativa de pagamento, transição de estado, auditoria e outbox |
| Criar reserva (Portal) | idem | idem | `default_reservation_location` + `create_commercial_reservation` (+ `attribute_reservation` com link de divulgação) | 54 execuções, ~12 ms: `price_cart`, idempotência, movimento e saldo, 2 auditorias e 2 eventos de outbox |
| Cancelar reserva | idem | idem | `cancel_commercial_reservation` | 28 execuções, ~7 ms |
| Confirmação Área Pix | idem | idem; `requirePermission` | `confirm_manual_payment` | 70 execuções, ~14 ms: consumo do estoque e dos lotes, ledger financeiro, auditoria e outbox |
| Vitrine | idem (página: proxy + página = 2 sessões; API: mais 2) | idem | `get_portal_showcase` + 1 leitura de `feature_flags` | ~5 ms |
| Outbox (Worker de jobs, a cada minuto) | — | — | expiração de reservas + 1 a 5 lotes + métricas | Ver abaixo |

No banco local, nenhuma RPC transacional tem N+1 nem chama pricing duas vezes: o checkout calcula o carrinho uma vez e grava o resultado. Em staging, as mesmas RPCs aparecem com média de 1,1 a 2 s. A diferença está na disputa pela mesma linha de estoque (o soak reserva sempre o mesmo produto central) e nos limites de CPU e E/S do Free, não em lógica cara.

## Achados

1. **Sessão resolvida duas vezes por requisição.** O proxy e a rota chamam `get_my_session`, o que dá 2 consultas por API autenticada e 4 para abrir o Início (página + API). `get_my_session` responde por ~12% do tempo acumulado do banco.
2. **Varreduras completas da outbox a cada minuto, mesmo sem uso.**
   - O claim filtra `PENDING … OR PROCESSING …`, e o índice parcial cobre só `PENDING`. Com 200 mil eventos publicados, cada claim é um seq scan de ~3.900 páginas.
   - `worker_outbox_metrics` faz mais duas varreduras completas (`PROCESSING` e `FAILED`).
   - São no mínimo três varreduras por minuto, que crescem com a tabela, porque os eventos publicados nunca saem.
3. **RLS recalculada por linha.** Das 93 policies, 57 usam `has_permission(...)` e várias usam `auth.uid()`. Muitas não estão envolvidas em `(select …)`, então o cálculo se repete a cada linha lida, em vez de uma vez por instrução.
4. **Policies permissivas múltiplas.** 26 tabelas têm mais de uma policy de `SELECT` (leitura do dono e leitura do gestor, por exemplo). O Postgres avalia todas para cada linha.
5. **Leitura de `feature_flags` por requisição** na vitrine e em eventos: uma ida a mais ao banco por chamada.
6. **Disputa pela mesma linha de estoque** nas reservas do soak: as transações de reserva e cancelamento do mesmo produto e local se enfileiram no lock do saldo. É o comportamento correto, e não muda.

## Plano

| PR | Escopo | Ganho esperado |
| --- | --- | --- |
| 1 — sessão | Uma única consulta `get_my_session` por requisição. O proxy mantém toda a autorização atual e entrega o resultado à rota dentro da mesma requisição, assinado com uma chave do isolate e amarrado ao token. A rota continua validando o JWT localmente e só volta ao banco se o contexto faltar, for falsificado, vier de outro token ou estiver expirado. | API autenticada: 2 → 1 consulta; Início: 4 → 2 |
| 2 — RLS e índices | `(select auth.uid())` e `(select public.has_permission(...))` nas policies, onde o resultado é idêntico. Índices de chaves estrangeiras usados por consultas reais. Policies permissivas unidas só com equivalência provada. | Menos CPU por linha lida sob RLS |
| 3 — transações e outbox | Claim da outbox por índice (mesma ordem, mesmos candidatos) e métricas por índices parciais. EXPLAIN das consultas internas das 4 RPCs com volume sintético, corrigindo o que aparecer. Locks, idempotência e ledgers intactos. | Fim das varreduras completas por minuto |
| 4 — leituras e jobs (se necessário) | Leitura de flags junto da consulta principal, frequência das RPCs do Worker de jobs. | Menos idas ao banco por leitura |

Depois das PRs relevantes integradas: uma rodada D de 10 min. Se ela ficar estável, D de 30 min. Se houver de novo uma parada global, a rodada para, e o relatório traz a capacidade medida, sem propor plano pago.
