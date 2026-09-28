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
    p_reason: "Preparar estorno pelo financeiro E2E", p_idempotency_key: `e2e-finance-sales-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

test("financeiro encontra a venda e estorna devolvendo o dinheiro pelo caixa do turno", async ({ page, browser }) => {
  test.slow();
  await ensureSellerStock();
  const tag = Date.now().toString(36);

  // Seller: a cash sale inside an open shift.
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders,
    data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  let shift = (await (await page.request.get(`${pdvUrl}/api/v1/pdv/shifts`, { headers: pdvHeaders })).json()).data as { shiftId: string; expectedCashCents: number } | null;
  if (!shift) {
    const opened = await page.request.post(`${pdvUrl}/api/v1/pdv/shifts`, { headers: { ...pdvHeaders, "Idempotency-Key": `e2e-fin-open-${tag}` },
      data: { locationId: sellerLocationId, openingCashCents: 1_000 } });
    expect(opened.ok()).toBe(true);
    shift = (await opened.json()).data;
  }
  if (!shift) throw new Error("Turno não aberto");
  const checkout = await page.request.post(`${pdvUrl}/api/v1/sales/checkout`, { headers: { ...pdvHeaders, "Idempotency-Key": `e2e-fin-sale-${tag}` },
    data: { channel: "PDV", locationId: sellerLocationId, items: [{ productId, quantity: 1 }] } });
  expect(checkout.ok()).toBe(true);
  const saleId = (await checkout.json()).data.saleId as string;
  expect((await page.request.post(`${pdvUrl}/api/v1/sales/${saleId}/payments/cash`, { headers: { ...pdvHeaders, "Idempotency-Key": `e2e-fin-cash-${tag}` },
    data: { tenderedCents: 3_000 } })).status()).toBe(200);

  // Finance: open the sale in Financeiro › Vendas and reverse it paying the cash back from the open shift.
  const finance = await browser.newContext({ baseURL: portalUrl });
  const financePage = await finance.newPage();
  expect((await financePage.request.post("/api/auth/login", { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await financePage.goto("/admin/financeiro/vendas");
  const sale = financePage.getByRole("listitem", { name: `Venda ${saleId}` });
  await sale.getByRole("button").first().click();
  const form = sale.getByRole("form", { name: "Estornar venda" });
  await expect(form).toBeVisible();
  await form.getByLabel("Motivo").fill("Cliente devolveu o produto no balcão");
  await form.getByLabel("Referência do estorno").fill(`EST-FIN-${tag}`);
  await form.getByLabel("Dinheiro entregue pelo caixa de um turno aberto").check();
  await form.getByLabel("Turno que entregou o dinheiro").selectOption(shift.shiftId);
  await form.getByRole("button", { name: "Estornar venda" }).click();
  const reversal = financePage.waitForResponse((response) => response.url().endsWith(`/api/v1/sales/${saleId}/cancel`));
  await form.getByRole("button", { name: /^Confirmar estorno de/ }).click();
  expect((await reversal).status()).toBe(200);
  await expect(financePage.getByText("Venda estornada e devolução registrada no caixa.")).toBeVisible();
  await expect(sale.getByText(/Estorno \(dinheiro do caixa\)/)).toBeVisible();
  await expect(sale.getByRole("list", { name: "Movimentos de caixa" }).getByText(/Devolução em dinheiro/)).toBeVisible();

  const detail = await (await financePage.request.get(`/api/v1/admin/finance/sales/${saleId}`)).json();
  expect(detail.data.status).toBe("CANCELLED");
  expect(detail.data.reversal.allowed).toBe(false);
  await finance.close();

  // Seller: the drawer is back to what it held before the sale.
  const after = (await (await page.request.get(`${pdvUrl}/api/v1/pdv/shifts`, { headers: pdvHeaders })).json()).data as { expectedCashCents: number; cashRefundsCount: number };
  expect(after.expectedCashCents).toBe(shift.expectedCashCents);
  expect(after.cashRefundsCount).toBeGreaterThan(0);
});
