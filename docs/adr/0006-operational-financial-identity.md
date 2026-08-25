# ADR 0006 — Separação entre identidade operacional e financeira

- Status: ACCEPTED
- Data: 2026-08-25

## Contexto e problema

Vendedores precisam de autoria operacional sem receber credenciais financeiras do CNPJ ou contornar KYC, idade e limites do aplicativo PicPay.

## Alternativas consideradas

Uma conta PicPay por vendedor; compartilhar credenciais; operador interno separado da conta financeira.

## Decisão e justificativa

`seller_id`, papéis e permissões pertencem à Germinatura. Conta PicPay Empresas, KYC, terminais e credenciais pertencem ao CNPJ e representante legal autorizado. Registros correlacionam operador, localização, canal e terminal permitido sem distribuir segredos.

## Consequências positivas

Auditoria por vendedor, menor privilégio e conformidade com regras do provedor.

## Consequências negativas

Exige processo operacional/fechamento e mapeamento de terminal.

## Riscos

Compartilhamento informal de credenciais ou atribuição incorreta de operação.

## Revisitar quando

O provedor oferecer oficialmente usuários/subcontas operacionais com controles compatíveis; a separação conceitual deve continuar.
