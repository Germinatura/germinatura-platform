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

## Resultado (2026-10-02, `develop` `61dd7f1`, PRs 1 a 3 integradas)

**D de 10 min** ([run 37072188193](https://github.com/Germinatura/germinatura-platform/actions/runs/37072188193)) — estável:

- 10.593 requisições, nenhuma falha (nenhum 5xx, timeout ou erro de rede), ~17 req/s.
- p95 por minuto das leituras ficou entre 144 e 208 ms. Em 8 das 9 rotas o p95 caiu ao longo da rodada; na vitrine ficou estável (+0,4 ms/min).
- Outbox drenando: no máximo 279 pendentes, o mais antigo com 78 s, nenhum em processamento.
- Nenhuma espera de lock; nenhum Worker excedeu CPU ou memória.
- `get_my_session` agora vai ao banco 1 vez por requisição autenticada: a rota reaproveitou o contexto do proxy em 3.023 de 3.044 requisições.

**D de 30 min** ([run 37073377077](https://github.com/Germinatura/germinatura-platform/actions/runs/37073377077), início 22:37 UTC) — não estabilizou:

- **Minutos 0 a 16 (22:37–22:53 UTC):** ~16 req/s; p95 das leituras entre 220 e 480 ms; um pico breve nos min 3 e 13.
- **Minutos 18 a 28 (22:55–23:06 UTC):** parada geral e intermitente do banco.
  - Todas as rotas foram afetadas, inclusive as leituras simples, com p95 de até 30 s (o timeout do harness) e vazão média de 9,4 req/s.
  - `get_my_session` chegou a 49 s no proxy (p99 10 s).
  - A própria amostragem pela API de gestão do Supabase falhou nos min 19, 23 e 28.
  - Mesmo durante a parada, no máximo 3 esperas de lock e no máximo 13 conexões ativas.
- **Minuto 29:** recuperação completa, com p95 voltando aos valores iniciais.
- **No total:** 24.307 requisições.
  - 0,6% falharam: 44 respostas 503 de indisponibilidade das rotas, 60 timeouts e 2 respostas 401, ambas quando a sessão não pôde ser resolvida no prazo.
  - Os Workers não excederam CPU nem memória.
- **Invariantes finais: 0 violações nas 8 verificações:**
  - estoque negativo ou reservado além do saldo;
  - unidade disputada consumida duas vezes;
  - número de rifa com dois donos;
  - venda com mais de um pagamento confirmado;
  - pagamento lançado duas vezes no ledger;
  - chave de idempotência com dois resultados;
  - cupom usado além do limite global;
  - evento da outbox preso em processamento.

**Leitura:**

- A degradação atinge o banco inteiro ao mesmo tempo, sem fila de locks nem excesso de conexões. Com PRs 1 a 3, o custo por requisição caiu:
  - a primeira parada passou do minuto 8 da rodada anterior para o minuto 18;
  - a rodada de 10 min passou inteira.
- O padrão (estável por um período de carga sustentada, parada generalizada e recuperação sem intervenção) é compatível com o esgotamento de um limite de recurso da instância Free (CPU ou E/S com crédito de burst), e não com uma consulta específica. A confirmação depende das métricas do projeto de staging na janela 22:55–23:06 UTC.

**Capacidade medida no Supabase Free com o código atual:**

- ~16 req/s na mistura do cenário D (leituras autenticadas, reservas, checkout e confirmação Pix) por ~17 min seguidos, com p95 das leituras abaixo de 0,5 s.
- Acima dessa duração em carga contínua, o banco entra em paradas intermitentes de até ~30 s. Não há perda de consistência e há recuperação espontânea.
- A rodada D de 30 min continua reprovada, e o `release-readiness.md` não muda.
- A PR 4 (flags e frequência do Worker de jobs) reduz idas ao banco em poucos pontos por cento. Ela não muda o perfil acima e fica sem prioridade até a análise das métricas.

## Causa confirmada e próximo gate (2026-10-03)

**Métricas do projeto Supabase de staging na janela da parada (02/10, 22:55–23:06 UTC):**

- **Memória:** memória comprometida em ~1,6–1,7 GB, contra um limite de commit de ~1,2 GB; uso expressivo de swap durante toda a janela.
- **CPU:** IOWait muito elevado, sem saturação de trabalho útil.
- **Disco:** ~18 IOPS, contra um teto de ~3.000; vazão de centenas de KB/s, contra ~125 MB/s.
- **Conexões:** ~16, contra um limite de ~60.
- **Tamanho:** ~100 MB de dados.

**Conclusão:** os ~16 req/s sustentados do cenário D excedem o envelope de memória da instância Supabase Free. A pressão de memória leva ao swap, e o IOWait do swap leva às paradas globais.

- A causa não é uma consulta individual, lock, conexão, Cloudflare nem o tamanho do banco.
- **16 req/s sustentados por 30 min não são suportados no Supabase Free.** Esse teste não se repete.
- Supabase pago não faz parte do Marco 1, e nenhuma nova otimização entra neste momento.

**Próximo gate:** determinar a capacidade operacional sustentável do Free. Faz uma única rodada D de 30 min a ~8 req/s, com a mesma mistura de leituras e mutações (`load_rate_d=8`, `tests/load/README.md`), os mesmos dados sintéticos e invariantes, `payment_link` desligado e só em staging.

**Critérios:**
- 0 violações, 0 duplicações, 0 respostas 5xx e 0 timeouts;
- p95 das leituras abaixo de 1,5 s, e das mutações abaixo de 2,5 s, como referência;
- nenhum degrau global de latência;
- outbox drenando.

Se a rodada passar, a medição para ali, sem aumento automático de taxa. A decisão de medir um envelope maior vem depois da análise. O `release-readiness.md` continua sem READY.

