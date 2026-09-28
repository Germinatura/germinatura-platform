import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const productId = "33f00000-0000-4000-8000-000000000001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };

// Ensures the seller location has at least one available unit for the pending sale to reserve.
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
    p_reason: "Preparar minhas vendas E2E", p_idempotency_key: `e2e-my-sales-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

test("vendedor vê suas vendas com a pendente em destaque e cancela a pendente", async ({ page }) => {
  test.slow();
  await ensureSellerStock();
  const tag = Date.now().toString(36);
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders,
    data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  const checkout = await page.request.post(`${pdvUrl}/api/v1/sales/checkout`, { headers: { ...pdvHeaders, "Idempotency-Key": `e2e-my-sales-${tag}` },
    data: { channel: "PDV", locationId: sellerLocationId, items: [{ productId, quantity: 1 }] } });
  expect(checkout.ok()).toBe(true);
  const saleId = (await checkout.json()).data.saleId as string;

  const listed = await page.request.get(`${pdvUrl}/api/v1/pdv/sales?filter=PENDING`, { headers: pdvHeaders });
  expect(listed.status()).toBe(200);
  const body = await listed.json();
  expect(body.pendingCount).toBeGreaterThan(0);
  expect(body.data.find((sale: { saleId: string }) => sale.saleId === saleId)).toMatchObject({ status: "AWAITING_PAYMENT", pendingReason: "AWAITING_PAYMENT" });

  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Minhas vendas" }).click();
  await expect(page.getByRole("heading", { name: "Minhas vendas" })).toBeVisible();
  await page.getByRole("button", { name: /^Pendentes/ }).click();
  const list = page.getByRole("list", { name: "Minhas vendas" });
  const pending = list.getByRole("listitem").filter({ hasText: "Aguardando pagamento" }).first();
  await expect(pending).toBeVisible();
  await expect(pending.getByText(/Reserva até/)).toBeVisible();
  const cancellation = page.waitForResponse((response) => response.url().endsWith(`/api/v1/sales/${saleId}/cancel`));
  await pending.getByRole("button", { name: "Cancelar venda" }).click();
  await pending.getByRole("button", { name: "Confirmar cancelamento" }).click();
  const response = await cancellation;
  // The newest pending sale is the one just created, so this is its cancellation.
  expect(response.status()).toBe(200);
  await expect(page.getByText("Venda cancelada e reserva liberada.")).toBeVisible();

  await page.getByRole("button", { name: "Canceladas" }).click();
  await expect(list.getByRole("listitem").filter({ hasText: "Cancelada" }).first()).toBeVisible();
  const after = await (await page.request.get(`${pdvUrl}/api/v1/pdv/sales?filter=CANCELLED`, { headers: pdvHeaders })).json();
  expect(after.data.some((sale: { saleId: string; status: string }) => sale.saleId === saleId && sale.status === "CANCELLED")).toBe(true);
});
