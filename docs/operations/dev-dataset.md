# Dataset rico de desenvolvimento

Gera no Supabase **local** um cenário sintético de 90 dias para inspecionar paginação, gráficos, filtros e estados visuais. Nunca roda fora do desenvolvimento local e não usa dados pessoais reais.

```bash
pnpm dev:seed:rich:reset   # recria o banco local (supabase db reset) e gera o dataset
pnpm dev:seed:rich         # gera sobre o banco local atual, que precisa estar recém-resetado
```

Um teste rápido usa menos dias, por exemplo `node tools/dev-seed/rich-seed.mjs --reset --days=8`. A geração completa leva cerca de 2 minutos.

## Proteções (falha fechada)

- O comando não aceita string de conexão. O SQL só chega ao banco por `docker exec` no contêiner local `supabase_db_<project_id>`.
- Ele recusa rodar quando:
  - `NODE_ENV=production`;
  - existe `CI`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` ou `SUPABASE_DB_PASSWORD`;
  - `supabase status` aponta para fora de `127.0.0.1`/`localhost`;
  - o contêiner local não está rodando;
  - o banco não tem as fixtures de `supabase/seed.sql`, que nenhum ambiente real tem;
  - o dataset já foi gerado nesse banco.
- Não envia e-mail, não chama o PicPay e não mexe nas flags: `payment_link` continua desligada.

## Como os dados são feitos

- **Contas:** são sintéticas, criadas como as fixtures de `supabase/seed.sql`.
  - O endereço é `seed.<papel><nn>@institutojef.org.br` e a senha local é `SeedLocal123!`.
  - Os papéis são dados por `set_user_access`, que também provisiona o local de cada vendedor.
- **Operações de negócio:** passam pelas mesmas RPCs do produto, executadas como o usuário certo. Assim, ledgers, locks, idempotência, auditoria e outbox seguem as regras reais:
  - catálogo e preços; compras, recebimentos com lote e contas a pagar;
  - distribuição; vendas e pagamentos; estornos; turnos e fechamentos;
  - perdas; inventário; reservas; rifas; eventos; divulgação; avisos; lançamentos.
- **Recusas do domínio:** quando o domínio recusa uma operação (por exemplo, falta de estoque do vendedor), ela é pulada e registrada em `devseed.log`. Nada é forçado.
- **Outbox:** é processada pelas mesmas funções do worker, então as notificações existem de fato.
- **Calendário:** o cenário roda em tempo real, em 90 dias × 4 janelas (9h, 12h, 15h e 18h, horário de Brasília).
  - No fim, cada horário gravado é movido para o dia e a janela simulados.
  - A ordem dos eventos se mantém, prazos futuros acompanham o próprio registro e datas de negócio andam os mesmos dias.
  - Só esse deslocamento de tempo passa por cima dos gatilhos de imutabilidade. Saldos, valores e vínculos não mudam.
- **Gerador:** é determinístico (PRNG com semente fixa). Os fins de semana seguem o calendário real a partir da data em que roda.
- **Imagens:** são placeholders PNG gerados localmente, enviados ao Storage local e registrados por `add_catalog_product_image`.

## Conteúdo

| Área | Volume aproximado |
| --- | --- |
| Catálogo | 14 categorias e 155 produtos: rascunhos, inativos, publicados sem estoque, com e sem imagem e sem venda no PDV; dois reajustes de preço |
| Promoções | Uma de cada tipo: quantidade por preço, percentual, preço fixo, leve-pague, escalonada, combo e cupom com limite global |
| Compras | 15 fornecedores; pedidos recebidos, parciais e cancelados; lotes; contas a pagar quitadas e parciais |
| Pessoas | 20 vendedores, 60 consumidores, financeiro, estoque e comunicação |
| Vendas | Cerca de 1.200 confirmadas em 89 dias: crédito, débito, Área Pix e dinheiro, com estornos e cupom |
| Caixa | Cerca de 470 turnos com e sem diferença; cerca de 140 fechamentos semanais |
| Estoque | Distribuições semanais, perdas aprovadas e recusadas, inventário central mensal |
| Reservas | Concluídas, canceladas, expiradas, prontas e ativas |
| Rifas | Sorteada, encerrada, ativa, pausada e cancelada |
| Comunicação | Eventos passados, futuros, cancelado e rascunho; 5 campanhas e 10 links de vendedor com visitas e atribuições; avisos |
| Financeiro | Despesas, receitas, transferências para o Cofrinho e um estorno de lançamento |

No fim, o comando confere as invariantes e sai com erro se alguma falhar:
- estoque nunca negativo;
- venda confirmada com exatamente um pagamento;
- número de rifa com um só dono;
- dinheiro sem recebimento duplicado;
- no máximo um turno aberto por vendedor;
- outbox processada;
- reserva encerrada sem estoque preso.
