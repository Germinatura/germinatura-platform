# ADR 0004 — Ledgers, idempotência e Transactional Outbox

- Status: ACCEPTED
- Data: 2026-08-25

## Contexto e problema

Estoque e dinheiro exigem histórico, concorrência e reexecução segura. Editar saldos ou publicar eventos fora da transação permite perdas, duplicações e divergências.

## Alternativas consideradas

Saldo editável; event sourcing integral; filas sem outbox; ledger com saldo materializado, chaves idempotentes e outbox.

## Decisão e justificativa

Movimentos de estoque e lançamentos financeiros são imutáveis e corrigidos por reversão. Saldos podem ser materializados transacionalmente. Operações repetíveis usam chave idempotente. A transação crítica grava estado e `outbox_event`; tarefas secundárias rodam após commit.

## Consequências positivas

Auditoria, reprocessamento seguro, concorrência controlada e falhas assíncronas isoladas.

## Consequências negativas

Schema, workers, retenção e monitoramento mais complexos.

## Riscos

Outbox sem consumidor/alerta, chave com escopo errado ou reversão que perde vínculo com origem.

## Revisitar quando

Volume/retensão exigir particionamento ou mensageria externa; invariantes e atomicidade devem permanecer.
