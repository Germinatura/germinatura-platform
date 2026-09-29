import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const centralLocationId = "50000000-0000-4000-8000-000000000001";
const productId = "33f00000-0000-4000-8000-000000000001";
const headers = { Origin: portalUrl };

function supabase() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  const serviceKey = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !serviceKey) throw new Error("Supabase local indisponível para o E2E do pagamento online");
  return { url, key, serviceKey };
}

async function call<T>(requestHeaders: Record<string, string>, name: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${supabase().url}/rest/v1/rpc/${name}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
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

// Plays the jobs worker and PicPay, which are not part of the E2E environment.
function worker<T = Record<string, unknown>>(name: string, body: Record<string, unknown>) {
  const { serviceKey } = supabase();
  return call<T>({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, name, body);
}

test("o consumidor paga a reserva online e acompanha a confirmação do PicPay", async ({ page }) => {
  test.slow();
  await admin("adjust_stock", { p_location_id: centralLocationId, p_product_id: productId, p_quantity_delta: 1,
    p_reason: "Preparar pagamento online E2E", p_idempotency_key: `e2e-portal-link-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() });
  await admin("update_feature_flag", { p_key: "payment_link", p_enabled: true, p_reason: "E2E pagamento online do consumidor", p_correlation_id: crypto.randomUUID() });
  try {
    expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    const created = await page.request.post(`${portalUrl}/api/v1/reservations`, { headers: { ...headers, "Idempotency-Key": `e2e-portal-link-${Date.now().toString(36)}` },
      data: { items: [{ productId, quantity: 1 }] } });
    expect(created.status()).toBe(201);
    const reservationId = (await created.json() as { data: { reservationId: string } }).data.reservationId;

    await page.goto(`${portalUrl}/reservas`);
    await expect(page.getByRole("button", { name: "Pagar online" }).first()).toBeVisible();
    const requested = page.waitForRequest((request) => request.url().endsWith(`/reservations/${reservationId}/payment-link`));
    await page.getByRole("button", { name: "Pagar online" }).first().click();
    await requested;
    await page.waitForURL(/\/pedidos\/pagamento\/[0-9a-f-]{36}$/);
    const chargeId = page.url().split("/").at(-1) ?? "";
    await expect(page.getByText("Preparando o pagamento no PicPay…")).toBeVisible();

    // The worker creates the link at PicPay with the Portal page as the return address.
    const workerId = `e2e-${crypto.randomUUID()}`;
    const claims = await worker<Array<{ charge_id: string; amount_cents: number; redirect_url: string | null }>>("worker_claim_payment_link_requests", { p_worker_id: workerId, p_limit: 50, p_lease_seconds: 120 });
    const claim = claims.find((item) => item.charge_id === chargeId);
    const charge = { chargeId, amountCents: claim?.amount_cents ?? 0 };
    expect(claim?.redirect_url).toBe(`${new URL(portalUrl).origin}/pedidos/pagamento/${charge.chargeId}`);
    const linkId = `e2e-portal-${Date.now().toString(36)}`;
    await worker("worker_record_payment_link_created", { p_charge_id: charge.chargeId, p_worker_id: workerId, p_provider_link_id: linkId,
      p_checkout_url: `https://link.picpay.com/p/${linkId}`, p_brcode: null, p_expires_at: null });
    const pay = page.getByRole("link", { name: "Pagar com PicPay" });
    await expect(pay).toBeVisible({ timeout: 15_000 });
    await expect(pay).toHaveAttribute("href", `https://link.picpay.com/p/${linkId}`);
    await expect(page.getByLabel("QR Code do pagamento")).toBeVisible();

    // Coming back from PicPay confirms nothing; the notice does.
    await page.reload();
    await expect(page.getByText("Aguardando pagamento")).toBeVisible();
    await worker("worker_record_payment_link_event", { p_source: "WEBHOOK", p_event_type: "TransactionPaymentMessage",
      p_payload: { type: "PAYMENT", data: { transaction: { id: `e2e-portal-tx-${crypto.randomUUID()}`, status: "PAYED", amount: charge.amountCents, paymentType: "PIX" }, charge: { paymentLinkId: linkId } } } });
    await expect(page.getByRole("heading", { name: "Pagamento confirmado" })).toBeVisible({ timeout: 15_000 });
  } finally {
    await admin("update_feature_flag", { p_key: "payment_link", p_enabled: false, p_reason: "Fim do E2E pagamento online do consumidor", p_correlation_id: crypto.randomUUID() });
  }
});
