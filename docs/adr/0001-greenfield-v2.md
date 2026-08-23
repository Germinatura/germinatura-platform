# ADR 0001 — Germinatura v2.1 greenfield

- Status: `ACCEPTED`
- Data: 2026-08-23

## Contexto

O projeto possuía um sistema baseado em Prisma e PostgreSQL e iniciou uma transição para Supabase. Manter os dois modelos exigiria ponte de identidades, infraestrutura duplicada e regras de migração para domínios cujo desenho transacional também está sendo refeito.

## Decisão

A Germinatura v2.1 será greenfield. O Supabase será a única persistência e o Supabase Auth será a única infraestrutura de identidade. Portal e PDV continuarão como aplicações separadas. Nenhum dado, senha ou identificador operacional do sistema legado será importado.

Não haverá dual-write, backfill, restauração de dump, ensaio de migração, janela de corte de banco ou rollback para o sistema legado. Prisma, o pacote de banco legado e a integração antiga de pagamentos não pertencem à arquitetura-alvo.

## Consequências positivas

- arquitetura menor;
- apenas uma fonte de verdade;
- nenhuma dualidade Prisma/Supabase;
- migrations limpas;
- modelo monetário correto desde o início;
- ledger correto desde o início;
- Auth único;
- menor risco de migração.

## Consequências

- o histórico antigo não estará disponível na v2.1;
- cadastros operacionais serão refeitos;
- o estoque inicial precisará ser contado e registrado como `SALDO_INICIAL` no novo ledger;
- as contas de usuários serão criadas novamente;
- os domínios antigos permanecerão indisponíveis até suas implementações v2 estarem completas.

## Relação com documentos anteriores

A especificação funcional/técnica v2.1 continua sendo a fonte funcional principal. Qualquer trecho dela ou de documentos anteriores que pressuponha migração, cutover ou convivência com o legado é superado por este ADR. Documentos antigos permanecem no repositório apenas como registro histórico.
