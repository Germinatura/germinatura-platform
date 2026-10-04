import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const productId = "33f00000-0000-4000-8000-000000000001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };

// Ensures the seller location has at least one available unit for the card sale to consume.
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
    p_reason: "Preparar maquininha E2E", p_idempotency_key: `e2e-card-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

test("financeiro cadastra a maquininha e o vendedor registra método e terminal no pagamento", async ({ page, browser }) => {
  test.slow();
  await ensureSellerStock();
  const code = `MAQ-${Date.now().toString(36).toUpperCase()}`;

  // Finance registers the terminal in the Portal.
  const finance = await browser.newContext({ baseURL: portalUrl });
  const financePage = await finance.newPage();
  expect((await financePage.request.post("/api/auth/login", { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await financePage.goto("/admin/financeiro/maquininhas");
  await financePage.getByLabel("Código").fill(code.toLowerCase());
  await financePage.getByLabel("Nome").fill("Maquininha do teste");
  await financePage.getByRole("button", { name: "Cadastrar" }).click();
  const row = financePage.getByRole("listitem", { name: `Maquininha ${code}` });
  await expect(row).toBeVisible();
  await expect(row.getByText("Ativa", { exact: true })).toBeVisible();

  try {
    // Seller: the Maquininha payment needs the card method and the terminal before confirming.
    expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders,
      data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
    await page.goto(`${pdvUrl}/`);
    await page.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
    await page.getByRole("button", { name: "Revisar venda" }).click();
    await page.getByRole("button", { name: /^Cobrar/ }).click();
    await expect(page.getByRole("heading", { name: "Confirmar pagamento" })).toBeVisible();
    await page.getByLabel("Referência não sensível do comprovante").fill(`NSU-${code}`);
    const confirm = page.getByRole("button", { name: "Confirmar recebimento manualmente" });
    await expect(confirm).toBeDisabled();
    await page.getByRole("button", { name: "Débito" }).click();
    await expect(confirm).toBeDisabled();
    await page.getByLabel("Maquininha usada").selectOption({ label: `${code} · Maquininha do teste` });
    const confirmation = page.waitForResponse((response) => response.url().endsWith("/payments/manual-confirmation"));
    await confirm.click();
    expect((await confirmation).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Venda concluída" })).toBeVisible();
    await expect(page.getByText(`Débito · ${code}`)).toBeVisible();
  } finally {
    // Leave no active terminal behind: other suites confirm Maquininha payments without one.
    await financePage.goto("/admin/financeiro/maquininhas");
    await financePage.getByRole("listitem", { name: `Maquininha ${code}` }).getByRole("button", { name: "Desativar" }).click();
    await expect(financePage.getByRole("listitem", { name: `Maquininha ${code}` }).getByText("Inativa", { exact: true })).toBeVisible();
    await finance.close();
  }
});
