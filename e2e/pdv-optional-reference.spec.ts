import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const itemA = "33f00000-0000-4000-8000-000000000001";

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
  if (current >= 2) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers, body: JSON.stringify({
    p_location_id: sellerLocationId, p_product_id: itemA, p_quantity_delta: 2 - current,
    p_reason: "Preparar referência opcional E2E", p_idempotency_key: `e2e-optional-proof-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

test("PDV: a Área Pix é confirmada sem referência externa; uma referência digitada segue o formato seguro", async ({ page }) => {
  test.slow();
  await ensureSellerStock();
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
  await page.getByRole("complementary").getByRole("button", { name: "Revisar venda" }).click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await expect(page.getByRole("heading", { name: "Confirmar pagamento" })).toBeVisible();
  await page.getByRole("button", { name: /^Pix/ }).click();

  const reference = page.getByLabel("Referência externa (opcional)");
  const confirm = page.getByRole("button", { name: "Confirmar recebimento manualmente" });
  await expect(page.getByText("Preencha apenas se houver um identificador útil no comprovante.", { exact: false })).toBeVisible();
  // Manual confirmation is still stated: nothing is checked automatically.
  await expect(page.getByText("Confirme fora do sistema antes de continuar.")).toBeVisible();
  await expect(confirm).toBeEnabled();

  // A typed reference keeps the rules: too short and card numbers are refused before reaching the server.
  await reference.fill("ab");
  await expect(page.getByText("Use de 4 a 128 letras", { exact: false })).toBeVisible();
  await expect(confirm).toBeDisabled();
  await reference.fill("4111111111111111");
  await expect(page.getByText("Não informe número do cartão", { exact: false })).toBeVisible();
  await expect(confirm).toBeDisabled();
  await reference.fill("");
  await expect(confirm).toBeEnabled();

  const confirmation = page.waitForResponse((response) => response.url().endsWith("/payments/manual-confirmation"));
  await confirm.click();
  const response = await confirmation;
  expect(response.status()).toBe(200);
  const body = await response.json() as { data: { saleId: string; paymentAttempt: { proofReference: string | null } } };
  expect(body.data.paymentAttempt.proofReference).toBeNull();
  await expect(page.getByRole("heading", { name: "Venda concluída" })).toBeVisible();
  await expect(page.getByText("Sem referência externa")).toBeVisible();

  // "Minhas vendas" lists the sale without a reference.
  const sales = await page.request.get(`${pdvUrl}/api/v1/pdv/sales`, { headers: pdvHeaders });
  expect(sales.status()).toBe(200);
  const listed = (await sales.json() as { data: { saleId: string; status: string }[] }).data.find((sale) => sale.saleId === body.data.saleId);
  expect(listed?.status).toBe("CONFIRMED");
});
