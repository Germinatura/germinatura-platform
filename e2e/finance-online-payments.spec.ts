import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const productId = "33f00000-0000-4000-8000-000000000001";

function supabase() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  const serviceKey = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !serviceKey) throw new Error("Supabase local indisponível para o E2E de pagamentos online");
  return { url, key, serviceKey };
}

async function call<T>(headers: Record<string, string>, name: string, body: Record<string, unknown>): Promise<T> {
  const { url } = supabase();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  const result = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(`${name}: ${result.message ?? response.status}`);
  return result;
}

async function session(email: string, password: string) {
  const { url, key } = supabase();
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return <T = Record<string, unknown>>(name: string, body: Record<string, unknown>) => call<T>(headers, name, body);
}

// Plays the jobs worker and PicPay, which are not part of the E2E environment.
function worker<T = Record<string, unknown>>(name: string, body: Record<string, unknown>) {
  const { serviceKey } = supabase();
  return call<T>({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, name, body);
}

test("o financeiro decide o que os pagamentos online deixaram pendente", async ({ page }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const admin = await session("admin.teste@institutojef.org.br", "Admin123!");
  // ADR 0011: global flags belong to ADMIN_MASTER.
  const master = await session("master.teste@institutojef.org.br", "Master123!");
  const seller = await session("vendedor.teste@institutojef.org.br", "Vendedor123!");
  await master("update_feature_flag", { p_key: "payment_link", p_enabled: true, p_reason: "E2E pagamentos online", p_correlation_id: crypto.randomUUID() });
  let linkId = "";
  try {
    await admin("adjust_stock", { p_location_id: sellerLocationId, p_product_id: productId, p_quantity_delta: 1,
      p_reason: "Preparar pagamentos online E2E", p_idempotency_key: `e2e-online-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() });
    const sale = await seller<{ sale_id: string; quote: { total_cents: number } }>("checkout_sale", {
      p_channel: "PDV", p_location_id: sellerLocationId, p_items: [{ product_id: productId, quantity: 1 }],
      p_idempotency_key: `e2e-online-sale:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() });
    const charge = await seller<{ charge_id: string }>("request_payment_link", {
      p_sale_id: sale.sale_id, p_idempotency_key: `e2e-online-link:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() });
    const workerId = `e2e-${crypto.randomUUID()}`;
    await worker("worker_claim_payment_link_requests", { p_worker_id: workerId, p_limit: 50, p_lease_seconds: 120 });
    linkId = `e2e-online-${tag}`;
    await worker("worker_record_payment_link_created", { p_charge_id: charge.charge_id, p_worker_id: workerId, p_provider_link_id: linkId,
      p_checkout_url: `https://link.picpay.com/p/${linkId}`, p_brcode: null, p_expires_at: null });
    const payment = (id: string) => ({ type: "PAYMENT", data: { transaction: { id, status: "PAYED", amount: sale.quote.total_cents, paymentType: "PIX" }, charge: { paymentLinkId: linkId } } });
    await worker("worker_record_payment_link_event", { p_source: "WEBHOOK", p_event_type: "TransactionPaymentMessage", p_payload: payment(`e2e-tx-${tag}-1`) });
    await worker("worker_record_payment_link_event", { p_source: "WEBHOOK", p_event_type: "TransactionPaymentMessage", p_payload: payment(`e2e-tx-${tag}-2`) });
    await worker("worker_record_payment_link_event", { p_source: "WEBHOOK", p_event_type: null, p_payload: { unexpected: tag } });
  } finally {
    await master("update_feature_flag", { p_key: "payment_link", p_enabled: false, p_reason: "Fim do E2E pagamentos online", p_correlation_id: crypto.randomUUID() });
  }

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/financeiro/pagamentos-online`);
  const duplicate = page.getByRole("listitem", { name: "Recuperação Pagamento em duplicidade" }).filter({ hasText: `e2e-tx-${tag}-2` });
  await expect(duplicate).toBeVisible();
  await expect(page.getByRole("list", { name: "Links de pagamento" }).getByText("Pago").first()).toBeVisible();

  // Refund the duplicate payment through PicPay.
  await duplicate.getByRole("button", { name: "Pedir estorno" }).click();
  const refundForm = page.getByRole("form", { name: /Pedir estorno ao PicPay/ });
  await refundForm.getByLabel("Motivo do estorno").fill("Cliente pagou duas vezes");
  await refundForm.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByText("Estorno pedido; o worker envia ao PicPay.")).toBeVisible();
  const refundRow = page.getByRole("listitem", { name: `Estorno e2e-tx-${tag}-2` });
  await expect(refundRow.getByText("Na fila")).toBeVisible();

  // The worker gets no answer: the refund becomes uncertain and finance reconciles it after checking the panel.
  const refundWorker = `e2e-${crypto.randomUUID()}`;
  const claims = await worker<Array<{ refund_id: string; transaction_id: string }>>("worker_claim_payment_link_refunds", { p_worker_id: refundWorker, p_limit: 50, p_lease_seconds: 120 });
  const claim = claims.find((item) => item.transaction_id === `e2e-tx-${tag}-2`);
  expect(claim).toBeTruthy();
  await worker("worker_record_payment_link_refund", { p_refund_id: claim?.refund_id, p_worker_id: refundWorker, p_outcome: "UNCERTAIN",
    p_provider_refund_id: null, p_original_amount_cents: null, p_error_code: "PROVIDER_NO_RESPONSE" });
  await page.getByRole("button", { name: "Atualizar" }).click();
  await expect(refundRow.getByText("Incerto")).toBeVisible();
  await refundRow.getByRole("button", { name: "Reconciliar" }).click();
  const reconcileForm = page.getByRole("form", { name: "Reconciliar estorno incerto" });
  await reconcileForm.getByLabel("Sim, aguardar a confirmação do PicPay").check();
  await reconcileForm.getByLabel("Justificativa").fill("Estorno visto no painel PicPay");
  await reconcileForm.getByRole("button", { name: "Confirmar" }).click();
  await expect(refundRow.getByText("Aceito, aguardando PicPay")).toBeVisible();

  // An event in an unknown format is closed with a note.
  const unknown = page.getByRole("listitem", { name: "Recuperação Formato desconhecido" }).first();
  await unknown.getByRole("button", { name: "Resolver com justificativa" }).click();
  const resolveForm = page.getByRole("form", { name: "Resolver: Formato desconhecido" });
  await resolveForm.getByLabel("Justificativa").fill("Evento de teste sem efeito financeiro");
  await resolveForm.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByText("Item resolvido.")).toBeVisible();
  await page.getByRole("button", { name: "Resolvidos" }).click();
  await expect(page.getByText("Evento de teste sem efeito financeiro").first()).toBeVisible();
});
