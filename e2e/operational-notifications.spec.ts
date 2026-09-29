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
    p_reason: "Preparar aviso E2E", p_idempotency_key: `e2e-notify-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque central");
}

// Runs the outbox worker once with the local service role, as apps/jobs does in staging.
async function processOutbox() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Supabase local indisponível para o worker E2E");
  const auth = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const worker = `e2e-worker-${Date.now().toString(36)}`;
  for (let round = 0; round < 50; round += 1) {
    const claimed = await fetch(`${url}/rest/v1/rpc/worker_claim_outbox_events`, { method: "POST", headers: auth,
      body: JSON.stringify({ p_worker_id: worker, p_batch_size: 100, p_lease_seconds: 300 }) });
    const events = await claimed.json() as Array<{ id: string }>;
    if (!Array.isArray(events) || events.length === 0) return;
    for (const event of events) {
      await fetch(`${url}/rest/v1/rpc/worker_process_outbox_event`, { method: "POST", headers: auth,
        body: JSON.stringify({ p_event_id: event.id, p_worker_id: worker }) });
    }
  }
}

test("o cliente é avisado quando a comissão separa a reserva", async ({ page, browser }) => {
  test.slow();
  await ensureCentralStock();
  const tag = Date.now().toString(36);
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
  const created = await page.request.post(`${portalUrl}/api/v1/reservations`, { headers: { ...headers, "Idempotency-Key": `e2e-notify-${tag}` },
    data: { items: [{ productId, quantity: 1 }] } });
  expect(created.status()).toBe(201);
  const reservationId = (await created.json()).data.reservationId as string;

  const commission = await browser.newContext({ baseURL: portalUrl });
  const commissionPage = await commission.newPage();
  expect((await commissionPage.request.post("/api/auth/login", { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  // next dev may answer 404 while it compiles the route on first use; the same key makes retries safe.
  let readyResponse = await commissionPage.request.post(`/api/v1/admin/reservations/${reservationId}/ready`, { headers: { ...headers, "Idempotency-Key": `e2e-notify-ready-${tag}` },
    data: { pickupInstructions: null } });
  for (let attempt = 0; attempt < 10 && readyResponse.status() === 404; attempt += 1) {
    await commissionPage.waitForTimeout(500);
    readyResponse = await commissionPage.request.post(`/api/v1/admin/reservations/${reservationId}/ready`, { headers: { ...headers, "Idempotency-Key": `e2e-notify-ready-${tag}` },
      data: { pickupInstructions: null } });
  }
  expect(readyResponse.status(), await readyResponse.text()).toBe(200);
  await commission.close();

  await processOutbox();
  const listed = await page.request.get(`${portalUrl}/api/v1/notifications?limit=50`);
  expect(listed.status()).toBe(200);
  const ready = ((await listed.json()).data as Array<{ kind: string; data: { reservation_id?: string } }>)
    .find((item) => item.kind === "RESERVATION_READY" && item.data.reservation_id === reservationId);
  expect(ready).toBeTruthy();
  await page.goto(`${portalUrl}/notificacoes`);
  await expect(page.getByText("Reserva pronta para retirada").first()).toBeVisible();
});
