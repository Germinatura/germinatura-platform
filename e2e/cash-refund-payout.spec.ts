import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const productId = "33f00000-0000-4000-8000-000000000001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };

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
    p_reason: "Preparar estorno em dinheiro E2E", p_idempotency_key: `e2e-refund-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

test("estorno em dinheiro sai do caixa do turno aberto e o fechamento confere", async ({ page, browser }) => {
  test.slow();
  await ensureSellerStock();
  const tag = Date.now().toString(36);

  // Seller: open shift (or reuse it) and sell one unit in cash.
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders,
    data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  let shift = (await (await page.request.get(`${pdvUrl}/api/v1/pdv/shifts`, { headers: pdvHeaders })).json()).data as { shiftId: string; expectedCashCents: number } | null;
  if (!shift) {
    const opened = await page.request.post(`${pdvUrl}/api/v1/pdv/shifts`, { headers: { ...pdvHeaders, "Idempotency-Key": `e2e-refund-open-${tag}` },
      data: { locationId: sellerLocationId, openingCashCents: 1_000 } });
    expect(opened.ok()).toBe(true);
    shift = (await opened.json()).data;
  }
  if (!shift) throw new Error("Turno não aberto");
  const expectedBefore = shift.expectedCashCents;
  const checkout = await page.request.post(`${pdvUrl}/api/v1/sales/checkout`, { headers: { ...pdvHeaders, "Idempotency-Key": `e2e-refund-sale-${tag}` },
    data: { channel: "PDV", locationId: sellerLocationId, items: [{ productId, quantity: 1 }] } });
  expect(checkout.ok()).toBe(true);
  const saleId = (await checkout.json()).data.saleId as string;
  const cash = await page.request.post(`${pdvUrl}/api/v1/sales/${saleId}/payments/cash`, { headers: { ...pdvHeaders, "Idempotency-Key": `e2e-refund-cash-${tag}` },
    data: { tenderedCents: 3_000 } });
  expect(cash.status()).toBe(200);

  // Finance: reverse the sale handing the cash back from the seller's open drawer.
  const finance = await browser.newContext({ baseURL: portalUrl });
  const financePage = await finance.newPage();
  expect((await financePage.request.post("/api/auth/login", { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  const reversalPayload = { reason: "Cliente devolveu o produto no caixa", refundReference: `EST-CASH-${tag}`, cashPayoutShiftId: shift.shiftId };
  const reversal = await financePage.request.post(`/api/v1/sales/${saleId}/cancel`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-refund-reverse-${tag}` }, data: reversalPayload });
  expect(reversal.status()).toBe(200);
  const reversalBody = await reversal.json();
  expect(reversalBody.data.reversal.cashPayout).toMatchObject({ shiftId: shift.shiftId, amountCents: 2_590 });
  const replay = await financePage.request.post(`/api/v1/sales/${saleId}/cancel`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-refund-reverse-${tag}` }, data: reversalPayload });
  expect(replay.status()).toBe(200);
  await expect(replay.json()).resolves.toMatchObject({ data: reversalBody.data });

  await financePage.goto("/admin/financeiro/turnos");
  await expect(financePage.getByRole("list", { name: "Turnos" })).toBeVisible();
  const reviewed = financePage.getByRole("listitem").filter({ hasText: shift.shiftId });
  await expect(reviewed).toBeVisible();
  await expect(reviewed.getByText("Devolvido em dinheiro").locator("xpath=following-sibling::dd")).not.toHaveText(/^0 ·/);
  await finance.close();

  // Seller: the receipt and the physical refund cancel out, so counting the float closes without divergence.
  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Meu turno" }).click();
  await expect(page.getByRole("heading", { name: "Turno aberto" })).toBeVisible();
  const expected = page.getByText("Dinheiro esperado").locator("xpath=following-sibling::dd");
  await expect(expected).toHaveText(new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(expectedBefore / 100));
  await page.getByLabel("Dinheiro contado no caixa (R$)").fill((await expected.innerText()).replace(/[^\d,]/g, ""));
  await expect(page.getByText("O contado confere com o esperado.")).toBeVisible();
  await page.getByRole("button", { name: "Fechar turno" }).click();
  await expect(page.getByRole("heading", { name: "Turno fechado" })).toBeVisible();
});
