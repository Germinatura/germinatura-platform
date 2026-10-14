import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

const SELLER_LOCATION_ID = "50000000-0000-4000-8000-000000000002";
const PRODUCT_ID = "33f00000-0000-4000-8000-000000000001";

it("simultaneous PicPay notices confirm a sale once and competing payments go to recovery", async () => {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  const serviceKey = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !serviceKey || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Local Supabase required");
  async function call<T>(headers: Record<string, string>, name: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`${name}: ${typeof result.message === "string" ? result.message : response.status}`);
    return result as T;
  }
  async function session(email: string, password: string) {
    const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key!, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }) });
    const { access_token: token } = await login.json() as { access_token: string };
    const headers = { apikey: key!, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    return <T = Record<string, unknown>>(name: string, body: Record<string, unknown>) => call<T>(headers, name, body);
  }
  const worker = <T = Record<string, unknown>>(name: string, body: Record<string, unknown>) =>
    call<T>({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, name, body);
  const finance = await session("admin.teste@institutojef.org.br", "Admin123!");
  // ADR 0011: global flags belong to ADMIN_MASTER.
  const master = await session("master.teste@institutojef.org.br", "Master123!");
  const seller = await session("vendedor.teste@institutojef.org.br", "Vendedor123!");
  type Event = { outcome: string; duplicate: boolean; receipt_id: string };

  await master("update_feature_flag", { p_key: "payment_link", p_enabled: true, p_reason: "Teste de concorrência do link", p_correlation_id: randomUUID() });
  try {
    await finance("adjust_stock", { p_location_id: SELLER_LOCATION_ID, p_product_id: PRODUCT_ID, p_quantity_delta: 3,
      p_reason: "Preparar link concorrente", p_idempotency_key: `link-race-stock:${randomUUID()}`, p_correlation_id: randomUUID() });
    async function activeLink() {
      const sale = await seller<{ sale_id: string; quote: { total_cents: number } }>("checkout_sale", {
        p_channel: "PDV", p_location_id: SELLER_LOCATION_ID, p_items: [{ product_id: PRODUCT_ID, quantity: 1 }],
        p_idempotency_key: `link-race-checkout:${randomUUID()}`, p_correlation_id: randomUUID() });
      const charge = await seller<{ charge_id: string }>("request_payment_link", {
        p_sale_id: sale.sale_id, p_idempotency_key: `link-race-request:${randomUUID()}`, p_correlation_id: randomUUID() });
      const workerId = `race-${randomUUID()}`;
      const claims = await worker<Array<{ charge_id: string }>>("worker_claim_payment_link_requests", { p_worker_id: workerId, p_limit: 50, p_lease_seconds: 120 });
      expect(claims.map((claim) => claim.charge_id)).toContain(charge.charge_id);
      // Other claimed requests are left to expire; they belong to earlier runs.
      const linkId = `race-${randomUUID()}`;
      await worker("worker_record_payment_link_created", { p_charge_id: charge.charge_id, p_worker_id: workerId, p_provider_link_id: linkId,
        p_checkout_url: `https://link.picpay.com/p/${linkId}`, p_brcode: null, p_expires_at: null });
      return { linkId, totalCents: sale.quote.total_cents };
    }
    const notice = (linkId: string, transactionId: string, amount: number, source = "WEBHOOK") => worker<Event>("worker_record_payment_link_event", {
      p_source: source, p_event_type: source === "WEBHOOK" ? "TransactionPaymentMessage" : null,
      p_payload: { type: "PAYMENT", data: { transaction: { id: transactionId, status: "PAYED", amount, paymentType: "PIX" }, charge: { paymentLinkId: linkId } } },
    });

    // The provider delivers the same notice five times at once: one receipt, one application.
    const first = await activeLink();
    const transactionId = `tx-${randomUUID()}`;
    const deliveries = await Promise.all(Array.from({ length: 5 }, () => notice(first.linkId, transactionId, first.totalCents)));
    expect(deliveries.filter((delivery) => !delivery.duplicate)).toHaveLength(1);
    expect(new Set(deliveries.map((delivery) => delivery.receipt_id)).size).toBe(1);
    expect(deliveries.every((delivery) => delivery.outcome === "APPLIED")).toBe(true);

    // Three different payments race on one link: one confirms the sale, the others wait for a refund decision.
    const second = await activeLink();
    const racing = await Promise.all(Array.from({ length: 3 }, () => notice(second.linkId, `tx-${randomUUID()}`, second.totalCents)));
    expect(racing.map((result) => result.outcome).sort()).toEqual(["APPLIED", "RECOVERY_OPENED", "RECOVERY_OPENED"]);
    const recovery = await finance<Array<{ kind: string; transaction_id: string }>>("list_payment_recovery_items", { p_status: "OPEN", p_limit: 200 });
    const racingReceipts = new Set(racing.filter((result) => result.outcome === "RECOVERY_OPENED").map((result) => result.receipt_id));
    expect(racingReceipts.size).toBe(2);
    expect(recovery.filter((item) => item.kind === "DUPLICATE_PAYMENT").length).toBeGreaterThanOrEqual(2);

    // The webhook and the status query report the same payment at the same moment: one confirmation.
    const third = await activeLink();
    const sameTransaction = `tx-${randomUUID()}`;
    const converging = await Promise.all([
      notice(third.linkId, sameTransaction, third.totalCents, "WEBHOOK"),
      notice(third.linkId, sameTransaction, third.totalCents, "STATUS_QUERY"),
      notice(third.linkId, sameTransaction, third.totalCents, "STATUS_QUERY"),
    ]);
    expect(converging.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(converging.every((result) => result.outcome === "APPLIED")).toBe(true);
  } finally {
    await master("update_feature_flag", { p_key: "payment_link", p_enabled: false, p_reason: "Fim do teste de concorrência do link", p_correlation_id: randomUUID() });
  }
});
