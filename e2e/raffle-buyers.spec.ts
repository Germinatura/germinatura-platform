import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };

async function admin<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<T> {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para o E2E de compradores de rifa");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(`${name}: ${result.message ?? response.status}`);
  return result;
}

test("a gestão vê os compradores e o contato de quem comprou sem cadastro; o vendedor não", async ({ page, browser }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const name = `Rifa compradores ${tag}`;
  const campaign = await admin<{ campaign_id: string }>("create_raffle_campaign", {
    p_name: name, p_product_id: "33f00000-0000-4000-8000-000000000001", p_location_id: "50000000-0000-4000-8000-000000000001",
    p_number_count: 10, p_starts_at: new Date(Date.now() - 60_000).toISOString(), p_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    p_idempotency_key: `e2e-raffle-buyers-create-${tag}`, p_correlation_id: crypto.randomUUID(),
  });
  await admin("transition_raffle_campaign", { p_campaign_id: campaign.campaign_id, p_action: "PUBLISH",
    p_idempotency_key: `e2e-raffle-buyers-publish-${tag}`, p_correlation_id: crypto.randomUUID() });

  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  const reserved = await page.request.post(`${pdvUrl}/api/v1/pdv/raffles/${campaign.campaign_id}/numbers/reserve`, {
    headers: { ...pdvHeaders, "Idempotency-Key": `e2e-raffle-buyers-reserve-${tag}` },
    data: { locationId: "50000000-0000-4000-8000-000000000002", numbers: [5, 6], buyer: { name: "Clara Balcão", contact: "(11) 96666-5555" } } });
  expect(reserved.status()).toBe(201);
  const saleId = (await reserved.json()).data.saleId as string;
  expect((await page.request.post(`${pdvUrl}/api/v1/sales/${saleId}/payments/manual-confirmation`, {
    headers: { ...pdvHeaders, "Idempotency-Key": `e2e-raffle-buyers-pay-${tag}` },
    data: { integrationChannel: "PIX_AREA", proofReference: `PIX-${tag}` } })).status()).toBe(200);
  // The seller never reaches the buyer list, even through the Portal API.
  const seller = await browser.newContext({ baseURL: portalUrl });
  expect((await seller.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  expect((await seller.request.get(`/api/v1/admin/raffles/${campaign.campaign_id}/buyers`)).status()).toBe(403);
  await seller.close();

  const manager = await browser.newContext({ baseURL: portalUrl });
  const managerPage = await manager.newPage();
  expect((await managerPage.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await managerPage.goto("/admin/rifas");
  await managerPage.waitForLoadState("networkidle");
  const card = managerPage.getByRole("heading", { name, exact: true }).locator("xpath=ancestor::div[contains(@class,'space-y-4')][1]");
  await card.getByText("Compradores", { exact: true }).click();
  const buyer = managerPage.getByRole("list", { name: `Compradores de ${name}` }).getByRole("listitem", { name: "Números 5, 6" });
  await expect(buyer).toContainText("Clara Balcão");
  await expect(buyer).toContainText("11966665555 · sem cadastro · PDV");
  await expect(buyer.getByText("Pago", { exact: true })).toBeVisible();
  await manager.close();
});
