# ADR 0007 — PWA antes de aplicativo nativo

- Status: ACCEPTED
- Data: 2026-08-25

## Contexto e problema

O PDV precisa ser rápido e instalável em celulares, mas operações críticas dependem de conexão e não há SDK nativo oficial confirmado.

## Alternativas consideradas

Web responsiva; PWA; Capacitor/app nativo imediato.

## Decisão e justificativa

Evoluir o PDV como PWA mobile-first. Cache cobre shell, catálogo e imagens; vendas, transferências e ajustes ficam bloqueados offline. App nativo só entra com requisito comprovado ou integração PicPay oficial que o exija.

## Consequências positivas

Menor custo, distribuição simples e uma base web.

## Consequências negativas

Limites de plataforma e ausência de escrita crítica offline.

## Riscos

UX sugerir conclusão offline ou cache de saldo parecer atual.

## Revisitar quando

Capacidade nativa obrigatória e oficial não puder ser atendida pela PWA.
