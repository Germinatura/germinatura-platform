import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const centralLocationId = "50000000-0000-4000-8000-000000000001";
const productId = "33f00000-0000-4000-8000-000000000001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };

function supabase() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  const serviceKey = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !serviceKey) throw new Error("Supabase local indisponível para o E2E da entrega de pedido pago");
  return { url, key, serviceKey };
}

async function call<T>(headers: Record<string, string>, name: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${supabase().url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  const result = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(`${name}: ${result.message ?? response.status}`);
  return result;
}

async function admin<T = Record<string, unknown>>(name: string, body: Record<string, unknown>) {
  const { url, key } = supabase();
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  return call<T>({ apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, name, body);
}

// ADR 0011: global flags belong to ADMIN_MASTER.
async function master<T = Record<string, unknown>>(name: string, body: Record<string, unknown>) {
  const { url, key } = supabase();
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "master.teste@institutojef.org.br", password: "Master123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  return call<T>({ apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, name, body);
}

// Plays the jobs worker and PicPay, which are not part of the E2E environment.
function worker<T = Record<string, unknown>>(name: string, body: Record<string, unknown>) {
  const { serviceKey } = supabase();
  return call<T>({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, name, body);
}

test("o pedido pago online é entregue no PDV sem nova cobrança, e a entrega não se repete", async ({ page, browser }) => {
  test.slow();
  const tag = Date.now().toString(36);
  await admin("adjust_stock", { p_location_id: centralLocationId, p_product_id: productId, p_quantity_delta: 2,
    p_reason: "Preparar entrega paga E2E", p_idempotency_key: `e2e-handover-stock:${tag}`, p_correlation_id: crypto.randomUUID() });
  await master("update_feature_flag", { p_key: "payment_link", p_enabled: true, p_reason: "E2E entrega de pedido pago", p_correlation_id: crypto.randomUUID() });
  let reservationId = "";
  try {
    // Consumer: reserves two units and pays online; PicPay confirms.
    const consumer = await browser.newContext({ baseURL: portalUrl });
    expect((await consumer.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    const created = await consumer.request.post("/api/v1/reservations", { headers: { Origin: portalUrl, "Idempotency-Key": `e2e-handover-res-${tag}` },
      data: { items: [{ productId, quantity: 2 }] } });
    expect(created.status()).toBe(201);
    reservationId = (await created.json() as { data: { reservationId: string } }).data.reservationId;
    const requested = await consumer.request.post(`/api/v1/reservations/${reservationId}/payment-link`, { headers: { Origin: portalUrl, "Idempotency-Key": `e2e-handover-link-${tag}` } });
    expect(requested.status()).toBe(201);
    const chargeId = (await requested.json() as { data: { chargeId: string } }).data.chargeId;
    await consumer.close();
    const workerId = `e2e-${crypto.randomUUID()}`;
    const claims = await worker<Array<{ charge_id: string; amount_cents: number }>>("worker_claim_payment_link_requests", { p_worker_id: workerId, p_limit: 50, p_lease_seconds: 120 });
    const claim = claims.find((item) => item.charge_id === chargeId);
    expect(claim).toBeTruthy();
    const linkId = `e2e-handover-${tag}`;
    await worker("worker_record_payment_link_created", { p_charge_id: chargeId, p_worker_id: workerId, p_provider_link_id: linkId,
      p_checkout_url: `https://link.picpay.com/p/${linkId}`, p_brcode: null, p_expires_at: null });
    await worker("worker_record_payment_link_event", { p_source: "WEBHOOK", p_event_type: "TransactionPaymentMessage",
      p_payload: { type: "PAYMENT", data: { transaction: { id: `e2e-handover-tx-${tag}`, status: "PAYED", amount: claim?.amount_cents, paymentType: "PIX" }, charge: { paymentLinkId: linkId } } } });
  } finally {
    await master("update_feature_flag", { p_key: "payment_link", p_enabled: false, p_reason: "Fim do E2E entrega de pedido pago", p_correlation_id: crypto.randomUUID() });
  }

  // Central stock operator at the PDV: the order shows as paid and is delivered without any payment form.
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Retiradas", exact: true }).click();
  const order = page.getByRole("list", { name: "Reservas e pedidos para entregar" }).getByRole("listitem").filter({ hasText: "2× Item público A" }).filter({ hasText: "Pago online" }).first();
  await order.getByRole("button", { name: "Entregar (já pago)" }).click();
  await expect(page.getByText(/Não cobre nada/)).toBeVisible();
  await expect(page.getByLabel("Valor recebido (R$)")).toHaveCount(0);
  const delivery = page.waitForResponse((response) => /\/pdv\/pickups\/[0-9a-f-]+\/deliver$/.test(response.url()));
  await page.getByRole("button", { name: "Confirmar entrega" }).dblclick();
  expect((await delivery).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Pedido entregue" })).toBeVisible();
  // Next's route announcer is an empty alert; only an error message counts.
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);

  // Straight to the API: the same key replays the same answer, and a new key never delivers twice.
  const deliver = (key: string) => page.request.post(`${pdvUrl}/api/v1/pdv/pickups/${reservationId}/deliver`, { headers: { ...pdvHeaders, "Idempotency-Key": key } });
  const first = await deliver(`e2e-handover-deliver-${tag}`);
  const replay = await deliver(`e2e-handover-deliver-${tag}`);
  expect(replay.status()).toBe(first.status());
  const fresh = await deliver(`e2e-handover-deliver-again-${tag}`);
  expect(fresh.status()).toBe(409);
  expect((await fresh.json() as { code: string }).code).toBe("COMMERCIAL_RESERVATION_ALREADY_DELIVERED");
});
