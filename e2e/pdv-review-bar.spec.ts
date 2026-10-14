import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const itemA = "33f00000-0000-4000-8000-000000000001"; // "Item público A", R$ 25,90

/** Gives the seller location at least three units of item A. */
async function ensureSellerStock() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para preparar o estoque E2E");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const balances = await fetch(`${url}/rest/v1/inventory_balances?select=available_quantity&location_id=eq.${sellerLocationId}&product_id=eq.${itemA}`, { headers });
  const current = ((await balances.json()) as Array<{ available_quantity: number }>)[0]?.available_quantity ?? 0;
  if (current >= 3) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers, body: JSON.stringify({
    p_location_id: sellerLocationId, p_product_id: itemA, p_quantity_delta: 3 - current,
    p_reason: "Preparar barra de revisão E2E", p_idempotency_key: `e2e-review-bar-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

async function openSale(page: Page) {
  await page.goto(`${pdvUrl}/`);
  await expect(page.getByRole("heading", { name: "Item público A", exact: true })).toBeVisible();
}

test("PDV: a barra de revisão acompanha a rolagem no celular e some sem itens, offline desabilita", async ({ page, context }) => {
  test.slow();
  await ensureSellerStock();
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);

  for (const viewport of [{ width: 320, height: 640 }, { width: 360, height: 740 }, { width: 390, height: 844 }]) {
    const label = `${viewport.width}×${viewport.height}`;
    await page.setViewportSize(viewport);
    await openSale(page);
    const bar = page.getByRole("region", { name: "Venda em andamento" });
    // Empty cart: no bar.
    await expect(bar, label).toHaveCount(0);

    const add = page.getByRole("button", { name: "Adicionar uma unidade de Item público A" });
    await add.click();
    await expect(bar, label).toBeVisible();
    await expect(bar, label).toContainText("1 item");
    await expect(bar, label).toContainText("25,90");
    await add.click();
    await expect(bar, label).toContainText("2 itens");
    await expect(bar, label).toContainText("51,80");

    // Fixed to the bottom of the screen wherever the page is scrolled, inside the screen, never covering the summary.
    for (const position of ["top", "bottom"] as const) {
      await page.evaluate((where) => window.scrollTo(0, where === "top" ? 0 : document.body.scrollHeight), position);
      const box = await bar.boundingBox();
      expect(box, `${label} ${position}`).not.toBeNull();
      expect(Math.round((box?.y ?? 0) + (box?.height ?? 0)), `${label} ${position}: na base da tela`).toBe(viewport.height);
      expect((box?.x ?? -1) >= 0 && (box?.width ?? 0) <= viewport.width, `${label}: dentro da tela`).toBe(true);
    }
    const summaryButton = page.getByRole("complementary").getByRole("button", { name: "Revisar venda" });
    const summary = await summaryButton.boundingBox();
    const barBox = await bar.boundingBox();
    expect((summary?.y ?? 0) + (summary?.height ?? 0) <= (barBox?.y ?? 0) + 1, `${label}: a barra não cobre o resumo no fim da página`).toBe(true);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth, `${label}: sem rolagem horizontal`).toBeLessThanOrEqual(viewport.width);

    // Removing every item hides the bar.
    const remove = page.getByRole("button", { name: "Remover uma unidade de Item público A" });
    await remove.click();
    await remove.click();
    await expect(bar, label).toHaveCount(0);
  }

  // Offline: the bar stays, says why, and does not let the sale go to review.
  await page.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
  const bar = page.getByRole("region", { name: "Venda em andamento" });
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(bar.getByRole("button", { name: "Revisar venda" })).toBeDisabled();
  await expect(bar).toContainText("Sem conexão");
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(bar.getByRole("button", { name: "Revisar venda" })).toBeEnabled();

  // From the bar to the review step; the bar belongs to the catalog only.
  await bar.getByRole("button", { name: "Revisar venda" }).click();
  await expect(page.getByRole("heading", { name: "Itens da venda" })).toBeVisible();
  await expect(bar).toHaveCount(0);

  // Desktop keeps the sticky summary beside the products and has no bar.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSale(page);
  await page.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
  await expect(page.getByRole("region", { name: "Venda em andamento" })).toBeHidden();
  await expect(page.getByRole("complementary").getByRole("button", { name: "Revisar venda" })).toBeVisible();
});
