# Design system Germinatura

Status: aprovado para implementação em 01/09/2026.

## Objetivo

O design system sustenta o Portal e o PDV com uma linguagem única, institucional e acessível. O Portal é predominantemente claro e confortável; o PDV é predominantemente escuro, direto e operacional. A referência visual de maturidade é a Plataforma Odette do Instituto J&F, sem copiar sua marca, textos, identidade ou arquitetura funcional.

Este documento é normativo para novas interfaces. Regras de domínio, permissões, transações e feature flags continuam definidas pelo PRD, ADRs, contratos e banco.

## Princípios

1. Clareza antes de decoração: usar espaço, tipografia e agrupamento para comunicar hierarquia.
2. Uma linguagem, dois contextos: componentes e estados são compartilhados; Portal e PDV adaptam superfícies e densidade.
3. Semântica antes de cor: utilizar tokens de marca, operação e status, nunca cores Tailwind arbitrárias.
4. Permissão é autoridade: esconder ou desabilitar uma ação não substitui autorização server-side ou RLS.
5. Estado honesto: não sugerir pagamento automático quando a confirmação é manual.
6. Acessibilidade por padrão: foco visível, contraste WCAG, labels persistentes, teclado e alvos mínimos de 44px.
7. Interface sem metadados técnicos: versões, sprint, build, MVP e termos como “fundação” pertencem à documentação e observabilidade.
8. Assets de marca são únicos: Portal e PDV reutilizam o `BrandMark` compartilhado de `packages/ui`; não redesenhar, duplicar ou substituir a marca por ícone genérico dentro dos apps.

## Identidade e temas

### Marca

O `BrandMark` é a implementação canônica da geometria vetorial fornecida no pacote institucional `germinatura-svg-pack`. Sua forma não pode ser redesenhada nos apps:

- em superfícies claras, usar `tone="brand"` (padrão), com o azul original do SVG `#0E208E`;
- em superfícies escuras, usar `tone="inverse"` e uma cor de primeiro plano com contraste WCAG, normalmente branco;
- não aplicar fundo, recorte arredondado, sombra ou acento sobre o símbolo;
- manter proporção quadrada, área de respiro e tamanho legível; nunca distorcer a geometria;
- usar uma única ocorrência da marca no contexto. O nome ao lado ou abaixo pode complementar o símbolo, mas não repetir outro avatar/logotipo;
- os SVGs de módulos do pacote são ilustrações opcionais para cards e estados vazios. Ícones pequenos de navegação e ação continuam exclusivamente em Lucide.

O login do Portal, a sidebar e o PDV consomem esse mesmo componente. Imagens remotas não podem substituir a marca institucional.

- `brand.primary`: `#001EC5`
- `brand.primary-hover`: `#0018A8`
- `brand.primary-active`: `#00158F`
- `brand.primary-soft`: `#EEF1FF`
- `brand.primary-dark`: `#071A4D`
- `accent.aqua`: `#00AFA8`
- `accent.aqua-foreground`: `#087A75`
- `accent.aqua-soft`: `#DFFAF7`

O azul representa marca, navegação, foco e ações comuns como salvar, editar e continuar. O aqua é apenas um acento: indicador de item ativo ou detalhe visual discreto.

### Operação

- `operation.primary`: `#00B982`
- `operation.hover`: `#00A675`
- `operation.active`: `#008E65`
- `operation.on-primary`: `#070B18`

O verde sólido é reservado no PDV para ações operacionais de alto impacto: Cobrar, Confirmar recebimento e Finalizar venda. Usar texto escuro sobre esse fundo.

### Status

- sucesso: `#00B982`
- alerta: `#D66A00`
- perigo: `#C73737`
- informação: `#001EC5`

Status sempre combina texto, ícone e cor. Sucesso deve preferir fundo suave, texto verde escuro e ícone; não usar o mesmo tratamento sólido de um botão operacional.

### Superfícies

Portal:

- canvas `#F6F7FA`
- default/raised `#FFFFFF`
- subtle `#F1F4F8`
- selected `#EEF1FF`
- hover `#F8FAFD`

PDV:

- canvas `#070B18`
- default `#11182A`
- subtle `#0D1424`
- raised `#182137`
- selected `#17275A`
- hover `#1B263E`

Os valores canônicos vivem em `packages/ui/src/tokens.css`. Componentes não devem duplicá-los.

## Tipografia

Fonte principal: Segoe UI, com Arial e sans-serif como fallback.

| Papel | Tamanho/linha | Peso |
| --- | --- | --- |
| Display | 40/48 | 700 |
| H1 | 32/40 | 700 |
| H2 | 24/32 | 700 |
| H3 | 18/26 | 600 |
| Body | 16/24 | 400 |
| Body Small/Label | 14/20 | 400/600 |
| Caption | 12/16 | 400 |
| Money | 28/36 | 700, tabular |

Peso 800 é excepcional. Não usar texto abaixo de 12px. Valores monetários usam `font-variant-numeric: tabular-nums`, formatação `pt-BR` e alinhamento à direita em tabelas.

## Espaço, formas e elevação

- escala de espaço: 4, 8, 12, 16, 24, 32 e 48px;
- controles: raio 10px e altura mínima 44px;
- cards: raio 14px;
- pills: raio 999px;
- sombras: suaves, somente em superfícies elevadas;
- evitar gradientes decorativos, glassmorphism, sombras pesadas e cards aninhados sem necessidade.

## Estrutura do Portal

- sidebar clara: 264px expandida e 76px recolhida;
- item ativo: fundo azul suave, texto/ícone azul e indicador aqua lateral;
- topbar branca de 64px sob faixa azul de 4px;
- conteúdo central: máximo de 1280px; páginas administrativas densas podem usar 1440px;
- mobile consumidor: bottom navigation para Início, Catálogo, Reservas, Rifas e Menu;
- mobile administrativo: drawer, não uma barra inferior com excesso de módulos.

A navegação é filtrada por permissão e feature flag. Funcionalidades futuras não aparecem antecipadamente.

## Estrutura do PDV

O PDV não é o Portal em dark mode. O fluxo principal é Produto → Quantidade → Resumo → Canal → Confirmação → Comprovante.

- fundo e superfícies escuros;
- alto contraste e poucos elementos simultâneos;
- botões grandes e ação principal acessível ao polegar;
- azul para navegação e edições;
- verde operacional somente para cobrar e confirmar;
- ações críticas ficam bloqueadas offline e nunca entram em fila local;
- confirmação manual PicPay deve estar escrita explicitamente.

## Componentes

Componentes compartilhados devem residir em `packages/ui` quando não dependem de domínio ou framework. A base contém `Button`, `Card`, `Badge`, `Field` e `Input`; novas primitivas devem seguir a mesma convenção `g-*` e usar tokens.

Variantes de botão:

- `brand`: salvar, editar, continuar;
- `operation`: cobrar, confirmar recebimento, finalizar venda;
- `secondary`: ação alternativa com borda;
- `ghost`: ação discreta;
- `danger`: ação destrutiva autorizada e confirmada.

Cards reutilizáveis: KPI, Produto, Resumo, Alerta, Entidade e Ação. Não criar uma aparência nova para cada módulo.

## Estados e microcopy

Toda jornada considera: default, hover, pressed, focus, selected, disabled, loading, success, warning e error. Páginas de dados também consideram vazio, permissão insuficiente, duplicação/idempotência, sessão revogada e offline.

Mensagens explicam o que aconteceu e o que o usuário pode fazer. Exemplo: “Não foi possível concluir a venda. O estoque mudou desde que o carrinho foi montado.”

## Tabelas e formulários

Tabelas usam cabeçalho discreto, linhas com respiro, hover suave, badges textuais, filtros acima, paginação clara e nenhuma grade forte em cada célula. No mobile, dados essenciais viram cards.

Formulários usam label persistente, campo confortável, focus ring azul, erro logo abaixo e descrição auxiliar somente quando necessária. Placeholder nunca substitui label. Formulários longos são divididos por assunto.

Referências implementadas no Portal:

- Visão Geral administrativa: quatro KPIs decisórios, alertas e atividade recente, sempre derivados de dados reais e com erro explícito;
- Usuários e vendedores: filtro acima da tabela, tabela no desktop, cards no mobile e formulário complexo em sheet/dialog responsivo;
- Catálogo: resumo decisório, busca por nome/SKU/categoria e comparação de publicação, canais e preço; a ausência de comando de escrita deve ser explícita enquanto não existir RPC auditada;
- Catálogo consumidor: grid leve de `Product Card`, preço em destaque, categoria e capacidade de reserva como informação; não expor CTA de compra/reserva antes de a jornada correspondente estar funcional;
- Estoque: KPIs de físico/reservado/disponível, saldos por localização e movimentos imutáveis; tabelas viram cards no mobile sem perder produto, SKU ou localização;
- estado de acesso e papéis usam texto e badges; desativar uma conta explica a revogação imediata no Portal e no PDV;
- falha de consulta nunca deve ser apresentada como valor zero.

## Responsividade

- desktop grande: sidebar expandida, container limitado e tabela completa;
- desktop pequeno/tablet: sidebar recolhível e menos colunas;
- mobile: drawer, cards no lugar de tabelas e sheets/telas completas no lugar de dialogs complexos;
- ações críticas permanecem visíveis e alcançáveis sem cobrir conteúdo.

O comportamento deve ser testado pelo menos em 390×844, tablet e desktop.

Identidade do usuário, avatar e saída pertencem ao menu de conta da topbar. A sidebar contém somente marca, navegação e controle de recolhimento; não repetir o perfil nas duas regiões.

Ações globais já presentes na topbar não são repetidas na sidebar. Notificações usam um único sino na topbar, com acesso à central completa pelo próprio menu do sino.

Itens de jornada ainda incompleta não recebem ações aparentes. Estados vazios podem orientar para o catálogo, mas criação, conversão e pagamento só aparecem quando o próximo passo existir e estiver autorizado.

Rifas seguem a mesma regra: campanhas, números próprios e prova do sorteio podem ser consultados quando a flag estiver ligada; selecionar ou reservar números não recebe CTA enquanto o pagamento do consumidor não tiver uma continuidade funcional. Números `RESERVED` devem ser descritos como aguardando pagamento e somente `PAID` como elegíveis.

## Checklist de revisão

- usa tokens semânticos e componentes compartilhados;
- não contém label de versão, sprint, build, MVP ou “fundação”;
- não comunica status apenas por cor;
- possui label, foco visível e alvos de 44px;
- trata loading, vazio, erro, permissão e offline quando aplicável;
- não expõe funcionalidade sem flag/permissão;
- não sugere automação financeira inexistente;
- mantém valores em reais e números tabulares;
- funciona com teclado, mobile e zoom;
- não altera regra de domínio para acomodar a interface.
