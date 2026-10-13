import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { expectNoHorizontalOverflow } from "./support/layout";

const portal = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const portalHeaders = { Origin: portal, "Sec-Fetch-Site": "same-origin" };
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };
const category = "23f00000-0000-4000-8000-000000000001";
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const itemA = "33f00000-0000-4000-8000-000000000001"; // "Item público A", R$ 25,90
const phones = [{ width: 320, height: 640 }, { width: 360, height: 740 }, { width: 390, height: 844 }] as const;

async function signInPortal(page: Page) {
  expect((await page.request.post(`${portal}/api/auth/login`, { headers: portalHeaders, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
}

/** Gives the seller location at least one unit of item A and returns how many are available there. */
async function sellerStockOfItemA() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para preparar o estoque E2E");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const read = async () => {
    const balances = await fetch(`${url}/rest/v1/inventory_balances?select=available_quantity&location_id=eq.${sellerLocationId}&product_id=eq.${itemA}`, { headers });
    return ((await balances.json()) as Array<{ available_quantity: number }>)[0]?.available_quantity ?? 0;
  };
  const current = await read();
  if (current >= 1) return current;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers, body: JSON.stringify({
    p_location_id: sellerLocationId, p_product_id: itemA, p_quantity_delta: 1 - current,
    p_reason: "Preparar filtros do PDV E2E", p_idempotency_key: `e2e-sale-filters-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
  return read();
}

test("desktop: recolher os filtros não limpa valores e reabrir mostra os mesmos campos", async ({ page }) => {
  await signInPortal(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${portal}/admin/usuarios`);
  const main = page.getByRole("main");
  const panel = main.getByRole("group", { name: "Filtros de usuários" });
  await expect(main.getByText(/^\d+ de \d+ usuários$/)).toBeVisible();
  await panel.getByLabel("Situação").selectOption("ACTIVE");
  await panel.getByRole("group", { name: "Papéis" }).getByLabel("Vendedor").check();
  await expect(main.getByRole("button", { name: "Remover filtro Ativos" })).toBeVisible();

  await main.getByRole("button", { name: "Recolher filtros" }).click();
  await expect(panel).toBeHidden();
  const toggle = main.getByRole("button", { name: "Filtros (2)" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // The chips keep showing what is in effect while the panel is collapsed.
  await expect(main.getByRole("button", { name: "Remover filtro Qualquer: Vendedor" })).toBeVisible();

  await toggle.click();
  await expect(panel.getByLabel("Situação")).toHaveValue("ACTIVE");
  await expect(panel.getByRole("group", { name: "Papéis" }).getByLabel("Vendedor")).toBeChecked();
  await main.getByRole("button", { name: "Limpar filtros" }).click();
  await expect(main.getByRole("button", { name: "Remover filtro Ativos" })).toHaveCount(0);
  await expect(panel.getByLabel("Situação")).toHaveValue("ALL");
});

test("celular: os filtros de usuários abrem num sheet com rascunho, Limpar e Aplicar, em 320, 360 e 390 px", async ({ page }) => {
  await signInPortal(page);
  for (const viewport of phones) {
    const label = `${viewport.width}×${viewport.height}`;
    await page.setViewportSize(viewport);
    await page.goto(`${portal}/admin/usuarios`);
    const main = page.getByRole("main");
    await expect(main.getByText(/^\d+ de \d+ usuários$/), label).toBeVisible();
    // No permanent form on a phone: only the button, and the search stays outside.
    await expect(main.getByPlaceholder("Nome, usuário ou e-mail"), label).toBeVisible();
    const trigger = main.getByRole("button", { name: "Filtros", exact: true });
    await expect(trigger, label).toBeVisible();
    await expect(main.getByLabel("Situação"), label).toHaveCount(0);
    await expectNoHorizontalOverflow(page, label);

    // Closing without applying (Esc) drops the draft and returns the focus to the button.
    await trigger.click();
    const sheet = page.getByRole("dialog", { name: "Filtros de usuários" });
    await expect(sheet, label).toBeVisible();
    await sheet.getByLabel("Situação").selectOption("INACTIVE");
    await page.keyboard.press("Escape");
    await expect(sheet, label).toBeHidden();
    await expect(trigger, label).toBeFocused();
    await expect(main.getByRole("button", { name: "Remover filtro Inativos" }), label).toHaveCount(0);

    // Applying puts the draft in effect; the actions stay inside the screen.
    await trigger.click();
    await expect(sheet.getByLabel("Situação"), label).toHaveValue("ALL");
    await sheet.getByLabel("Situação").selectOption("ACTIVE");
    await sheet.getByRole("group", { name: "Papéis" }).getByLabel("Administrador").check();
    const apply = sheet.getByRole("button", { name: "Aplicar" });
    const box = await apply.boundingBox();
    expect(box && box.y + box.height <= viewport.height && box.x >= 0 && box.x + box.width <= viewport.width, `${label}: Aplicar visível`).toBe(true);
    await apply.click();
    await expect(sheet, label).toBeHidden();
    await expect(main.getByRole("button", { name: "Filtros (2)" }), label).toBeVisible();
    await expect(main.getByRole("button", { name: "Remover filtro Ativos" }), label).toBeVisible();

    // Reopening shows the filters in effect; "Limpar" + "Aplicar" removes them; the close button keeps them.
    await main.getByRole("button", { name: "Filtros (2)" }).click();
    await expect(sheet.getByLabel("Situação"), label).toHaveValue("ACTIVE");
    await sheet.getByRole("button", { name: "Fechar filtros" }).click();
    await expect(main.getByRole("button", { name: "Remover filtro Ativos" }), label).toBeVisible();
    await main.getByRole("button", { name: "Filtros (2)" }).click();
    await sheet.getByRole("button", { name: "Limpar" }).click();
    await expect(sheet.getByLabel("Situação"), label).toHaveValue("ALL");
    await sheet.getByRole("button", { name: "Aplicar" }).click();
    await expect(main.getByRole("button", { name: "Remover filtro Ativos" }), label).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Filtros", exact: true }), label).toBeVisible();
  }
});

test("catálogo admin: categoria, preço e canal combinados no servidor e guardados na URL", async ({ page }) => {
  await signInPortal(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${portal}/admin/catalogo?category=${category}&max=30&channel=PORTAL`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Item público A", exact: true })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Item público B", exact: true })).toHaveCount(0); // R$ 34,90
  await expect(main.getByRole("heading", { name: "Item não publicado", exact: true })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Remover filtro Preço até R$ 30,00" })).toBeVisible();
  await expect(main.getByText("R$ 25,90").first()).toBeVisible();

  // Raising the ceiling in the panel reaches the URL and the server.
  const panel = main.getByRole("group", { name: "Filtros do catálogo" });
  await panel.getByLabel("Preço máximo (R$)").fill("40");
  await expect(page).toHaveURL(/max=40/);
  await expect(main.getByRole("heading", { name: "Item público B", exact: true })).toBeVisible();
  await panel.getByLabel("Preço mínimo (R$)").fill("abc");
  await expect(panel.getByText("Use um valor em reais, como 15 ou 15,50.")).toBeVisible();
  await main.getByRole("button", { name: "Limpar filtros" }).click();
  await expect(page).not.toHaveURL(/max=/);
  await expect(main.getByRole("heading", { name: "Item não publicado", exact: true })).toBeVisible();

  // The same screen on a phone: the button and the sheet, with the search outside.
  await page.setViewportSize({ width: 360, height: 740 });
  await main.getByRole("button", { name: "Filtros", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Filtros do catálogo" });
  await sheet.getByLabel("Canal").selectOption("UNPUBLISHED");
  await sheet.getByRole("button", { name: "Aplicar" }).click();
  await expect(page).toHaveURL(/channel=UNPUBLISHED/);
  await expect(main.getByRole("heading", { name: "Item público A", exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "catálogo 360");
});

test("PDV: busca fora do painel e filtros de categoria, preço e disponibilidade combinados", async ({ page }) => {
  test.slow();
  const stock = await sellerStockOfItemA();
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${pdvUrl}/`);
  const catalog = page.getByRole("region", { name: "Catálogo" });
  await expect(catalog.getByRole("heading", { name: "Item público A", exact: true })).toBeVisible();
  // Collapsed by default on the PDV, so the products stay in view.
  const toggle = catalog.getByRole("button", { name: "Filtros", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const panel = catalog.getByRole("group", { name: "Filtros de produtos" });
  await panel.getByLabel("Categoria").selectOption(category);
  await panel.getByLabel("Preço máximo (R$)").fill("30");
  await panel.getByLabel("Somente disponíveis neste local").check();
  await catalog.getByPlaceholder("Buscar produto, categoria ou SKU").fill("público");
  await expect(catalog.getByRole("heading", { name: "Item público A", exact: true })).toBeVisible();
  await expect(catalog.getByRole("heading", { name: "Item público B", exact: true })).toHaveCount(0);
  await panel.getByLabel("Disponível no mínimo (un.)").fill(String(stock + 1));
  await expect(catalog.getByRole("heading", { name: "Item público A", exact: true })).toHaveCount(0);
  await expect(catalog.getByText("Nenhum produto encontrado")).toBeVisible();
  await catalog.getByRole("button", { name: `Remover filtro Disponível: ${stock + 1} ou mais` }).click();
  await expect(catalog.getByRole("heading", { name: "Item público A", exact: true })).toBeVisible();
  await catalog.getByRole("button", { name: "Recolher filtros" }).click();
  await expect(catalog.getByRole("button", { name: "Filtros (3)" })).toBeVisible();

  for (const viewport of phones) {
    const label = `PDV ${viewport.width}×${viewport.height}`;
    await page.setViewportSize(viewport);
    const trigger = catalog.getByRole("button", { name: "Filtros (3)" });
    await expect(trigger, label).toBeVisible();
    await trigger.click();
    const sheet = page.getByRole("dialog", { name: "Filtros de produtos" });
    await expect(sheet.getByLabel("Preço máximo (R$)"), label).toHaveValue("30");
    await sheet.getByLabel("Preço máximo (R$)").fill("20");
    await sheet.getByRole("button", { name: "Aplicar" }).click();
    await expect(catalog.getByRole("heading", { name: "Item público A", exact: true }), label).toHaveCount(0);
    await catalog.getByRole("button", { name: "Remover filtro Até R$ 20,00" }).click();
    await expect(catalog.getByRole("heading", { name: "Item público A", exact: true }), label).toBeVisible();
    await expectNoHorizontalOverflow(page, label);
    // Back to the three filters for the next width.
    await catalog.getByRole("button", { name: "Filtros (2)" }).click();
    await sheet.getByLabel("Preço máximo (R$)").fill("30");
    await sheet.getByRole("button", { name: "Aplicar" }).click();
  }
});

test("auditoria e segurança: o rascunho só vale ao pesquisar, com chips do que está em vigor, no desktop e no celular", async ({ page }) => {
  await signInPortal(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${portal}/admin/auditoria`);
  const main = page.getByRole("main");
  const audit = main.getByRole("form", { name: "Filtrar auditoria" });
  await expect(audit.getByRole("button", { name: "Pesquisar" })).toBeEnabled();
  // Typing does not search; "Pesquisar" does, and the chip shows what is in effect.
  await audit.getByLabel("Severidade").selectOption("HIGH");
  await expect(main.getByRole("button", { name: "Remover filtro Severidade: Alta" })).toHaveCount(0);
  await audit.getByRole("button", { name: "Pesquisar" }).click();
  await expect(main.getByRole("button", { name: "Remover filtro Severidade: Alta" })).toBeVisible();
  await main.getByRole("button", { name: "Recolher filtros" }).click();
  await expect(main.getByRole("button", { name: "Filtros (1)" })).toBeVisible();
  await main.getByRole("button", { name: "Remover filtro Severidade: Alta" }).click();
  await expect(main.getByRole("button", { name: "Filtros", exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Segurança" }).click();
  const security = main.getByRole("form", { name: "Filtrar eventos de segurança" });
  await security.getByLabel("Evento").selectOption({ label: "Login recusado" });
  await security.getByRole("button", { name: "Pesquisar" }).click();
  await expect(main.getByRole("button", { name: "Remover filtro Evento: Login recusado" })).toBeVisible();

  for (const viewport of phones) {
    const label = `auditoria ${viewport.width}×${viewport.height}`;
    await page.setViewportSize(viewport);
    await page.goto(`${portal}/admin/auditoria`);
    await expect(main.getByRole("form", { name: "Filtrar auditoria" }), label).toHaveCount(0);
    await main.getByRole("button", { name: "Filtros", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Filtrar auditoria" });
    await sheet.getByLabel("Severidade").selectOption("MEDIUM");
    await sheet.getByRole("button", { name: "Aplicar" }).click();
    await expect(main.getByRole("button", { name: "Remover filtro Severidade: Média" }), label).toBeVisible();
    await expectNoHorizontalOverflow(page, label);
  }
});

test("reservas: busca de cliente fora do painel e situação/período no painel ou no sheet", async ({ page }) => {
  await signInPortal(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${portal}/admin/reservas`);
  const main = page.getByRole("main");
  const panel = main.getByRole("group", { name: "Filtrar reservas" });
  await expect(main.getByRole("list", { name: "Reservas" }).or(main.getByText("Nenhuma reserva com estes filtros."))).toBeVisible();
  await panel.getByLabel("Situação").selectOption("ACTIVE");
  await panel.getByLabel("Criadas de").fill("2026-01-01");
  await expect(main.getByRole("button", { name: "Remover filtro Criadas: desde 01/01/2026" })).toBeVisible();
  await main.getByPlaceholder("Buscar cliente").fill("consumidor");
  await expect(main.getByRole("button", { name: "Remover filtro Cliente: consumidor" })).toBeVisible();
  await main.getByRole("button", { name: "Recolher filtros" }).click();
  // The search is not counted: it stays outside the panel.
  await expect(main.getByRole("button", { name: "Filtros (2)" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(main.getByPlaceholder("Buscar cliente")).toBeVisible();
  await main.getByRole("button", { name: "Filtros (2)" }).click();
  const sheet = page.getByRole("dialog", { name: "Filtrar reservas" });
  await sheet.getByRole("button", { name: "Limpar" }).click();
  await sheet.getByRole("button", { name: "Aplicar" }).click();
  await expect(main.getByRole("button", { name: "Filtros", exact: true })).toBeVisible();
  await expect(main.getByRole("button", { name: "Remover filtro Cliente: consumidor" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "reservas 390");
});

test("catálogo do consumidor: busca e categoria no servidor alcançam produtos além da primeira página", async ({ page }) => {
  await signInPortal(page);
  // One product per page: item B is not on the first page, yet the search finds it.
  const firstPage = await page.request.get(`${portal}/api/v1/catalog/products?limit=1`);
  const first = await firstPage.json() as { data: { sku: string }[]; nextCursor: string | null; categories?: { id: string }[] };
  expect(first.data).toHaveLength(1);
  expect(first.categories?.map((item) => item.id)).toContain(category);
  const searched = await page.request.get(`${portal}/api/v1/catalog/products?limit=1&q=PUBLIC-ITEM-B`);
  expect((await searched.json() as { data: { sku: string }[] }).data.map((item) => item.sku)).toEqual(["PUBLIC-ITEM-B"]);
  // Filter syntax in the term is neutralized, never an error or a broader query.
  const hostile = await page.request.get(`${portal}/api/v1/catalog/products?q=${encodeURIComponent("x),id.not.is.null,(name.ilike.*")}`);
  expect(hostile.status()).toBe(200);
  expect((await hostile.json() as { data: unknown[] }).data).toHaveLength(0);
  const byCategory = await page.request.get(`${portal}/api/v1/catalog/products?category=${category}&q=${encodeURIComponent("Catálogo público")}`);
  const inCategory = (await byCategory.json() as { data: { sku: string }[] }).data.map((item) => item.sku);
  expect(inCategory).toEqual(expect.arrayContaining(["PUBLIC-ITEM-A", "PUBLIC-ITEM-B"]));
  const paged = await page.request.get(`${portal}/api/v1/catalog/products?limit=1&cursor=${first.nextCursor}`);
  expect((await paged.json() as { categories?: unknown }).categories).toBeUndefined();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${portal}/catalogo`);
  const main = page.getByRole("main");
  await main.getByPlaceholder("Buscar por produto, SKU ou categoria").fill("PUBLIC-ITEM-B");
  await expect(main.getByRole("heading", { name: "Item público B", exact: true })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Item público A", exact: true })).toHaveCount(0);
});
