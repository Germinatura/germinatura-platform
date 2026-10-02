# Relatório de estabilidade, carga e soak — staging

Homologação de 02/10/2026, feita antes do congelamento do Release Candidate. **Conclusão: a integridade transacional está aprovada, mas o Release Candidate não está pronto na infraestrutura atual.**
- Faltam duas decisões do responsável, ambas de plano e custo de infraestrutura (seção "Conclusão de prontidão").
- Nada foi promovido para `main` e nada rodou contra produção.

## Identificação

| | |
| --- | --- |
| SHA homologado | `2b7a8b8` na rodada completa (A, B, C e D); `1965633` (após a #147) e `b897cd0` (após a #148) nos soaks de verificação |
| Ambiente | Staging: Workers `germinatura-{portal,pdv,jobs}-staging.germinatura.workers.dev` e projeto Supabase de staging |
| Plano observado | Workers com limite de CPU por requisição de plano gratuito (o tail mostra `exceededCpu`, `exceededMemory` e limite de subrequisições); Supabase de staging no plano atual do projeto |
| Ferramenta | Harness próprio em Node 22, sem dependências (`tests/load`); escolha documentada em `tests/load/README.md` |
| Execução | Job `load` do `Deploy Staging`, disparado na `develop` com `load_scenarios`; `wrangler tail` do Portal durante a carga |
| Rodadas | 36967163197 (completa: 10 + 10 min, C, soak de 30 min); 36976211165 (C e soak de 30 min após a #147); 36982106423 (soak de 20 min com amostra do banco após a #148) |

## Dataset

- **Fixtures da rodada** (`tests/load/fixtures.sql`), criadas pelas RPCs do produto por um administrador da própria rodada:
  - contas: 15 vendedores com local e estoque provisionados e 70 consumidores, todos sintéticos `load.<run>.*@institutojef.org.br`, já confirmados e sem envio de e-mail;
  - produtos: 11 "Carga <run>" com estoque central, incluindo as unidades disputadas (1 cada);
  - rifa de 20 números e cupom público com limite global de 5.
- **Catálogo de fundo:** o já existente em staging.
- **Retirada no fim** (`loadtest.retire`): produtos despublicados, contas desativadas e rifa cancelada. O histórico continua, porque os ledgers são imutáveis.
- **Fora do escopo:** nenhum e-mail enviado, nenhuma chamada ao PicPay e `payment_link` continuou desligada.

## Cenários

| | Carga | Duração |
| --- | --- | --- |
| A — navegação e leitura | 50 consumidores: Início, vitrine, catálogo (2 páginas), cotação com promoção, eventos, rifas, notificações | 10 min |
| B — operação autenticada | 15 vendedores pelo host do PDV (service binding): catálogo, estoque próprio, transferências, histórico, retiradas, rifas, turno, maquininhas | 10 min |
| C — concorrência transacional | Os 7 casos abaixo, com invariantes depois de cada um | ~30 s |
| D — soak | 20 leitores, 5 vendedores com vendas reais por Área Pix e ciclos de reserva e cancelamento; outbox (e, na última rodada, o banco) amostrados por minuto | 30 min (20 na última) |

## Resultados

Tempos em milissegundos. "4xx esp." é a disputa perdida esperada em C.

### A — 50 consumidores, 10 min (rodada completa, `2b7a8b8`)

| Rota | Req. | OK | 5xx | p50 | p95 | p99 | /s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| página `/inicio` | 2.959 | 844 | **2.115** | 378 | 965 | 2.580 | 4,84 |
| página `/catalogo` | 2.959 | 1.024 | **1.935** | 345 | 759 | 1.738 | 4,84 |
| página `/eventos` | 2.959 | 577 | **2.382** | 221 | 1.796 | 5.385 | 4,84 |
| página `/rifas` | 2.959 | 620 | **2.339** | 427 | 1.076 | 2.583 | 4,84 |
| API vitrine | 2.959 | 2.902 | 57 | 434 | 730 | 1.450 | 4,84 |
| API catálogo | 2.959 | 2.959 | 0 | 355 | 575 | 1.443 | 4,84 |
| API cotação | 2.959 | 2.959 | 0 | 288 | 631 | 1.649 | 4,84 |
| API eventos | 2.959 | 2.959 | 0 | 504 | 893 | 2.413 | 4,84 |
| API notificações | 2.959 | 2.959 | 0 | 428 | 708 | 2.493 | 4,84 |

Logins: 66 de 66, com a fila espaçada de 1 s.

### B — 15 vendedores no PDV, 10 min

| Rota | Req. | OK | 5xx | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- | --- |
| página do PDV | 910 | 910 | 0 | 188 | 246 | 1.236 |
| catálogo (binding) | 910 | 910 | 0 | 358 | 616 | 1.095 |
| estoque próprio | 910 | 863 | 47 | 426 | 592 | 1.497 |
| transferências | 910 | 910 | 0 | 431 | 547 | 982 |
| minhas vendas | 910 | 910 | 0 | 427 | 571 | 1.820 |
| vendas pendentes | 910 | 910 | 0 | 428 | 669 | 1.459 |
| retiradas | 910 | 910 | 0 | 488 | 701 | 1.696 |
| rifas | 910 | 910 | 0 | 424 | 599 | 2.052 |
| turno | 910 | 910 | 0 | 426 | 539 | 1.446 |
| maquininhas | 910 | 910 | 0 | 421 | 537 | 788 |

Throughput: 1,49 req/s por rota. Os 47 5xx do estoque próprio são `exceededCpu` no Portal, confirmados no tail.

### C — concorrência transacional (repetido em três rodadas, mesmo resultado)

| Caso | Tentativas | Vencedores | Esperado | Violações |
| --- | --- | --- | --- | --- |
| 20 clientes pela última unidade central | 20 | 1 | 1 reserva | 0 |
| venda × transferência da mesma unidade do vendedor | 2 | 1 | 1 vence | 0 |
| reserva × venda no central da mesma unidade | 2 | 1 | 1 vence | 0 |
| 20 clientes pelos mesmos números de rifa | 20 | 1 | 1 dono | 0 |
| checkout repetido 10× com a mesma chave de idempotência | 10 | 1 venda | 1 venda | 0 |
| duas confirmações simultâneas da mesma venda | 2 | 1 | 1 pagamento | 0 |
| cupom com limite global 5, 15 reservas | 15 | 5 com desconto | ≤ 5 | 0 |

O p95 das mutações disputadas ficou entre 0,3 e 1,2 s. Na rodada completa, C1 e C7 chegaram a 2,9 s e 4,8 s, porque rodaram logo depois de A, com a plataforma ainda carregada.

### D — soak

| Rodada | Rota (amostra) | Req. | 5xx | Rede | p50 | p95 | Inclinação do p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| antes da #147 (30 min) | vitrine | 2.721 | 415 | 47 | 534 | 19.079 | +538 ms/min |
| | checkout | 248 | 24 | 13 | 4.286 | 30.000 | +458 ms/min |
| | criar reserva | 445 | 91 | 10 | 1.897 | 22.380 | +339 ms/min |
| depois da #147 (30 min) | vitrine | 2.633 | 1.489 | 38 | 365 | 17.574 | +260 ms/min |
| | checkout | 223 | 26 | 22 | 6.295 | 30.001 | +126 ms/min |
| | criar reserva | 432 | 110 | 12 | 4.846 | 20.704 | +294 ms/min |
| com amostra do banco (20 min) | catálogo | 2.261 | 0 | 2 | 245 | 4.834 | +755 ms/min |
| | eventos | 2.261 | 635 | 2 | 328 | 4.672 | +766 ms/min |
| | criar reserva | 365 | 73 | 5 | 842 | 17.918 | +814 ms/min |

#### Outbox no soak

| Rodada | Pendentes | Mais antigo | Presos em `PROCESSING` |
| --- | --- | --- | --- |
| antes da #147 | 37 → **1.362** (sem recuperar) | até **~25 min** | até 86 |
| depois da #147 | 2 a 135, drenando todo minuto | até ~2,5 min | 0 |

#### Banco no soak (última rodada)

| Medida | Valor |
| --- | --- |
| Conexões | 20 a 27 |
| Consultas ativas | até 12 |
| Esperas por lock | até 7 (reservas concorrentes do mesmo produto) |
| Consulta ativa mais longa | até ~8 s |

## Falhas encontradas

1. **Limite de CPU do Worker nas páginas renderizadas no servidor (bloqueante, depende de plano).**
   - **Sintoma:** com 50 consumidores, 65 a 80% das páginas `/inicio`, `/catalogo`, `/eventos` e `/rifas` voltam 503 de corpo vazio, enquanto as APIs das mesmas telas respondem 200.
   - **Causa confirmada pelo tail:** 1.941 eventos "Worker exceeded CPU time limit" e 15 "Worker exceeded memory limit" na rodada completa.
   - **Onde aparece:** sobretudo na renderização das páginas; sob soak, também na API da vitrine e em algumas mutações.
   - **Por que não é um ajuste de código:** o limite observado é o de CPU por requisição do plano gratuito de Workers, e a renderização React no servidor não cabe nele de forma confiável sob concorrência. Otimizar o código reduziria a taxa, mas não daria garantia.
2. **Outbox sem vazão e eventos presos (corrigido na #147).**
   - **Causa:** o worker fazia uma chamada HTTP por evento (até 50 eventos por minuto), e um ciclo cheio passava do limite de subrequisições do plano gratuito. Os eventos já reservados ficavam em `PROCESSING` até o lease de 300 s vencer.
   - **Efeito:** no soak, mais de 1.300 eventos pendentes, com o mais antigo esperando cerca de 25 min.
3. **Degradação progressiva no soak (aberta).**
   - **Sintoma:** a latência cresce em todas as rotas, e mutações voltam 503 da própria aplicação (Worker `ok` com 503) quando o banco demora.
   - **O que a amostra mostra:** banco ativo, mas não travado (até 12 consultas ativas, esperas por lock no produto disputado, consultas de até ~8 s).
   - **Causa provável, não confirmada:** a capacidade do plano atual do Supabase de staging somada a uma ida ao Supabase Auth em toda requisição (`auth.getUser` no proxy do Portal). Confirmar exige as métricas do projeto Supabase.
4. **Rajada de logins simultâneos.** Na primeira rodada, 50 logins no mesmo segundo foram recusados com o 401 genérico do Portal; com 1 login por segundo, 66 de 66 entraram. É compatível com o limite de taxa de login do Supabase Auth, que o Portal mascara como credencial inválida. Em operação real, picos de login no início de um evento podem reproduzir isso.
5. **Teste de integração intermitente na CI.** `integration/sales-checkout-concurrency.test.ts:199` (duas conciliações simultâneas com a mesma chave) falhou uma vez na #141 e passou na reexecução e em seis repetições locais. Está registrado para acompanhar.

## Correções feitas

| PR | Correção |
| --- | --- |
| #139 | Local central e local do vendedor provisionados pelo schema (encontrado ao preparar o dataset: em produção greenfield não existiriam) |
| #147 | Outbox processada em lotes no banco (`worker_process_outbox_batch`, até 100 eventos por chamada e 5 lotes por ciclo); soak repetido |
| #142 a #146, #148 | Harness: preflight de login, fila de logins com retentativa, amostras de falha, tail do Portal, leitor do tail, cotação e cupom das fixtures, amostra do banco |

## Invariantes conferidas

Depois de cada caso de C e ao fim de cada rodada (o harness termina com erro se alguma falhar; todas as rodadas terminaram em sucesso):
- estoque nunca negativo nem reservado acima do saldo;
- unidade disputada sem consumo duplo;
- número de rifa com um só dono;
- venda com no máximo um pagamento confirmado;
- ledger sem lançamento de pagamento duplicado;
- chave de idempotência com um só resultado;
- cupom sem resgate acima do limite global;
- outbox sem evento preso em processamento por mais de 10 minutos.

Resultado: **0 violações**, e nenhuma duplicação financeira ou de estoque.

## Limitações

- A concorrência é por usuário virtual com `await`, sem taxa fixa de chegada.
- O tail da Cloudflare é amostrado quando o volume é alto. As contagens por caminho são parciais; as do harness são completas.
- Staging divide o Supabase com outras verificações, e o banco já tinha os dados de rodadas anteriores.
- Não houve acesso às métricas internas do projeto Supabase (CPU, pool e Auth), por isso a causa da degradação no soak é provável, não confirmada.
- A ficou em 50 consumidores e B em 15 vendedores, como pedido. Não tentei achar o ponto de ruptura, para não estressar a plataforma nem gerar custo.

## Critérios de aceite

| Critério | Resultado |
| --- | --- |
| 0 violações de integridade | **Atendido** |
| 0 duplicação financeira ou de estoque | **Atendido** |
| 0 5xx nas jornadas normais | **Não atendido**: CPU do Worker nas páginas e, no soak, 503 da aplicação |
| p95 de leitura pública < 1,5 s | **Atendido nas APIs** em A (0,6 a 0,9 s); as páginas falham antes por CPU |
| p95 de mutações normais < 2,5 s | **Atendido em C** sem carga de fundo; **não atendido no soak** |
| Sem tendência crescente de latência no soak | **Não atendido** |

## Conclusão de prontidão

A integridade transacional está pronta: locks, idempotência, ledgers, rifas, cupom e outbox se mantiveram corretos sob concorrência.

O Release Candidate **não** está pronto na infraestrutura atual. Recomendações, em ordem:

1. **Decisão do responsável — plano pago de Workers da Cloudflare** (custo novo; não feito pelo agente).
   - Remove o limite de CPU de 10 ms por requisição e o de 50 subrequisições, causas confirmadas dos 503.
   - Depois da mudança, repetir A e D com `gh workflow run deploy-staging.yml --ref develop -f load_scenarios=A,B,C,D -f load_minutes=10,10,30`.
2. **Decisão do responsável — capacidade do Supabase de produção** (custo possível).
   - Conferir o plano e as métricas do projeto durante o soak repetido.
   - Se a degradação continuar com Workers pago, dimensionar a capacidade de computação antes do go-live.
3. **Melhoria de código sugerida** (PR futura, sem custo; mexe na autenticação e por isso merece revisão própria): validar a sessão no proxy do Portal localmente pelo JWT (`getClaims` com chaves assimétricas) em vez de chamar `auth.getUser` a cada requisição. Isso tira uma ida ao Auth de toda requisição.
4. **Login em pico:** confirmar e, se preciso, ajustar o limite de taxa de login do Supabase Auth, e fazer o Portal distinguir "muitas tentativas" de "credencial inválida".

O critério de aceite numérico continua uma referência: depois da troca de plano, o limite adequado deve sair da nova medição, não deste relatório.
