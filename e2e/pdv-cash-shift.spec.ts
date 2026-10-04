import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const productId = "33f00000-0000-4000-8000-000000000001";

// Ensures the seller location has at least one available unit; the confirmed sale consumes it.
async function ensureSellerStock() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para preparar o estoque E2E");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const balances = await fetch(`${url}/rest/v1/inventory_balances?select=available_quantity&location_id=eq.${sellerLocationId}&product_id=eq.${productId}`, { headers });
  const [balance] = await balances.json() as Array<{ available_quantity: number }>;
  if ((balance?.available_quantity ?? 0) >= 1) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers, body: JSON.stringify({
    p_location_id: sellerLocationId, p_product_id: productId, p_quantity_delta: 1 - (balance?.available_quantity ?? 0),
    p_reason: "Preparar venda em dinheiro E2E", p_idempotency_key: `e2e-cash-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

test("vendedor abre turno, vende em dinheiro com troco e fecha o caixa conferido", async ({ page }) => {
  test.slow();
  await ensureSellerStock();
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" },
    data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  await page.goto(`${pdvUrl}/`);
  await expect(page.getByRole("heading", { name: "Nova venda" })).toBeVisible();

  await page.getByRole("button", { name: "Meu turno" }).click();
  await expect(page.getByRole("heading", { name: "Meu turno" })).toBeVisible();
  const openShift = page.getByRole("button", { name: "Abrir turno" });
  await expect(openShift.or(page.getByRole("heading", { name: "Turno aberto" }))).toBeVisible();
  if (await openShift.isVisible()) {
    await page.getByLabel("Fundo de troco (R$)").fill("10,00");
    await openShift.click();
  }
  await expect(page.getByRole("heading", { name: "Turno aberto" })).toBeVisible();
  const expectedBefore = await page.getByText("Dinheiro esperado").locator("xpath=following-sibling::dd").innerText();

  await page.getByRole("button", { name: "Operação" }).click();
  await page.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
  await page.getByRole("button", { name: "Revisar venda" }).click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await expect(page.getByRole("heading", { name: "Confirmar pagamento" })).toBeVisible();
  await page.getByRole("button", { name: /Dinheiro/ }).click();
  await page.getByLabel("Valor recebido (R$)").fill("20,00");
  await expect(page.getByText("O valor recebido precisa cobrir o total.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Registrar recebimento em dinheiro" })).toBeDisabled();
  // R$ 25,90 paid with R$ 50,00: change R$ 24,10.
  await page.getByLabel("Valor recebido (R$)").fill("50,00");
  await expect(page.getByText("Troco:")).toContainText("24,10");
  const confirmation = page.waitForResponse((response) => /\/api\/v1\/sales\/[0-9a-f-]+\/payments\/cash$/.test(response.url()));
  await page.getByRole("button", { name: "Registrar recebimento em dinheiro" }).click();
  expect((await confirmation).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Venda concluída" })).toBeVisible();
  await expect(page.getByText("Recebido / troco")).toBeVisible();

  await page.getByRole("button", { name: "Meu turno" }).click();
  const expected = page.getByText("Dinheiro esperado").locator("xpath=following-sibling::dd");
  await expect(expected).not.toHaveText(expectedBefore);
  const expectedText = (await expected.innerText()).replace(/[^\d,]/g, "");
  await page.getByLabel("Dinheiro contado no caixa (R$)").fill(expectedText);
  await expect(page.getByText("O contado confere com o esperado.")).toBeVisible();
  await page.getByRole("button", { name: "Fechar turno" }).click();
  await expect(page.getByRole("heading", { name: "Turno fechado" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Abrir turno" })).toBeVisible();
});
