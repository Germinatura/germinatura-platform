import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const productId = "33f00000-0000-4000-8000-000000000001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };

function supabase() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  const serviceKey = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !serviceKey) throw new Error("Supabase local indisponível para o E2E do link de pagamento");
  return { url, key, serviceKey };
}

// Ensures the seller location has one available unit for the sale.
async function ensureSellerStock() {
  const { url, key } = supabase();
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const balances = await fetch(`${url}/rest/v1/inventory_balances?select=available_quantity&location_id=eq.${sellerLocationId}&product_id=eq.${productId}`, { headers });
  const [balance] = await balances.json() as Array<{ available_quantity: number }>;
  if ((balance?.available_quantity ?? 0) >= 1) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers, body: JSON.stringify({
    p_location_id: sellerLocationId, p_product_id: productId, p_quantity_delta: 1 - (balance?.available_quantity ?? 0),
    p_reason: "Preparar link de pagamento E2E", p_idempotency_key: `e2e-link-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

// Plays the jobs worker and PicPay, which are not part of the E2E environment.
async function worker<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { url, serviceKey } = supabase();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return response.json() as Promise<T>;
}

test("o vendedor gera um link de pagamento e a venda é confirmada quando o PicPay avisa", async ({ page, browser }) => {
  test.slow();
  await ensureSellerStock();
  const admin = await browser.newContext({ baseURL: portalUrl });
  const adminPage = await admin.newPage();
  // ADR 0011: global flags belong to ADMIN_MASTER, who always names the cohort it works in.
  expect((await adminPage.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "master.teste", password: "Master123!" } })).status()).toBe(200);
  const setFlag = (enabled: boolean) => adminPage.request.patch("/api/v1/admin/feature-flags/payment_link", {
    headers: { Origin: portalUrl, "x-germinatura-cohort": "c0000000-0000-4000-8000-000000002026" }, data: { enabled, reason: enabled ? "E2E do link de pagamento" : "Fim do E2E do link de pagamento" } });
  expect((await setFlag(true)).status()).toBe(200);
  try {
    expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders,
      data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
    await page.goto(`${pdvUrl}/`);
    await page.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
    await page.getByRole("button", { name: "Revisar venda" }).click();
    await page.getByRole("button", { name: /^Cobrar/ }).click();
    await expect(page.getByRole("heading", { name: "Confirmar pagamento" })).toBeVisible();
    await page.getByRole("button", { name: /Link de pagamento/ }).click();
    await expect(page.getByText("Confirmação pelo PicPay")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmar recebimento manualmente" })).toHaveCount(0);

    const requested = page.waitForResponse((response) => response.url().endsWith("/payments/payment-link") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Gerar link de pagamento" }).click();
    const charge = (await (await requested).json() as { data: { chargeId: string; amountCents: number } }).data;
    await expect(page.getByText("Gerando o link no PicPay…")).toBeVisible();

    // The worker creates the link at PicPay; the screen shows it without any manual action.
    const workerId = `e2e-${crypto.randomUUID()}`;
    const claims = await worker<Array<{ charge_id: string }>>("worker_claim_payment_link_requests", { p_worker_id: workerId, p_limit: 50, p_lease_seconds: 120 });
    expect(claims.map((claim) => claim.charge_id)).toContain(charge.chargeId);
    const linkId = `e2e-${charge.chargeId.slice(0, 8)}-${Date.now().toString(36)}`;
    await worker("worker_record_payment_link_created", { p_charge_id: charge.chargeId, p_worker_id: workerId, p_provider_link_id: linkId,
      p_checkout_url: `https://link.picpay.com/p/${linkId}`, p_brcode: "00020126E2E", p_expires_at: null });
    await expect(page.getByLabel("QR Code do link de pagamento")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`https://link.picpay.com/p/${linkId}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Pix copia e cola" })).toBeVisible();

    // PicPay reports the payment; the screen follows the server and shows the confirmed sale.
    const applied = await worker<{ outcome: string }>("worker_record_payment_link_event", { p_source: "WEBHOOK", p_event_type: "TransactionPaymentMessage",
      p_payload: { type: "PAYMENT", data: { transaction: { id: `e2e-tx-${crypto.randomUUID()}`, status: "PAYED", amount: charge.amountCents, paymentType: "PIX" }, charge: { paymentLinkId: linkId } } } });
    expect(applied.outcome).toBe("APPLIED");
    await expect(page.getByRole("heading", { name: "Pagamento confirmado" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Link de pagamento", { exact: true })).toBeVisible();
  } finally {
    expect((await setFlag(false)).status()).toBe(200);
    await admin.close();
  }
});

test("sem a flag o PDV não oferece link de pagamento", async ({ page }) => {
  await ensureSellerStock();
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders,
    data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
  await page.getByRole("button", { name: "Revisar venda" }).click();
  await page.getByRole("button", { name: /^Cobrar/ }).click();
  await expect(page.getByRole("heading", { name: "Confirmar pagamento" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Maquininha" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Link de pagamento/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancelar venda pendente" }).click();
});
