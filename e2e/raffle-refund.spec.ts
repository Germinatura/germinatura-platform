import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };

async function admin<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<T> {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para o E2E de estorno de rifa");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(`${name}: ${result.message ?? response.status}`);
  return result;
}

test("o financeiro estorna uma venda de rifa paga e os números voltam ao quadro", async ({ page, browser }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const name = `Rifa estorno ${tag}`;
  const campaign = await admin<{ campaign_id: string }>("create_raffle_campaign", {
    p_name: name, p_product_id: "33f00000-0000-4000-8000-000000000001", p_location_id: "50000000-0000-4000-8000-000000000001",
    p_number_count: 10, p_starts_at: new Date(Date.now() - 60_000).toISOString(), p_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    p_idempotency_key: `e2e-raffle-refund-create-${tag}`, p_correlation_id: crypto.randomUUID(),
  });
  await admin("transition_raffle_campaign", { p_campaign_id: campaign.campaign_id, p_action: "PUBLISH",
    p_idempotency_key: `e2e-raffle-refund-publish-${tag}`, p_correlation_id: crypto.randomUUID() });

  // Seller: numbers 2 and 3 for a walk-in buyer, paid through the Área Pix.
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  const reserved = await page.request.post(`${pdvUrl}/api/v1/pdv/raffles/${campaign.campaign_id}/numbers/reserve`, {
    headers: { ...pdvHeaders, "Idempotency-Key": `e2e-raffle-refund-reserve-${tag}` },
    data: { locationId: sellerLocationId, numbers: [2, 3], buyer: { name: "Comprador Estorno", contact: "estorno@exemplo.com" } } });
  expect(reserved.status()).toBe(201);
  const saleId = (await reserved.json()).data.saleId as string;
  expect((await page.request.post(`${pdvUrl}/api/v1/sales/${saleId}/payments/manual-confirmation`, {
    headers: { ...pdvHeaders, "Idempotency-Key": `e2e-raffle-refund-pay-${tag}` },
    data: { integrationChannel: "PIX_AREA", proofReference: `PIX-${tag}` } })).status()).toBe(200);

  // Finance: Financeiro › Vendas shows the numbers and refunds the sale while the raffle is open.
  const finance = await browser.newContext({ baseURL: portalUrl });
  const financePage = await finance.newPage();
  expect((await financePage.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await financePage.goto("/admin/financeiro/vendas");
  const sale = financePage.getByRole("listitem", { name: `Venda ${saleId}` });
  await sale.getByRole("button").first().click();
  await expect(sale.getByRole("region", { name: "Rifa" })).toContainText(`${name} · números 2, 3`);
  const form = sale.getByRole("form", { name: "Estornar venda" });
  await expect(form.getByText(/Os números saem do sorteio/)).toBeVisible();
  await form.getByLabel("Motivo").fill("Comprador desistiu dos números");
  await form.getByLabel("Referência do estorno").fill(`EST-RIFA-${tag}`);
  await form.getByRole("button", { name: "Estornar venda" }).click();
  const reversal = financePage.waitForResponse((response) => response.url().endsWith(`/sales/${saleId}/cancel`));
  await form.getByRole("button", { name: /^Confirmar estorno de/ }).click();
  expect((await reversal).status()).toBe(200);
  await expect(financePage.getByText("Venda estornada.", { exact: true })).toBeVisible();
  await expect(sale.getByText("Estornada", { exact: true })).toBeVisible();
  await finance.close();

  // The numbers are free again for the next buyer.
  const board = await page.request.get(`${pdvUrl}/api/v1/raffles/${campaign.campaign_id}/numbers`, { headers: pdvHeaders });
  expect(board.ok()).toBe(true);
  expect(JSON.stringify((await board.json()).data)).not.toMatch(/TAKEN|MINE/);
});
