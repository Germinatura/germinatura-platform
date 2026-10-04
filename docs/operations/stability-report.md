# Relatório de estabilidade, carga e soak — staging

Homologação de 02/10/2026, feita antes do congelamento do Release Candidate. **Conclusão: a integridade transacional está aprovada, mas o Release Candidate não está pronto na infraestrutura atual.**
- Faltam duas decisões do responsável, ambas de plano e custo de infraestrutura (seção "Conclusão de prontidão").
- Nada foi promovido para `main` e nada rodou contra produção.
- **Atualização (02/10/2026, tarde):** com o Workers Paid contratado, A passou sem nenhum 503 de CPU, mas o soak continua degradando. Veja "Workers Paid — rodada de validação" no fim. As seções anteriores a ela registram as rodadas no plano gratuito e ficam para comparação.
- **Atualização (02/10/2026, noite):** depois da #152, a resolução de sessão não chama mais o Supabase Auth. O soak de 10 min ficou estável até o minuto 7 e travou nos minutos 8 e 9, numa parada do banco que atingiu todas as rotas ao mesmo tempo. Veja "Otimização da resolução de sessão — soak de 10 min" no fim.

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

## Workers Paid — rodada de validação

Rodada de 02/10/2026, à tarde, para medir só o efeito da troca para o plano pago de Workers da Cloudflare. Código, harness, dataset, rotas e critérios iguais aos da rodada anterior; nenhuma otimização foi feita.

**Conclusão: os problemas da Cloudflare desapareceram e A passou. O soak não estabilizou e a latência continua crescendo.** Como combinado, a rodada para aqui: o gargalo restante está documentado abaixo para a análise do Supabase e da autenticação, sem concluir que o Supabase precisa de upgrade.

### Identificação

| | |
| --- | --- |
| SHA | `96f71de` (`develop` sem mudanças desde a homologação anterior) |
| Deploy | Deploy Staging normal 37016417720 no mesmo SHA, já com o plano pago ativo |
| Carga | Rodada 37016802870: `gh workflow run deploy-staging.yml --ref develop -f load_scenarios=A,D -f load_minutes=10,30` (A por 10 min, seguido do soak D por 30 min) |
| Plano | Cloudflare Workers Paid; Supabase de staging sem mudança de plano |
| Fora do escopo | Nenhum e-mail enviado, nenhuma chamada ao PicPay, `payment_link` desligada |
| Invariantes | Conferidas ao fim pelo harness (`loadtest.check`), que termina com erro se alguma falhar: a rodada terminou com sucesso, com **0 violações** |

### A — 50 consumidores, 10 min

| Rota | Req. | OK | 4xx | 5xx | Rede | p50 | p95 | p99 | /s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| página `/inicio` | 3.160 | 3.160 | 0 | 0 | 0 | 232 | 1.394 | 3.644 | 5,19 |
| página `/catalogo` | 3.160 | 3.159 | 0 | 0 | 1 | 197 | 1.282 | 4.191 | 5,19 |
| página `/eventos` | 3.160 | 3.160 | 0 | 0 | 0 | 180 | 1.223 | 2.944 | 5,19 |
| página `/rifas` | 3.160 | 3.160 | 0 | 0 | 0 | 212 | 1.229 | 2.374 | 5,19 |
| API vitrine | 3.160 | 3.160 | 0 | 0 | 0 | 205 | 1.049 | 2.766 | 5,19 |
| API catálogo | 3.160 | 3.160 | 0 | 0 | 0 | 134 | 710 | 2.536 | 5,19 |
| API cotação | 3.160 | 3.159 | 0 | 1 | 0 | 137 | 1.148 | 3.065 | 5,19 |
| API eventos | 3.160 | 3.159 | 0 | 0 | 1 | 243 | 1.347 | 5.352 | 5,19 |
| API notificações | 3.160 | 3.160 | 0 | 0 | 0 | 194 | 907 | 2.384 | 5,19 |

- Total: 28.440 requisições, 46,7 req/s, 28.437 com sucesso.
- O único 5xx é um `PRICING_UNAVAILABLE` da própria aplicação (a RPC de cotação devolveu erro). Os 2 erros de rede são conexões interrompidas (`TypeError` no cliente).
- Logins: 55 de 55, sem nenhuma recusa.

### D — soak de 30 min (20 leitores e 5 vendedores)

| Rota ou mutação | Req. | OK | 4xx | 5xx | Rede | p50 | p95 | p99 | Inclinação do p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vitrine | 2.208 | 2.063 | 2 | 1 | 142 | 637 | 30.000 | 30.001 | +238 ms/min |
| catálogo | 2.208 | 2.178 | 0 | 3 | 27 | 363 | 17.564 | 30.000 | +325 ms/min |
| eventos | 2.208 | 2.174 | 1 | 0 | 33 | 482 | 7.290 | 30.000 | +324 ms/min |
| notificações | 2.208 | 2.183 | 1 | 0 | 24 | 352 | 6.066 | 29.999 | +211 ms/min |
| minhas vendas (PDV) | 190 | 175 | 0 | 0 | 15 | 7.272 | 30.001 | 30.001 | +325 ms/min |
| checkout (PDV) | 190 | 133 | 0 | 19 | 38 | 7.101 | 30.001 | 30.002 | +217 ms/min |
| confirmação Área Pix | 133 | 108 | 0 | 16 | 9 | 4.402 | 30.000 | 30.001 | +70 ms/min |
| criar reserva | 362 | 300 | 0 | 49 | 13 | 3.232 | 23.959 | 30.001 | +153 ms/min |
| cancelar reserva | 300 | 262 | 0 | 32 | 6 | 1.984 | 20.133 | 30.000 | −141 ms/min |

- Total: 10.007 requisições, 120 respostas 5xx e 307 erros de rede.
- Quase todos os erros de rede são o tempo-limite de 30 s do harness (`TimeoutError`).
- Os 5xx das mutações são 503 da própria aplicação (`RESERVATION_UNAVAILABLE`, `MANUAL_CONFIRMATION_UNAVAILABLE`), devolvidos quando a resolução da sessão ou a RPC falha.
- Os 4 4xx inesperados são 401 no meio de sessões válidas, o que indica falha ao resolver a sessão (Supabase Auth `getUser` ou a RPC `get_my_session`).
- A inclinação é positiva em 8 das 9 rotas.

#### Outbox e banco, amostrados por minuto

| Medida | Workers Paid | Gratuito, depois da #147 |
| --- | --- | --- |
| Outbox pendente | 0 a 234, em dente de serra: acumula por 3 a 5 min e cai para 3 a 64 (minutos 6, 10, 15, 20 e 24) | 2 a 135 |
| Evento pendente mais antigo | até 273 s (~4,6 min) | até ~2,5 min |
| Presos em `PROCESSING` / `FAILED` | 0 / 0 em todas as amostras | 0 |
| Conexões PostgreSQL | 22 a 27 | 20 a 27 |
| Consultas ativas | até 11 | até 12 |
| Esperas por lock | até 5 (minutos 4, 18 e 25) | até 7 |
| Consulta ativa mais longa | até 19 s (minuto 8); fora isso, ≤ 8 s | até ~8 s |

- A outbox drena e não cresce entre os ciclos, mas a idade do evento mais antigo passou de 2,5 para 4,6 min. O Worker de jobs não teve tail nesta rodada, por isso a causa dos ciclos lentos não foi observada.
- Valores negativos da consulta mais longa aparecem quando a consulta começou depois do início da transação da amostra; contam como ~0.
- Faltam algumas amostras (minutos 7, 12, 16, 21 e 28), porque a própria consulta da amostra demorou.

### Comparação Free × Paid

| Medida | Gratuito | Workers Paid |
| --- | --- | --- |
| A: 5xx nas páginas | 1.935 a 2.382 por página (65 a 80%) | **0** |
| A: 5xx nas APIs | 57 (vitrine) | 1 (cotação, erro da RPC) |
| A: p95 das páginas | 759 a 1.796 ms, contando só as que responderam | 1.223 a 1.394 ms, todas respondendo |
| A: p95 das APIs | 575 a 893 ms | 710 a 1.347 ms |
| A: vazão por rota | 4,84 req/s | 5,19 req/s |
| D: vitrine | 1.489 5xx, 38 rede, p95 17,6 s, +260 ms/min | 1 5xx, 142 rede, p95 30 s, +238 ms/min |
| D: checkout | 26 5xx, 22 rede, p50 6,3 s, p95 30 s, +126 ms/min | 19 5xx, 38 rede, p50 7,1 s, p95 30 s, +217 ms/min |
| D: criar reserva | 110 5xx, 12 rede, p50 4,8 s, p95 20,7 s, +294 ms/min | 49 5xx, 13 rede, p50 3,2 s, p95 24,0 s, +153 ms/min |
| Tail: `exceededCpu` / `exceededMemory` | 1.941 / 15 | **0 / 0** |

- As APIs de A ficaram um pouco mais lentas no Paid porque, sem os 503 de CPU, as páginas passaram a renderizar por inteiro. Cada renderização também consulta o Supabase, então o banco recebeu mais trabalho real no mesmo tempo.
- No soak, a troca de plano converteu 503 de CPU em espera: as requisições agora chegam ao Supabase e ficam aguardando até o tempo-limite.

### Cloudflare

- Tail do Portal durante toda a rodada: 16.366 eventos (amostrados pela Cloudflare), sendo 16.284 `ok` e 82 `canceled`. Os `canceled` são o cliente desistindo no tempo-limite de 30 s.
- **0 `exceededCpu`, 0 `exceededMemory` e nenhum erro de limite de subrequisições.**
- Outros erros do runtime: apenas 10 "Network connection lost", uma conexão de saída interrompida.
- Todos os 503 do soak saíram com o Worker em `ok`: são respostas da aplicação, não limites da plataforma.
- O checkout e a confirmação do PDV executam no Portal pelo service binding e aparecem nesse tail.
- **Limitação:** só o Portal teve tail, porque é o que o workflow captura. O `wrangler` local não estava autenticado, e o PDV e o Worker de jobs não foram observados diretamente.

### Gargalo restante (para análise; nada foi alterado)

A plataforma da Cloudflare deixou de ser o limite. O tempo perdido no soak está na espera pelo Supabase: o Worker termina em `ok`, sem CPU excedida, e a requisição fica aguardando até o tempo-limite ou volta 503/401 quando a chamada ao Supabase falha.

Observações que orientam a análise, sem confirmar a causa:
1. **A degradação não acompanha o volume de leitura.** A fez 4,4 vezes mais leituras por segundo por rota e manteve o p95 das APIs em ~1 s. D, com leitura menor mas com vendas, reservas e cancelamentos contínuos, degradou em todas as rotas, inclusive nas leituras. O soak isolado da rodada anterior, sem A antes, também degradou.
2. **Pontos de suspeita a medir:**
   - capacidade de computação do banco de staging sob escrita contínua (CPU, E/S e eventual crédito de burst esgotado);
   - a resolução de sessão por requisição autenticada: `auth.getUser` no Supabase Auth mais a RPC `get_my_session`, no proxy e na rota;
   - a disputa pelo produto do soak (esperas por lock até 5, uma consulta de 19 s).
3. **Para confirmar**, numa próxima rodada:
   - acompanhar as métricas do projeto Supabase de staging durante o soak (CPU, memória, E/S, conexões do PostgREST e latência do Auth);
   - ver as consultas mais caras em `pg_stat_statements`;
   - ter tail do PDV e do Worker de jobs.

### Critérios de aceite — Workers Paid

| Critério | Resultado |
| --- | --- |
| 0 violações de integridade | **Atendido** |
| 0 duplicação financeira ou de estoque | **Atendido** |
| 0 5xx nas jornadas normais | **Atendido em A** (1 erro de RPC em 28.440); **não atendido em D** (120) |
| p95 de leitura pública < 1,5 s | **Atendido em A**: páginas 1,22 a 1,39 s, APIs 0,71 a 1,35 s |
| p95 de mutações normais < 2,5 s | **Não atendido em D**: 20 a 30 s |
| Sem tendência crescente de latência no soak | **Não atendido**: +70 a +325 ms/min em 8 das 9 rotas |
| Outbox drenando normalmente | **Atendido**, com ressalva: drena e não acumula entre ciclos, mas o evento mais antigo chegou a ~4,6 min |

### Prontidão depois desta rodada

- O bloqueio da Cloudflare foi resolvido: o limite de CPU e memória não aparece mais e A passa nos critérios.
- O Release Candidate continua bloqueado pela degradação no soak. O próximo passo é a análise do Supabase e da autenticação descrita acima, antes de decidir entre otimização (por exemplo, validar o JWT localmente no lugar de `auth.getUser`) e capacidade do Supabase. Nenhuma das duas foi feita nesta rodada.

## Otimização da resolução de sessão — soak de 10 min

Rodada de 02/10/2026, à noite, depois da #152, que removeu as chamadas ao Supabase Auth da resolução de sessão sem mudar autorização nem segurança. Como combinado, só D, por 10 min. O soak apresentou degradação clara no fim, então a rodada de 30 min **não** foi feita e nenhuma capacidade foi contratada.

### Identificação

| | |
| --- | --- |
| SHA | `79bcc09` (#152), depois de Quality pós-merge, Deploy Staging e smokes verdes |
| Carga | Rodada 37047189386: `gh workflow run deploy-staging.yml --ref develop -f load_scenarios=D -f load_minutes=10,10,10` |
| Observação | Tail do Portal, do PDV e do Worker de jobs (#151); outbox e banco amostrados por minuto; tempos de resolução de sessão no tail (`AUTH_TIMING_LOG=1`, só em staging) |
| Fora do escopo | A não foi repetido; nenhum e-mail enviado, nenhuma chamada ao PicPay, `payment_link` desligada |
| Invariantes | **0 violações** nas 8 conferências finais; logins 25 de 25 |

### Chamadas de autenticação por requisição

| Requisição | Antes: `auth.getUser` (Auth) | Antes: `get_my_session` | Depois: chamadas ao Auth | Depois: `get_my_session` |
| --- | --- | --- | --- | --- |
| API autenticada do Portal (proxy + rota) | 2 | 2 | **0** (assinatura ES256 conferida localmente) | 2 |
| API do PDV (encaminhada ao Portal pelo service binding) | 2 | 2 | **0** | 2 |
| Página autenticada do Portal | 2 | 2 | **0** | 2 |
| Página do PDV | 1 | 1 | **0** | 1 |

- Cada `getUser` era uma ida HTTP ao Supabase Auth, que também consulta o usuário e a sessão no mesmo banco.
- `get_my_session` passou a recusar uma sessão encerrada (logout, "Sessões ativas"), como o Auth fazia. Os tokens alterados, expirados ou assinados por outra chave continuam recusados.
- O tail confirma o comportamento:
  - 2.327 requisições do Portal tiveram 2 resoluções (proxy e rota) e 497 tiveram 1 (a API pública de catálogo, resolvida só no proxy);
  - a verificação do token levou 0 ms na mediana, com máximo de 609 ms quando um isolate novo busca as chaves públicas;
  - não houve nenhum 401 inesperado (eram 4 na rodada anterior) nem erro do Auth.
- O tail do PDV não registra resoluções, porque as APIs dele são encaminhadas ao Portal e o soak não abre páginas do PDV.

| Resolução (tail do Portal) | Qtde. | `get_my_session` p50 | p95 | p99 | máx. |
| --- | --- | --- | --- | --- | --- |
| no proxy | 2.802 | 86 ms | 272 ms | 2.384 ms | 13.361 ms |
| na rota | 2.327 | 81 ms | 149 ms | 1.349 ms | 18.452 ms |

### D — 10 min

| Rota ou mutação | Req. | OK | 5xx | Rede | p50 | p95 | p99 | Inclinação do p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vitrine | 1.864 | 1.864 | 0 | 0 | 306 | 1.192 | 6.389 | +981 ms/min |
| catálogo | 1.864 | 1.864 | 0 | 0 | 307 | 519 | 2.449 | +639 ms/min |
| eventos | 1.864 | 1.864 | 0 | 0 | 341 | 486 | 1.174 | +69 ms/min |
| notificações | 1.864 | 1.864 | 0 | 0 | 267 | 400 | 1.134 | +62 ms/min |
| minhas vendas (PDV) | 133 | 133 | 0 | 0 | 339 | 5.546 | 11.944 | +1.360 ms/min |
| checkout (PDV) | 133 | 131 | 2 | 0 | 485 | 3.700 | 21.318 | +1.058 ms/min |
| confirmação Área Pix | 131 | 129 | 2 | 0 | 459 | 4.521 | 10.760 | +1.069 ms/min |
| criar reserva | 300 | 299 | 1 | 0 | 427 | 2.674 | 4.610 | +1.817 ms/min |
| cancelar reserva | 299 | 297 | 2 | 0 | 323 | 2.085 | 7.307 | +1.272 ms/min |

- Total: 8.452 requisições, 7 respostas 5xx (todas 503 da aplicação nos minutos 9 e 10), **0 erros de rede e 0 tempos-limite**.
- Vazão por rota de leitura: 2,88 req/s, contra 1,19 req/s no soak anterior. O harness espera cada resposta antes de enviar a próxima, então a vazão maior reflete respostas mais rápidas.

#### p95 por minuto (ms)

| Rota | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vitrine | 3.204 | 388 | 367 | 366 | 400 | 351 | 353 | 418 | 1.910 | **19.978** |
| catálogo | 701 | 384 | 370 | 346 | 363 | 364 | 390 | 399 | 844 | **12.027** |
| notificações | 1.028 | 316 | 300 | 294 | 307 | 291 | 297 | 327 | 533 | 1.988 |
| checkout | 1.477 | 1.240 | 746 | 1.317 | 1.204 | 701 | 654 | 1.513 | 4.764 | **22.267** |
| criar reserva | 589 | 814 | 693 | 573 | 781 | 612 | 552 | 2.674 | 4.610 | **29.871** |

O minuto 0 inclui o aquecimento dos isolates.

**O comportamento não é um crescimento contínuo.** Do minuto 1 ao 7, as leituras ficaram estáveis entre 0,3 e 0,45 s e as mutações entre 0,5 e 1,5 s. Nos minutos 8 e 9, todas as rotas travaram juntas. A inclinação positiva vem desse degrau final.

#### Outbox e banco

| Medida | Soak de 10 min (depois) | Soak de 30 min anterior (antes) |
| --- | --- | --- |
| Outbox pendente | 0 a 124 até o minuto 8; 263 no minuto 9 | 0 a 234 |
| Evento pendente mais antigo | 18 a 39 s até o minuto 8; 103 s no minuto 9 | até 273 s |
| Presos em `PROCESSING` / `FAILED` | 0 / 0 | 0 / 0 |
| Conexões PostgreSQL | 9 a 16 | 22 a 27 |
| Consultas ativas | 1 a 7 | até 11 |
| Esperas por lock | 0, exceto 2 no minuto 8 | até 5 |
| Consulta ativa mais longa | ~0 s nas amostras | até 19 s |

- O Worker de jobs rodou o cron 11 vezes, todas `ok`, sem exceção nem limite.
- A outbox só acumulou durante a parada final.

#### Cloudflare

| Worker | Eventos no tail | Resultado | `exceededCpu` / `exceededMemory` / subrequisições | Exceções |
| --- | --- | --- | --- | --- |
| Portal | 2.824 | todos `ok` | 0 / 0 / 0 | nenhuma |
| PDV | 403 | todos `ok` | 0 / 0 / 0 | nenhuma |
| jobs | 11 (cron) | todos `ok` | 0 / 0 / 0 | nenhuma |

### Comparação com a rodada anterior

As janelas são diferentes: 10 min agora, 30 min antes, logo depois de A. A comparação vale para a ordem de grandeza.

| Medida | Antes (Workers Paid, 30 min) | Depois da #152 (10 min) |
| --- | --- | --- |
| Chamadas ao Supabase Auth por requisição autenticada | 2 | 0 |
| Erros de rede / tempos-limite | 307 | **0** |
| 5xx | 120 | 7 |
| 401 inesperados (falha ao resolver a sessão) | 4 | 0 |
| p95 da vitrine / catálogo | 30,0 s / 17,6 s | 1,19 s / 0,52 s |
| p95 do checkout / criar reserva | 30,0 s / 24,0 s | 3,7 s / 2,7 s |
| Vazão por rota de leitura | 1,19 req/s | 2,88 req/s |
| Inclinação do p95 | +70 a +325 ms/min, crescimento contínuo | estável até o minuto 7, degrau nos minutos 8 e 9 |

### Gargalo restante (para análise; nada foi alterado)

No fim do soak, o banco de staging parou de forma geral. Isso não parece disputa de aplicação:
- `get_my_session`, uma consulta por chave primária que não toca estoque, chegou a 13 e 18 s na mesma janela em que o checkout e as reservas chegaram a 20–30 s.
- A própria amostra do banco, que entra pela API de gestão do Supabase e não pelo Worker, atrasou ~11 s no minuto 9. É o valor negativo da "consulta mais longa": a amostra começou 11 s antes de conseguir ler `pg_stat_activity`.
- As amostras não mostram fila de consultas, esperas por lock relevantes (no máximo 2) nem consultas longas, e as conexões ficaram em 16.
- O Cloudflare ficou limpo nos três Workers, e o Auth não está mais no caminho.

A hipótese mais provável é **limite de recursos da instância do Supabase de staging** (CPU, E/S ou crédito de burst esgotado após alguns minutos de escrita contínua), ou o pool de conexões dela. A aplicação e a autenticação não explicam o padrão. Para confirmar:
- olhar as métricas do projeto Supabase de staging entre 18:33 e 18:36 UTC de 02/10/2026 (CPU, E/S de disco, saldo de burst, memória, conexões do PostgREST e do pooler);
- conferir em `pg_stat_statements` se alguma consulta concentrou tempo nesse intervalo.

Nada disso foi feito nesta rodada: a carga parou no soak de 10 min, sem a rodada de 30 min e sem compra de capacidade.

### Critérios de aceite — depois da #152

| Critério | Resultado |
| --- | --- |
| 0 violações de integridade | **Atendido** |
| 0 duplicação financeira ou de estoque | **Atendido** |
| 0 5xx nas jornadas normais | **Não atendido**: 7, todos durante a parada do banco |
| p95 de leitura pública < 1,5 s | **Atendido** no total da rodada: 0,40 a 1,19 s |
| p95 de mutações normais < 2,5 s | **Atendido do minuto 1 ao 7; não atendido na rodada**: 2,1 a 4,5 s no total, por causa da parada |
| Sem tendência crescente de latência no soak | **Não atendido**: degrau nos minutos 8 e 9 |
| Outbox drenando normalmente | **Atendido**, com acúmulo só durante a parada |

`release-readiness.md` não mudou: o bloqueio de carga continua até a causa da parada do banco ser confirmada.
