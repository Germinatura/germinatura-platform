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
    p_reason: "Preparar reserva E2E", p_idempotency_key: `e2e-reservation-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque central");
}

test("a comissão separa a reserva e o consumidor vê as instruções de retirada", async ({ page, browser }) => {
  test.slow();
  await ensureCentralStock();
  const tag = Date.now().toString(36);
  const instructions = `Retire na sala da comissão ${tag}`;

  // Consumer reserves one unit.
  const consumer = await browser.newContext({ baseURL: portalUrl });
  const consumerPage = await consumer.newPage();
  expect((await consumerPage.request.post("/api/auth/login", { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
  const created = await consumerPage.request.post("/api/v1/reservations", { headers: { ...headers, "Idempotency-Key": `e2e-reservation-${tag}` },
    data: { locationId: centralLocationId, items: [{ productId, quantity: 1 }] } });
  expect(created.status()).toBe(201);
  const reservationId = (await created.json()).data.reservationId as string;

  // Commission: filter the active reservations and mark this one ready with instructions.
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/reservas`);
  await page.getByLabel("Situação").selectOption("ACTIVE");
  const listed = await page.request.get(`${portalUrl}/api/v1/admin/reservations?status=ACTIVE`);
  const position = ((await listed.json()).data as Array<{ reservationId: string }>).findIndex((item) => item.reservationId === reservationId);
  expect(position).toBeGreaterThanOrEqual(0);
  const row = page.getByRole("list", { name: "Reservas" }).getByRole("listitem").nth(position);
  await row.getByRole("button", { name: "Marcar pronta" }).click();
  await row.getByLabel("Instruções de retirada (opcional)").fill(instructions);
  await row.getByRole("button", { name: "Confirmar pronta" }).click();
  await expect(page.getByText("Reserva pronta para retirada.")).toBeVisible();

  // Consumer: sees the prepared reservation with its instructions and can no longer cancel it.
  await consumerPage.goto("/reservas");
  const card = consumerPage.getByRole("region", { name: "Reservas do consumidor" }).getByText(instructions);
  await expect(card).toBeVisible();
  await expect(consumerPage.getByText("Pronta para retirada").first()).toBeVisible();
  const cancel = await consumerPage.request.post(`/api/v1/reservations/${reservationId}/cancel`, { headers: { ...headers, "Idempotency-Key": `e2e-reservation-cancel-${tag}` } });
  expect(cancel.status()).toBe(409);
  await consumer.close();

  // Commission: cancels the prepared reservation, releasing the stock.
  const released = await page.request.post(`${portalUrl}/api/v1/reservations/${reservationId}/cancel`, { headers: { ...headers, "Idempotency-Key": `e2e-reservation-admin-cancel-${tag}` } });
  expect(released.status()).toBe(200);
  expect((await released.json()).data.status).toBe("CANCELLED");
});
