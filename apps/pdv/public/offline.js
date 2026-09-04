/* global caches, document, Intl, setInterval */
const cacheName = "germinatura-pdv-catalog-v1";
const snapshotPath = "/offline/catalog-snapshot";
const statusNode = document.getElementById("status");
const search = document.getElementById("search");
const catalog = document.getElementById("catalog");
let products = [];
let savedAt = 0;

function render() {
  catalog.replaceChildren();
  if (!savedAt || Date.now() - savedAt > 86400000 || savedAt > Date.now()) {
    products = [];
    search.disabled = true;
    statusNode.textContent = "Nenhuma cópia válida disponível. Conecte-se e abra o PDV para atualizar o catálogo.";
    return;
  }
  const visible = products.filter((p) => p.name.toLocaleLowerCase("pt-BR").includes(search.value.toLocaleLowerCase("pt-BR")));
  for (const product of visible) {
    const card = document.createElement("article");
    const title = document.createElement("h2");
    title.textContent = product.name;
    const price = document.createElement("p");
    price.className = "money";
    price.textContent = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.amountCents / 100);
    card.append(title, price);
    catalog.append(card);
  }
  if (!visible.length) catalog.textContent = "Nenhum produto encontrado nesta cópia.";
}

async function load() {
  try {
    const response = await (await caches.open(cacheName)).match(snapshotPath);
    const data = response ? await response.json() : null;
    if (!data || !Number.isSafeInteger(data.savedAt) || !Array.isArray(data.products) || data.products.length > 50
      || data.products.some((p) => typeof p.name !== "string" || p.name.length > 160 || !Number.isSafeInteger(p.amountCents) || p.amountCents < 0)) throw new Error("Invalid snapshot");
    products = data.products;
    savedAt = data.savedAt;
    search.disabled = false;
    statusNode.textContent = `Cópia pública de ${new Date(savedAt).toLocaleString("pt-BR")}. ${data.partial ? "Catálogo parcial: até 50 produtos consultados." : "Produtos disponíveis no momento da cópia."}`;
  } catch {
    savedAt = 0;
  }
  render();
}
search.addEventListener("input", render);
document.addEventListener("visibilitychange", render);
// Also expire a copy left open in the foreground; never imply indefinite freshness.
setInterval(render, 60000);
document.getElementById("clear").addEventListener("click", async () => {
  try {
    await caches.delete(cacheName);
    savedAt = 0;
    render();
    document.getElementById("feedback").textContent = "Catálogo salvo apagado deste dispositivo.";
  } catch {
    document.getElementById("feedback").textContent = "Não foi possível apagar a cópia. Remova os dados deste site nas configurações do navegador.";
  }
});
void load();
