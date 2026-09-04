# PDV — consulta offline e homologação do PWA

Requisitos: PWA-001 e ADR 0007. Incremento de 04/09/2026, somente staging até promoção autorizada.

## Limites e privacidade

- Visitar o PDV online prepara cinco recursos públicos: `/offline`, CSS, JS, SVG oficial e manifest. O service worker só substitui navegações quando a rede falha; respostas HTTP de erro/autorização não viram acesso offline autenticado.
- A atualização consulta o endpoint público com `credentials: omit`, sem token. Guarda somente nome e preço base em centavos dos produtos vendáveis no PDV da primeira página (até 50), data local e indicador de página parcial.
- Preço final, promoções e saldo exigem consulta online. Validade de 24 horas é uma regra de apresentação da cópia, não um mecanismo de autorização.
- Nenhuma API, sessão, saldo, carrinho, comprovante ou mutação entra no CacheStorage. Não existe Background Sync, retry de venda ou fila local. Autenticação online existente permanece intacta.
- Falha ao preparar o cache não bloqueia venda online; sem cópia válida o shell explica como atualizar. Navegadores sem suporte não têm garantia de recarga offline.
- Catálogo público pode permanecer após logout, sem identificar quem usou o dispositivo. “Apagar catálogo salvo” remove a cópia; uma nova visita online pode prepará-la novamente.

## Homologação sem pagamento real

1. Abrir o PDV em staging online; permitir a preparação inicial do service worker. Instalar pelo menu do navegador quando disponível. Registrar navegador/SO e resultado, sem dados pessoais.
2. Desconectar a rede e recarregar. Conferir marca oficial, “Consulta offline”, data, busca, reais e aviso de preço/estoque. Catálogo vazio em staging é válido; não popular dados reais para testar.
3. Confirmar ausência de vender, reservar, confirmar recebimento ou fechar caixa. No PDV já aberto antes da queda, os controles críticos devem continuar bloqueados pelo estado offline existente.
4. Verificar mobile 390×844, tablet/desktop e foco por teclado. Ações e final da página devem estar acessíveis sem corte horizontal.
5. Apagar a cópia e recarregar offline: somente estado de cópia indisponível. O teste automatizado também cobre expiração após 24h.
6. Reconectar e voltar ao PDV: servidor deve validar sessão/ativação novamente; usuário deslogado vai ao login. Nada deve ser enviado automaticamente ao backend financeiro.
7. Homologar instalação, abertura standalone, atualização e remoção nos dispositivos reais antes de declarar o PWA integralmente homologado. Manifest SVG não é garantia de instalação em todo navegador.

## Atualização e reversão

Ao alterar o shell/cache, versionar os nomes `germinatura-pdv-shell-*` e, se o formato mudar, `germinatura-pdv-catalog-*` em conjunto com leitor e testes. A ativação limpa somente caches antigos com prefixo Germinatura PDV, nunca caches de outros produtos.

Uma reversão de Git sozinha não remove service workers já instalados. Em incidente, publicar pela governança normal um `/sw.js` de desativação que limpe somente esses caches e execute `registration.unregister()`; manter a URL até clientes online receberem a atualização. Alternativa controlada no dispositivo: remover dados deste site/service worker nas configurações do navegador. Isso não altera vendas, estoque nem ledgers no servidor.

Testes: `pnpm test:unit` (fronteira do worker) e `pnpm test:e2e e2e/offline.spec.ts --project=chromium` (recarga, projeção pública, busca, expiração, limpeza, POST offline e retorno ao login). O roteiro humano complementa, não substitui os gates completos.
