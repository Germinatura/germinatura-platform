# ADR 0008 — Open Finance somente para conciliação futura

- Status: ACCEPTED
- Data: 2026-08-25

## Contexto e problema

Movimentação bancária não prova qual venda foi autorizada nem substitui confirmação do provedor/método manual controlado.

## Alternativas consideradas

Usar Open Finance para concluir venda; não usar; adotar futuramente apenas como fonte auxiliar de conciliação.

## Decisão e justificativa

Open Finance não autoriza nem conclui vendas. Se adotado, serve somente para conciliar tesouraria após consentimento, segurança e caso econômico aprovados. Webhook/consulta oficial ou confirmação manual autorizada continua sendo a origem da conclusão.

## Consequências positivas

Evita falso positivo financeiro e preserva rastreabilidade.

## Consequências negativas

Não elimina confirmação operacional em tempo real.

## Riscos

Matching heurístico ser interpretado como autorização ou uso sem consentimento adequado.

## Revisitar quando

Normas/capacidades oficiais criarem um mecanismo de iniciação/confirmação aplicável; exige novo ADR e revisão de segurança.
