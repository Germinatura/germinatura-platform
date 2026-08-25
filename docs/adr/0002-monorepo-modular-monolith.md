# ADR 0002 — Monorepo com monólito modular

- Status: ACCEPTED
- Data: 2026-08-25

## Contexto e problema

Portal e PDV precisam de experiências e deploys independentes, mas compartilham identidade, regras e transações. Microserviços antecipariam coordenação distribuída antes de existir escala que a justifique.

## Alternativas consideradas

Site único; repositórios separados; microserviços; monorepo com dois apps e domínio modular.

## Decisão e justificativa

Manter pnpm/Turborepo com `apps/portal`, `apps/pdv` e packages compartilhados. O backend é um monólito modular sobre um PostgreSQL; packages de domínio não dependem de Next.js. A solução reduz duplicação e preserva atomicidade.

## Consequências positivas

Contratos únicos, mudanças atômicas e CI coerente; experiências independentes sem consistência distribuída.

## Consequências negativas

Acoplamento de release e disciplina obrigatória entre módulos.

## Riscos

Packages virarem utilitários genéricos ou apps contornarem casos de uso.

## Revisitar quando

Um módulo exigir escala, isolamento regulatório ou ciclo operacional comprovadamente independente que o monólito não atenda.
