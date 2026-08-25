# ADR 0003 — Supabase/PostgreSQL e autoridade do servidor

- Status: ACCEPTED
- Data: 2026-08-25

## Contexto e problema

Preço, estoque, permissão e estado financeiro não podem depender de dados enviados ou escondidos pelo frontend. A fundação já usa Supabase Auth, PostgreSQL e RLS.

## Alternativas consideradas

Backend próprio paralelo; regras no cliente; Data API sem casos de uso; Supabase com RLS e RPC/handlers server-only.

## Decisão e justificativa

Supabase/PostgreSQL é a plataforma alvo. Leituras simples podem usar Data API com RLS; mutações críticas usam RPC/transações ou funções/handlers server-only. O servidor/banco recalcula preço, valida permissão, bloqueia saldo e controla estado.

## Consequências positivas

Uma fonte de verdade, defesa em profundidade e atomicidade próxima dos dados.

## Consequências negativas

Mais SQL testável e disciplina de migrations; dependência operacional do Supabase.

## Riscos

RLS incompleta, uso indevido de service role ou regras duplicadas no cliente.

## Revisitar quando

Limites técnicos/operacionais comprovados exigirem outro backend, preservando autoridade server-side e contratos.
