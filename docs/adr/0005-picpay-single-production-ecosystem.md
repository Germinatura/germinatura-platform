# ADR 0005 — PicPay como único ecossistema financeiro de produção

- Status: ACCEPTED
- Data: 2026-08-25

## Contexto e problema

A parceria/patrocínio orienta a centralização financeira, mas os canais PicPay têm capacidades e habilitações diferentes. Não há base para presumir API pública, SDK ou deep link que comande Maquininha/Tap remotamente.

## Alternativas consideradas

Múltiplos adquirentes; PicPay apenas para PIX; acoplamento direto do domínio à marca; interfaces neutras com PicPay como única configuração de produção.

## Decisão e justificativa

PicPay Empresas é a conta principal e único provedor/adquirente configurado em produção. Checkout/E-commerce atende automação online quando comercialmente habilitado; Área Pix pode atender o fluxo presencial definido; Maquininha é o canal principal de crédito/débito e, após credenciamento, V.A./V.R.; Tap é complementar e restrito. Outros providers não são configurados em produção.

O domínio mantém `PaymentProvider` e `CardPresentProvider`. O MVP presencial cria tentativa, exibe o valor calculado, recebe confirmação manual autorizada e concilia depois. Não chama endpoint deduzido. Se PicPay oferecer API privada, TEF, POS ou SDK oficial, um adapter novo substitui a borda sem reescrever venda, estoque ou financeiro.

## Consequências positivas

Operação/tesouraria simplificadas, alinhamento à parceria e domínio testável.

## Consequências negativas

Dependência comercial/operacional de um ecossistema e automação presencial inicialmente limitada.

## Riscos

Confundir confirmação manual com automática; habilitar voucher sem credenciamento; mocks alcançarem produção; mudanças comerciais ou de API.

## Revisitar quando

PicPay não atender requisito obrigatório, parceria mudar, risco de continuidade se materializar ou nova integração oficial alterar capacidades. A revisão exige decisão explícita, nunca fallback oculto.
