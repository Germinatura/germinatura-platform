import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

const SELLER_LOCATION_ID = "50000000-0000-4000-8000-000000000002";
const PRODUCT_ID = "33f00000-0000-4000-8000-000000000001";

it("a cash refund pays out once and never lands in a drawer that is closing", async () => {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Local Supabase required");
  async function session(email: string, password: string) {
    const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key!, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }) });
    const { access_token: token } = await login.json() as { access_token: string };
    const headers = { apikey: key!, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    return {
      headers,
      async rpc<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<T> {
        const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) throw new Error(`${name}: ${typeof result.message === "string" ? result.message : response.status}`);
        return result as T;
      },
    };
  }
  const finance = await session("admin.teste@institutojef.org.br", "Admin123!");
  const seller = await session("vendedor.teste@institutojef.org.br", "Vendedor123!");
  type Shift = { shift_id: string; expected_cash_cents: number; difference_cents: number | null };
  type Reversal = { reversal: { cash_payout: { movement_id: string } | null } };

  await finance.rpc("adjust_stock", { p_location_id: SELLER_LOCATION_ID, p_product_id: PRODUCT_ID, p_quantity_delta: 2,
    p_reason: "Preparar estorno concorrente", p_idempotency_key: `payout-stock:${randomUUID()}`, p_correlation_id: randomUUID() });
  let shift = await seller.rpc<Shift | null>("get_my_seller_shift", {});
  if (!shift) {
    shift = await seller.rpc<Shift>("open_seller_shift", { p_location_id: SELLER_LOCATION_ID, p_opening_cash_cents: 10_000,
      p_idempotency_key: `payout-open:${randomUUID()}`, p_correlation_id: randomUUID() });
  }
  async function cashSale() {
    const sale = await seller.rpc<{ sale_id: string; quote: { total_cents: number } }>("checkout_sale", {
      p_channel: "PDV", p_location_id: SELLER_LOCATION_ID, p_items: [{ product_id: PRODUCT_ID, quantity: 1 }],
      p_idempotency_key: `payout-checkout:${randomUUID()}`, p_correlation_id: randomUUID() });
    await seller.rpc("confirm_cash_payment", { p_sale_id: sale.sale_id, p_tendered_cents: sale.quote.total_cents,
      p_idempotency_key: `payout-cash:${randomUUID()}`, p_correlation_id: randomUUID() });
    return { saleId: sale.sale_id, totalCents: sale.quote.total_cents };
  }
  const reverse = (saleId: string) => finance.rpc<Reversal>("reverse_confirmed_sale", {
    p_sale_id: saleId, p_reason: "Estorno concorrente em dinheiro", p_refund_reference: `EST-RACE-${randomUUID().slice(0, 8)}`,
    p_cash_payout_shift_id: shift.shift_id, p_idempotency_key: `payout-reverse:${randomUUID()}`, p_correlation_id: randomUUID() });

  // Four finance operators refund the same sale at once: one physical payout, reported to all of them.
  const { saleId: first } = await cashSale();
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => reverse(first)));
  const payouts = results.flatMap((result) => result.status === "fulfilled" ? [result.value.reversal.cash_payout?.movement_id] : []);
  expect(payouts.length).toBeGreaterThan(0);
  expect(new Set(payouts)).toEqual(new Set([payouts[0]]));
  const movements = await fetch(`${url}/rest/v1/cash_movements?select=id&movement_type=eq.REFUND_PAYOUT&sale_id=eq.${first}`, { headers: finance.headers });
  expect(await movements.json()).toHaveLength(1);

  // A refund racing the close either lands before the count or is refused; the closed drawer always matches its ledger.
  const second = await cashSale();
  const open = await seller.rpc<Shift>("get_my_seller_shift", {});
  const [payout, close] = await Promise.allSettled([
    reverse(second.saleId),
    seller.rpc<Shift>("close_seller_shift", { p_shift_id: shift.shift_id, p_counted_cash_cents: open.expected_cash_cents,
      p_justification: "Contagem feita durante um estorno", p_idempotency_key: `payout-close:${randomUUID()}`, p_correlation_id: randomUUID() }),
  ]);
  expect(close.status).toBe("fulfilled");
  if (payout.status === "rejected") expect(String(payout.reason)).toContain("SELLER_SHIFT_NOT_OPEN");
  const closed = await fetch(`${url}/rest/v1/seller_shifts?select=expected_cash_cents&id=eq.${shift.shift_id}`, { headers: finance.headers });
  const ledger = await fetch(`${url}/rest/v1/cash_movements?select=amount_cents&shift_id=eq.${shift.shift_id}`, { headers: finance.headers });
  const [{ expected_cash_cents: expected }] = await closed.json() as Array<{ expected_cash_cents: number }>;
  const total = (await ledger.json() as Array<{ amount_cents: number }>).reduce((sum, row) => sum + row.amount_cents, 0);
  expect(expected).toBe(total);
  expect(expected).toBe(open.expected_cash_cents - (payout.status === "fulfilled" ? second.totalCents : 0));
});
