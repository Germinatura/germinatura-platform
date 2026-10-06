# Carga, concorrência e soak em staging

Harness para a homologação de estabilidade. O relatório da rodada fica em `docs/operations/stability-report.md`.

## Por que um harness próprio

Escolhi uma implementação própria em Node 22, sem dependências: `fetch`, `AbortSignal` e `performance`.
- Ela roda no runner do GitHub e no repositório sem instalar k6 ou Artillery nem baixar binários.
- Usa as mesmas rotas e sessões que os apps: cookie de login do Portal ou do PDV, `Idempotency-Key`, `Origin`.
- Confere as invariantes no banco entre os cenários, o que as ferramentas prontas não fazem sem plugins.

O custo é ter menos recursos de geração de carga: a concorrência é por usuário virtual com `await`, sem taxa fixa de chegada. Para o volume pedido (50 consumidores, 15 vendedores e soak moderado), isso basta.

## Proteções

- **Alvos:** só os Workers de staging (`germinatura-*-staging.germinatura.workers.dev`), por HTTPS e sem caminho; qualquer outro host aborta antes da primeira requisição (`lib/guard.mjs`).
- **Banco:** o projeto Supabase precisa coincidir com a URL de staging informada. Se o ref de produção for informado, a execução recusa quando ele é igual.
- **Workflow:** roda só pelo job `load` do workflow `Deploy Staging`, disparado manualmente na `develop` com `load_scenarios`.
  - O ambiente `staging` só aceita a `develop`.
  - Nesse disparo o deploy é pulado.
  - A credencial de gestão do Supabase fica no ambiente do job e nunca é impressa.
  - Um push na `develop` durante a rodada cancela a carga, porque o deploy tem prioridade no grupo de concorrência.
- **Dados:** cada rodada cria os próprios dados (`fixtures.sql`): administrador, vendedores e consumidores `load.<run>.*`, categoria e produtos "Carga <run>", rifa e cupom.
  - A rodada não depende de dados humanos e não envia e-mail, porque as contas já nascem confirmadas.
  - Não chama o PicPay: a confirmação usada é a manual pela Área Pix.
  - No fim, `loadtest.retire` despublica os produtos, desativa as contas e cancela a rifa. O histórico continua, porque os ledgers são imutáveis.

## Cenários

| | Carga | O que exercita |
| --- | --- | --- |
| A | 50 consumidores, 10 min | Início e vitrine, catálogo com paginação, cotação com promoção, eventos, rifas, notificações |
| B | 15 vendedores, 10 min | PDV pelo service binding: catálogo, estoque próprio, transferências, histórico, retiradas, rifas, turno, maquininhas |
| C | Concorrência controlada | 20 clientes pela última unidade; venda × transferência; reserva × venda; 20 clientes pelos mesmos números de rifa; replay de checkout; duas confirmações simultâneas; cupom no limite global |
| D | 20 leitores + 5 vendedores, 30 min | Leituras contínuas, vendas reais com Área Pix e ciclos de reserva e cancelamento, com amostra da outbox por minuto |

Em cada rota a execução registra:
- requisições, sucessos, 4xx esperados (a disputa perdida em C), 4xx inesperados, 5xx e falhas de rede;
- p50, p95 e p99, throughput e duração;
- série por minuto, de onde sai a tendência do p95 no soak.

Em C, cada caso registra quem venceu e as invariantes logo depois:
- estoque nunca negativo;
- unidade disputada sem consumo duplo;
- número de rifa com um dono;
- venda com um pagamento;
- ledger sem lançamento duplicado;
- idempotência;
- cupom dentro do limite;
- outbox sem processamento preso.

## Como rodar

```bash
gh workflow run deploy-staging.yml --ref develop -f load_scenarios=A,B,C,D -f load_minutes=10,10,30
```

`load_minutes` traz as durações de A, B e D. Para um ensaio curto, use `-f load_minutes=1,1,2`. O resumo do job traz o JSON completo da rodada.

`load_rate_d` fixa a taxa total do D em requisições por segundo, por exemplo `-f load_scenarios=D -f load_minutes=10,10,30 -f load_rate_d=8`.
- Cada usuário passa a iniciar um ciclo a cada período fixo (±20%), em vez de pensar depois de cada ciclo, e a taxa não sobe nem cai com a latência.
- Os períodos mantêm a mistura do D sem taxa:
  - mesmos 20 leitores e 5 vendedores;
  - uma reserva com cancelamento a cada 6 ciclos de leitura;
  - o período de um vendedor é 4 vezes o de um leitor.
- O resultado traz `throughput`, com a taxa pedida, a taxa real e os períodos.
- Sem `load_rate_d`, o D roda como antes.

`-f load_scenarios=PREFLIGHT` (nome que não é cenário) roda só a preparação e o preflight, sem carga:
- login de um consumidor da execução pelo Supabase Auth e pelo Portal;
- login do administrador da execução, que abre as telas e APIs do financeiro.

A senha dessas contas é gerada no próprio job e nunca é impressa. As contas da execução são retiradas no fim, mesmo quando o preflight falha. O resumo do tail do Worker de jobs traz `jobsCycles`, com os ciclos concluídos e falhos.

Durante a rodada, o job captura o `wrangler tail` do Portal, do PDV e do Worker de jobs, e `summarize-tail.mjs` resume cada um:
- resultado por caminho ou cron;
- limites da plataforma (`exceededCpu`, `exceededMemory`, subrequisições);
- exceções mais frequentes;
- tempos de resolução de sessão que os apps registram com `AUTH_TIMING_LOG=1` (só em staging), e quantas resoluções cada requisição fez.

O resumo dos tails e o JSON da rodada saem também no log do job.
