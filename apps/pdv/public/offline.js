/* global caches, document, Intl, setInterval, URL */
// ADR 0011: the copy belongs to the cohort the PDV operates in (the germinatura_pdv_cohort cookie). Without a concrete
// cohort nothing is opened; another cohort's copy, or the default cohort's, is never shown in its place.
const cachePrefix = "germinatura-pdv-catalog-v2:";
const snapshotPath = "/offline/catalog-snapshot";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cohortNode = document.getElementById("cohort");
const statusNode = document.getElementById("status");
const search = document.getElementById("search");
const catalog = document.getElementById("catalog");
let products = [];
let savedAt = 0;
let emptyMessage = "Nenhuma cópia válida disponível. Conecte-se e abra o PDV para atualizar o catálogo.";

function currentCohort() {
  const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("germinatura_pdv_cohort="));
  let value = "";
  try { value = entry ? decodeURIComponent(entry.slice("germinatura_pdv_cohort=".length)).trim().toLowerCase() : ""; } catch { value = ""; }
  return uuid.test(value) ? value : null;
}

function render() {
  catalog.replaceChildren();
  if (!savedAt || Date.now() - savedAt > 86400000 || savedAt > Date.now()) {
    products = [];
    search.disabled = true;
    statusNode.textContent = emptyMessage;
    return;
  }
  const visible = products.filter((p) => p.name.toLocaleLowerCase("pt-BR").includes(search.value.toLocaleLowerCase("pt-BR")));
  for (const product of visible) {
    const card = document.createElement("article");
    const title = document.createElement("h2");
    title.textContent = product.name;
    if (product.imageUrl) {
      const image = document.createElement("img");
      image.src = product.imageUrl;
      image.alt = product.imageAlt;
      image.loading = "lazy";
      card.append(image);
    }
    const price = document.createElement("p");
    price.className = "money";
    price.textContent = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(product.amountCents / 100);
    card.append(title, price);
    catalog.append(card);
  }
  if (!visible.length) catalog.textContent = "Nenhum produto encontrado nesta cópia.";
}

async function load() {
  const cohort = currentCohort();
  if (!cohort) {
    emptyMessage = "Nenhuma turma selecionada neste dispositivo. Conecte-se e abra o PDV na turma desejada para salvar o catálogo dela.";
    savedAt = 0;
    render();
    return;
  }
  try {
    // A cohort without its own copy has no copy: nothing is created, and nothing else is opened.
    if (!(await caches.has(cachePrefix + cohort))) throw new Error("No snapshot for this cohort");
    const cache = await caches.open(cachePrefix + cohort);
    const response = await cache.match(snapshotPath);
    const data = response ? await response.json() : null;
    if (!data || data.cohortId !== cohort || typeof data.cohortName !== "string" || data.cohortName.length > 80 || !Number.isSafeInteger(data.savedAt) || !Array.isArray(data.products) || data.products.length > 50
      || data.products.some((p) => typeof p.name !== "string" || p.name.length > 160 || !Number.isSafeInteger(p.amountCents) || p.amountCents < 0
        || (p.imageUrl !== undefined && (typeof p.imageUrl !== "string" || !/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(p.imageUrl)))
        || (p.imageAlt !== undefined && (typeof p.imageAlt !== "string" || p.imageAlt.length < 1 || p.imageAlt.length > 180)))) throw new Error("Invalid snapshot");
    // Images come from this cohort's own cache only, never from another cohort's copy or the network.
    products = await Promise.all(data.products.map(async (p) => {
      if (!p.imageUrl) return p;
      const image = await cache.match(p.imageUrl);
      return image ? { ...p, imageUrl: URL.createObjectURL(await image.blob()) } : { name: p.name, amountCents: p.amountCents };
    }));
    savedAt = data.savedAt;
    cohortNode.textContent = `Turma: ${data.cohortName}`;
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
    for (const key of await caches.keys()) if (key.startsWith(cachePrefix)) await caches.delete(key);
    savedAt = 0;
    cohortNode.textContent = "";
    render();
    document.getElementById("feedback").textContent = "Catálogos salvos apagados deste dispositivo.";
  } catch {
    document.getElementById("feedback").textContent = "Não foi possível apagar a cópia. Remova os dados deste site nas configurações do navegador.";
  }
});
void load();
