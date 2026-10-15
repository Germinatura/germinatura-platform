import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";

function supabase() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  const serviceKey = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !serviceKey) throw new Error("Supabase local indisponível para o E2E de rifas");
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

test("o consumidor escolhe números, paga online e vê os bilhetes pagos", async ({ page }) => {
  test.setTimeout(300_000);
  const name = `Rifa online ${Date.now().toString(36)}`;
  const campaign = await admin<{ campaign_id: string }>("create_raffle_campaign", {
    p_name: name, p_product_id: "33f00000-0000-4000-8000-000000000001", p_location_id: "50000000-0000-4000-8000-000000000001",
    p_number_count: 30, p_starts_at: new Date(Date.now() - 60_000).toISOString(), p_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    p_idempotency_key: `e2e-raffle-create-${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID(),
  });
  await admin("transition_raffle_campaign", { p_campaign_id: campaign.campaign_id, p_action: "PUBLISH",
    p_idempotency_key: `e2e-raffle-publish-${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() });
  await master("update_feature_flag", { p_key: "payment_link", p_enabled: true, p_reason: "E2E rifa online", p_correlation_id: crypto.randomUUID() });
  try {
    expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    await page.goto(`${portalUrl}/rifas`);
    const card = page.getByRole("heading", { name }).locator("xpath=ancestor::div[contains(@class,'g-card') or contains(@class,'overflow-hidden')][1]");
    await card.getByRole("button", { name: "Escolher números" }).click();
    const board = page.getByRole("group", { name: `Números de ${name}` });
    await board.getByRole("button", { name: "Número 7", exact: true }).click();
    await board.getByRole("button", { name: "Número 8", exact: true }).click();
    await expect(card.getByText("Selecionados:")).toContainText("7, 8");
    await card.getByRole("button", { name: "Reservar números" }).click();
    await expect(board.getByRole("button", { name: "Número 7 seu" })).toBeVisible();

    const ticket = page.getByRole("listitem", { name: `Bilhetes de ${name}` });
    await expect(ticket.getByText(/Aguardando pagamento/)).toBeVisible();
    await expect(ticket.getByText("7, 8")).toBeVisible();
    await ticket.getByRole("button", { name: "Pagar online" }).click();
    await page.waitForURL(/\/pedidos\/pagamento\/[0-9a-f-]{36}$/);
    const chargeId = page.url().split("/").at(-1) ?? "";

    const workerId = `e2e-${crypto.randomUUID()}`;
    const claims = await worker<Array<{ charge_id: string; amount_cents: number }>>("worker_claim_payment_link_requests", { p_worker_id: workerId, p_limit: 50, p_lease_seconds: 120 });
    const claim = claims.find((item) => item.charge_id === chargeId);
    expect(claim).toBeTruthy();
    const linkId = `e2e-raffle-${Date.now().toString(36)}`;
    await worker("worker_record_payment_link_created", { p_charge_id: chargeId, p_worker_id: workerId, p_provider_link_id: linkId,
      p_checkout_url: `https://link.picpay.com/p/${linkId}`, p_brcode: null, p_expires_at: null });
    await expect(page.getByRole("link", { name: "Pagar com PicPay" })).toBeVisible({ timeout: 15_000 });
    await worker("worker_record_payment_link_event", { p_source: "WEBHOOK", p_event_type: "TransactionPaymentMessage",
      p_payload: { type: "PAYMENT", data: { transaction: { id: `e2e-raffle-tx-${crypto.randomUUID()}`, status: "PAYED", amount: claim?.amount_cents, paymentType: "PIX" }, charge: { paymentLinkId: linkId } } } });
    await expect(page.getByRole("heading", { name: "Pagamento confirmado" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("link", { name: "Meus bilhetes" }).click();
    await expect(page.getByRole("listitem", { name: `Bilhetes de ${name}` }).getByText("Pago", { exact: true })).toBeVisible();
  } finally {
    await master("update_feature_flag", { p_key: "payment_link", p_enabled: false, p_reason: "Fim do E2E rifa online", p_correlation_id: crypto.randomUUID() });
  }
});
