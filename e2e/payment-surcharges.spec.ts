import { expect, test, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const productId = "33f00000-0000-4000-8000-000000000001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };

// Ensures the seller location has at least one available unit for the sale to consume.
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
    p_reason: "Preparar acréscimo E2E", p_idempotency_key: `e2e-surcharge-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

/** "R$ 25,90" → 2590. */
async function cents(locator: Locator) {
  const text = (await locator.innerText()).replace(/[^\d,]/g, "");
  const [units, decimals = "0"] = text.split(",");
  return Number(units) * 100 + Number(decimals.padEnd(2, "0"));
}

test("financeiro configura o acréscimo do crédito e o PDV cobra produtos + acréscimo sem permitir que o vendedor o remova", async ({ page, browser }) => {
  test.slow();
  await ensureSellerStock();
  const finance = await browser.newContext({ baseURL: portalUrl });
  const financePage = await finance.newPage();
  expect((await financePage.request.post("/api/auth/login", { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  const creditRow = financePage.getByRole("listitem", { name: "Acréscimo de Crédito (maquininha)" });
  async function setCredit(mode: "Percentual" | "Sem acréscimo", value: string | null, reason: string) {
    await financePage.goto("/admin/financeiro/acrescimos");
    await creditRow.getByRole("button", { name: "Alterar" }).click();
    const form = financePage.getByRole("form", { name: "Alterar acréscimo de Crédito (maquininha)" });
    await form.getByRole("button", { name: mode, exact: true }).click();
    if (value !== null) await form.getByLabel("Percentual (%)").fill(value);
    await form.getByLabel("Motivo da mudança").fill(reason);
    await form.getByRole("button", { name: "Salvar nova versão" }).click();
  }

  // Finance sets 3,49% on credit; the version history keeps the reason.
  await setCredit("Percentual", "3,49", "Repasse da tarifa do crédito (E2E)");
  await expect(creditRow.getByText("3,49%", { exact: true })).toBeVisible();
  await expect(financePage.getByRole("cell", { name: "Repasse da tarifa do crédito (E2E)" }).first()).toBeVisible();

  try {
    expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders,
      data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
    await page.goto(`${pdvUrl}/`);
    await page.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
    await page.getByRole("button", { name: "Revisar venda" }).click();
    await page.getByRole("button", { name: /^Cobrar/ }).click();
    await expect(page.getByRole("heading", { name: "Confirmar pagamento" })).toBeVisible();
    await page.getByRole("button", { name: "Crédito", exact: true }).click();

    // The acréscimo is shown before charging: products, acréscimo and total, floor of 3,49%.
    const panel = page.locator('[aria-label="Acréscimo do meio de pagamento"]');
    await expect(panel).toContainText("Acréscimo do meio de pagamento (3,49%)");
    const products = await cents(panel.locator("div").filter({ hasText: /^Produtos/ }).locator("span").last());
    const total = await cents(panel.locator("div").filter({ hasText: /^Total a cobrar/ }).locator("strong").last());
    expect(total).toBe(products + Math.floor(products * 349 / 10_000));
    // A seller has no permission to remove it.
    await expect(page.getByRole("button", { name: "Remover acréscimo" })).toHaveCount(0);

    await page.getByLabel("Referência não sensível do comprovante").fill(`NSU-ACR-${Date.now().toString(36).toUpperCase()}`);
    const confirmation = page.waitForResponse((response) => response.url().endsWith("/payments/manual-confirmation"));
    await page.getByRole("button", { name: "Confirmar recebimento manualmente" }).click();
    expect((await confirmation).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Venda concluída" })).toBeVisible();
    await expect(page.getByText("Inclui acréscimo de")).toBeVisible();
    expect(await cents(page.getByText("Total recebido").locator("xpath=following-sibling::strong"))).toBe(total);
  } finally {
    // Other suites charge credit without an acréscimo: leave it as NONE (a new version; the history stays).
    await setCredit("Sem acréscimo", null, "Fim do teste E2E de acréscimo");
    await expect(creditRow.getByText("Sem acréscimo", { exact: true })).toBeVisible();
    await finance.close();
  }
});
