# Conciliação PicPay — runbook

Spec 5.8 (FIN-001, FIN-002, FIN-003, FIN-007). Tela: Financeiro › Conciliação PicPay (`/admin/financeiro/conciliacao-picpay`). Permissão: `finance.manage`.

## Quatro visões do mesmo dinheiro

| Visão | Fonte | Responde | Identidade |
|---|---|---|---|
| Comercial | Venda do Germinatura (PDV, online, reserva, rifa) | O que foi vendido, a quem e por quanto | Venda e tentativa de pagamento |
| Adquirente | **Minhas vendas** (PicPay Empresas) | A transação no PicPay: forma, status, terminal, taxa real, previsão de pagamento | Número único da transação |
| A receber | **Recebíveis** | O que o PicPay ainda vai pagar, por parcela | Transação + número da parcela |
| Tesouraria | **Extrato** | O dinheiro que entrou e saiu da conta | Multiconjunto de linhas idênticas por dia |

A venda do Germinatura é a verdade comercial. Minhas vendas não cria receita nativa: a receita vem do ledger do PDV, e a transação vinculada só traz a taxa real. O Extrato nunca cria venda.

## Importar

A Conciliação PicPay é o único caminho suportado para importar arquivos do PicPay. A importação antiga só do Extrato (`import_picpay_statement` e `preview_picpay_statement`) foi retirada do banco em 07/10/2026. O que ela gravou continua legível na revisão das linhas do Extrato.

1. Exporte do PicPay Empresas os três arquivos CSV: Minhas vendas, Recebíveis e Extrato. Os arquivos podem ir juntos ou separados, em qualquer ordem e com períodos sobrepostos (por exemplo, uma exportação semanal que repete dias).
2. Na tela, escolha os arquivos. O tipo vem do cabeçalho; arquivo sem cabeçalho reconhecido é recusado sem gravar nada.
3. Confira a prévia de cada arquivo: período, linhas, novas, já conhecidas, atualizadas, ambíguas e erros. Nada é gravado na prévia.
4. Clique em Importar arquivos. Arquivo com qualquer linha inválida não entra. O mesmo arquivo (mesmo SHA-256) é recusado como "Arquivo já importado".
5. Depois de cada importação, o motor de conciliação roda de novo sobre tudo o que já se sabe. O resultado não depende da ordem dos arquivos.

O arquivo bruto não é guardado. Nome, documento, e-mail e telefone do comprador não são gravados. Do cartão fica só o final (4 dígitos). Os logs não recebem o conteúdo dos arquivos.

## Deduplicação por fonte

- **Minhas vendas:** uma transação por número único. Cada arquivo grava uma observação da transação, com proveniência. Uma mudança de status (Aprovada → Devolvida) vira nova observação e nunca sobrescreve a anterior. O estado vigente é Devolvida > Aprovada > Negada e, entre iguais, a importação mais recente, o que não depende da ordem.
- **Recebíveis:** uma parcela por transação + número da parcela. Cada arquivo é um snapshot do que ainda falta receber. Uma parcela que some do snapshot seguinte não foi liquidada por isso: a liquidação vem só do Extrato.
- **Extrato:** a linha não tem identificador. A identidade é a impressão digital (dia, movimento, descrição, valor). Linhas idênticas no mesmo dia são legítimas e ficam todas. Um arquivo novo acrescenta só as ocorrências que excedem as já conhecidas naquele dia. Se um arquivo traz menos ocorrências do que as conhecidas num dia estritamente dentro do seu período, nada é apagado: abre-se uma pendência de duplicidade para revisar. Toda linha de todo arquivo fica registrada como observação, com o arquivo e a linha de origem.

## Conciliação

- **PDV ↔ Minhas vendas:** primeiro a evidência mais forte (NSU ou código de autorização da maquininha), depois valor + forma + horário (até 30 minutos). O vínculo automático exige candidata única nos dois sentidos; senão vira pendência. O vínculo manual exige motivo e é desfeito só por desvínculo auditado. O número do terminal é preservado.
- **Pix:** as vendas Pix de um dia (Aprovadas e Devolvidas) são comparadas como multiconjunto de valores com as linhas Pix recebido do mesmo dia. A taxa Pix do PicPay é zero. Pix estornado concilia com a devolução de mesmo dia e valor.
- **Maquininha e Tap:** são conciliados só pelas evidências do PicPay (Minhas vendas, Recebíveis e Extrato). A conciliação manual (`POST /api/v1/payments/:id/reconciliations`, função `reconcile_payment_attempt`) recusa esses canais com `PAYMENT_RECONCILIATION_PICPAY_ONLY`, também em chamada direta ao banco, para que o mesmo dinheiro nunca entre duas vezes. Área Pix e pagamentos online seguem aceitos. Conciliações antigas continuam como foram registradas.
- **Cartão:** o PicPay liquida em lote. Por dia de pagamento, compara-se o líquido esperado em Minhas vendas com as linhas Recebíveis de venda do Extrato: Liquidado, Parcial, Excedente, Em atraso ou A receber. O vínculo é pelo dia, nunca inventado por venda (1:N, N:1 e lote).
- **Taxas:** a taxa real de cada transação vem de Minhas vendas. Invariante verificada em cada linha: bruto − tarifa − custo fixo − taxa de parcelamento − cancelado = líquido.
- **Devolvida:** transação devolvida tem líquido zero e cancelado igual ao bruto. Sem estorno correspondente no PDV, vira pendência.
- **Cofrinho:** guardar e resgatar são transferências internas, neutras para receita, resultado e saldo financeiro total.

## Saldos

- Saldo livre = conta `PICPAY_EMPRESAS`; Cofrinho = `COFRINHO_PICPAY`; saldo financeiro total = livre + Cofrinho.
- Recebíveis (`RECEBIVEIS_PICPAY`), Pix em trânsito (`PENDENTE_LIQUIDACAO`) e dinheiro físico ficam à parte e nunca entram no saldo financeiro total.
- A única autoridade é `private.finance_account_balances`.

## Tesouraria e classificação (07/10/2026)

São duas perguntas diferentes:

- **Tesouraria:** o dinheiro entrou ou saiu da conta? Quem responde é o Extrato.
- **Classificação contábil:** por quê? Responde a categoria, que alimenta receita, despesa, resultado e indicadores.

Regras:

- **Cada linha conta uma vez.** Uma ocorrência canônica do Extrato move o saldo livre (`PICPAY_EMPRESAS`) exatamente uma vez, desde a importação, mesmo antes de ser classificada. No extrato consolidado, a linha aparece com origem "Extrato PicPay (a classificar)" e natureza "A classificar". Ela conta no saldo e no fluxo de caixa, nunca em receita, despesa ou resultado.
- **Classificar não muda o saldo.** A linha passa a ter categoria com o mesmo valor; só receitas, despesas, resultado e indicadores mudam.
- **Sem dupla contagem.** Quando o dinheiro já está em outro registro (vinculada a um pagamento de fornecedor ou lançamento manual, marcada como já registrada, conciliada com venda ou estorno), a linha não conta de novo. Enquanto não for vinculada, uma linha que repete um registro interno já lançado na conta PicPay aparece duas vezes no saldo e na conferência. A revisão (vincular) desfaz essa duplicidade.
- **Movimentos internos.** Transferências internas (Cofrinho, liquidação de recebíveis) continuam neutras no saldo financeiro total e nunca viram receita.
- **Caso real de 07/10/2026.** O saldo livre calculado ficava R$ 12.389,07 acima do banco. Eram exatamente 30 Pix enviados (−R$ 12.609,07) e 2 Pix devolvidos (+R$ 220,00) ainda a revisar, que pela regra antiga só entravam no saldo depois de classificados. Com a regra nova eles já estão no saldo; a classificação muda só os indicadores.

## Cutover

- Abertura em 27/08/2026 (livre R$ 0,00, Cofrinho R$ 111,78, recebíveis e dinheiro físico zero). Histórico até 06/10/2026 inclusive. Operação nativa a partir de 07/10/2026 (`operating_since`).
- Datas confirmadas pela auditoria read-only da produção em 06/10/2026, feita pelo responsável: nenhuma venda, tentativa de pagamento aprovada ou conciliada, lançamento de ledger, pagamento a fornecedor, lançamento manual, conciliação, movimento de caixa, importação de Extrato, posição de abertura ou conferência de saldo.
- A fronteira vem só da versão vigente da posição de abertura. O importador não tem data fixa.
- **Antes de `operating_since`:** a transação de Minhas vendas sem venda no PDV carrega a receita histórica (`RECEITA_HISTORICA`).
  - **Cartão:** o bruto vai para Recebíveis e a taxa para Taxas.
  - **Pix:** o bruto vai para Pix em trânsito.
  - **Devolvida:** o cancelado sai como Reembolso.
  - **Extrato:** a linha Pix recebido histórica é conciliada (`CONCILIADA_PICPAY`) como transferência de Pix em trânsito para o saldo livre. A linha Recebíveis de venda histórica é transferência de Recebíveis para o saldo livre quando o dia não excede o líquido esperado.
- **A partir de `operating_since`:** a receita vem só do PDV, e a transação vinculada acrescenta a taxa.
- **Evidência oficial do cutover:** os três arquivos exportados com dados até 06/10/2026. Um extrato sozinho não basta para o histórico, porque não traz taxas, status nem previsão de pagamento. O aceite são os saldos reais do PicPay no fim de 06/10/2026, com diferença zero e sem ajuste artificial.
- **A importação real** só acontece em produção, depois da promoção autorizada, por decisão do financeiro e nunca por automação. Antes dela, registre a posição de abertura.

## Pendências e fechamento

- **Tipos de pendência:**
  - venda do PDV sem transação PicPay; transação PicPay sem venda no PDV;
  - valor divergente; forma divergente; status divergente entre arquivos;
  - transação devolvida sem estorno;
  - liquidação sem explicação; recebível em atraso ou inconsistente;
  - duplicidade a revisar; linha do Extrato não classificada;
  - receita contada duas vezes; liquidação em dobro; saldo divergente.
- **Linha do Extrato não classificada:** não se "resolve" a pendência; trata-se a linha.
  - O botão "Revisar linha" abre a linha nas Linhas do Extrato, para classificar, vincular, marcar como já registrada ou classificar em lote.
  - `resolve_picpay_exception` recusa esse tipo (`PICPAY_EXCEPTION_REQUIRES_LINE_REVIEW`).
  - Decisões manuais gravadas antes dessa regra continuam em `picpay_exception_resolutions` e na auditoria, mas não escondem mais a linha.
- **Demais pendências:** resolver ou reabrir exige motivo de pelo menos 8 caracteres, escrito ao lado do campo e contado enquanto faltar. A decisão é imutável e auditada, e os arquivos não mudam.
- **Status do período:** Conciliado só quando não há pendência aberta nem linha do Extrato aguardando revisão no período. Uma linha a revisar mantém o período Com pendências.
- **Fora do período:** o resumo mostra pendências e linhas a revisar no período e no total. Se houver pendências fora do período escolhido, um aviso oferece "Ver todas", que amplia o período até cobri-las. Os atalhos de período são 7 dias, 30 dias, desde a abertura e todo o histórico importado.
- **Avaliar período:** o fechamento usa o mesmo status do resumo e não trava o período. Se uma importação posterior trouxer nova evidência para o período, ele passa para Revisar.
- **"Já registrada":** use só quando o movimento já tem efeito financeiro registrado no Germinatura e não existe registro elegível para vincular. Prefira vincular.

## Verificação local com arquivos reais

Arquivos reais só são usados localmente, fora do Git:

- cópia temporária no container;
- execução numa transação desfeita ao final;
- apagados em seguida.

Nunca vão para fixtures, staging, Supabase remoto ou produção. A CI usa apenas arquivos sintéticos (`supabase/tests/picpay_reconciliation_test.sql`, `integration/picpay-reconciliation-concurrency.test.ts`, `e2e/picpay-reconciliation.spec.ts`).

## Limites conhecidos

- Open Finance continua fora (FIN-004).
