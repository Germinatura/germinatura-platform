/** Public, session-free shell. No framework chunks or authenticated HTML are cached. */
export function GET() {
  return new Response(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#070B18"><title>Consulta offline · Germinatura</title><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/offline.css"><script src="/offline.js" defer></script></head>
<body><header><img src="/offline/brand.svg" width="48" height="48" alt="Germinatura"><span>PDV · Consulta offline</span></header>
<main><h1>Catálogo salvo</h1><p>Somente consulta. Esta tela não mantém uma sessão autenticada e não permite vender, reservar ou confirmar pagamentos.</p>
<aside><strong>Preços sujeitos à atualização</strong><p>A cópia é válida por até 24 horas. Estoque, promoções e preço final precisam ser consultados online.</p></aside>
<p id="status" role="status">Carregando a cópia pública do catálogo…</p>
<label for="search">Buscar na cópia salva</label><input id="search" type="search" maxlength="160" placeholder="Nome do produto" disabled>
<section id="catalog" aria-label="Produtos salvos"></section>
<nav aria-label="Consulta offline"><a href="/">Voltar ao PDV online</a><button id="clear" type="button">Apagar catálogo salvo</button></nav>
<p id="feedback" role="status"></p><noscript>Ative o JavaScript para consultar a cópia salva. As operações continuam exigindo conexão.</noscript></main></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
