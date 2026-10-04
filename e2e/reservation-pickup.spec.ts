import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const centralLocationId = "50000000-0000-4000-8000-000000000001";
const productId = "33f00000-0000-4000-8000-000000000001";
const headers = { Origin: portalUrl };

// Ensures the central location has one available unit for the reservation to hold.
async function ensureCentralStock() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para preparar o estoque E2E");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const auth = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const balances = await fetch(`${url}/rest/v1/inventory_balances?select=available_quantity&location_id=eq.${centralLocationId}&product_id=eq.${productId}`, { headers: auth });
  const [balance] = await balances.json() as Array<{ available_quantity: number }>;
  if ((balance?.available_quantity ?? 0) >= 1) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers: auth, body: JSON.stringify({
    p_location_id: centralLocationId, p_product_id: productId, p_quantity_delta: 1 - (balance?.available_quantity ?? 0),
    p_reason: "Preparar retirada E2E", p_idempotency_key: `e2e-pickup-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque central");
}

test("o operador entrega a reserva separada no PDV cobrando o preço congelado", async ({ page, browser }) => {
  test.slow();
  await ensureCentralStock();
  const tag = Date.now().toString(36);
  const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";

  const consumer = await browser.newContext({ baseURL: portalUrl });
  const consumerPage = await consumer.newPage();
  expect((await consumerPage.request.post("/api/auth/login", { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
  const created = await consumerPage.request.post("/api/v1/reservations", { headers: { ...headers, "Idempotency-Key": `e2e-pickup-${tag}` },
    data: { locationId: centralLocationId, items: [{ productId, quantity: 1 }] } });
  expect(created.status()).toBe(201);
  const reservationId = (await created.json()).data.reservationId as string;
  await consumer.close();

  const commission = await browser.newContext({ baseURL: portalUrl });
  const commissionPage = await commission.newPage();
  expect((await commissionPage.request.post("/api/auth/login", { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  expect((await commissionPage.request.post(`/api/v1/admin/reservations/${reservationId}/ready`, { headers: { ...headers, "Idempotency-Key": `e2e-pickup-ready-${tag}` },
    data: { pickupInstructions: `Balcão ${tag}` } })).status()).toBe(200);

  // Operator (central location) hands it over in the PDV and charges through Área Pix.
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Retiradas" }).click();
  const pickup = page.getByRole("list", { name: "Reservas e pedidos para entregar" }).getByRole("listitem").filter({ hasText: `Balcão ${tag}` });
  await expect(pickup).toBeVisible();
  await pickup.getByRole("button", { name: "Entregar e cobrar" }).click();
  await expect(page.getByText("Preço congelado na reserva; não é recalculado na retirada.")).toBeVisible();
  await page.getByRole("button", { name: "Área Pix" }).click();
  const complete = page.getByRole("button", { name: "Concluir retirada" });
  await expect(complete).toBeDisabled();
  await page.getByLabel("Referência não sensível do comprovante").fill(`PIX-${tag}`);
  const response = page.waitForResponse((candidate) => candidate.url().endsWith(`/api/v1/pdv/pickups/${reservationId}/complete`));
  await complete.click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Retirada concluída" })).toBeVisible();

  const completed = await commissionPage.request.get("/api/v1/admin/reservations?status=COMPLETED");
  expect(((await completed.json()).data as Array<{ reservationId: string }>).some((item) => item.reservationId === reservationId)).toBe(true);
  await commission.close();
});
