import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

const CENTRAL_LOCATION_ID = "50000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "33f00000-0000-4000-8000-000000000001";

it("a globally limited coupon is used exactly once under concurrent checkouts", async () => {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Local Supabase required");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function rpc(name: string, body: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`${name}: ${String(result.message ?? response.status)}`);
    return result;
  }
  async function balance() {
    const response = await fetch(`${url}/rest/v1/inventory_balances?select=on_hand_quantity,reserved_quantity&location_id=eq.${CENTRAL_LOCATION_ID}&product_id=eq.${PRODUCT_ID}`, { headers });
    const [row] = await response.json() as Array<{ on_hand_quantity: number; reserved_quantity: number }>;
    return row ?? { on_hand_quantity: 0, reserved_quantity: 0 };
  }

  const code = `LIMIT${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const coupon = await rpc("save_promotion", {
    p_promotion_id: null, p_expected_revision: null, p_code: `RACE-${code}`, p_name: "Cupom concorrente", p_description: null,
    p_active: true, p_publicable: true, p_priority: 1000, p_cumulative: false, p_valid_from: new Date(Date.now() - 60_000).toISOString(),
    p_valid_to: null, p_global_redemption_limit: 1, p_per_user_redemption_limit: null, p_product_ids: [PRODUCT_ID], p_channels: ["PDV"],
    p_rule: { type: "CUPOM", code, discount: { kind: "VALOR_FIXO", amountCents: 100 } }, p_reason: "Teste de limite concorrente",
    p_idempotency_key: `limit-coupon:${randomUUID()}`, p_correlation_id: randomUUID(),
  }) as { id: string };

  const attempts = 6;
  const before = await balance();
  expect(before.reserved_quantity).toBe(0);
  await rpc("adjust_stock", { p_location_id: CENTRAL_LOCATION_ID, p_product_id: PRODUCT_ID, p_quantity_delta: attempts,
    p_reason: "Preparar limite concorrente", p_idempotency_key: `limit-stock:${randomUUID()}`, p_correlation_id: randomUUID() });
  const sales: string[] = [];
  try {
    const results = await Promise.all(Array.from({ length: attempts }, () => rpc("checkout_sale", {
      p_channel: "PDV", p_location_id: CENTRAL_LOCATION_ID, p_items: [{ product_id: PRODUCT_ID, quantity: 1 }],
      p_idempotency_key: `limit-checkout:${randomUUID()}`, p_correlation_id: randomUUID(), p_coupon_code: code,
    }) as Promise<{ sale_id: string; quote: { coupon: { applied: boolean }; total_cents: number } }>));
    sales.push(...results.map((result) => result.sale_id));
    expect(results.filter((result) => result.quote.coupon.applied)).toHaveLength(1);
    const redemptions = await fetch(`${url}/rest/v1/promotion_redemptions?select=status,sale_id&promotion_id=eq.${coupon.id}`, { headers });
    const ledger = await redemptions.json() as Array<{ status: string; sale_id: string }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: "RESERVED", sale_id: results.find((result) => result.quote.coupon.applied)!.sale_id });
  } finally {
    for (const saleId of sales) {
      await rpc("cancel_sale", { p_sale_id: saleId, p_idempotency_key: `limit-cancel:${randomUUID()}`, p_correlation_id: randomUUID() });
    }
    const after = await balance();
    const delta = before.on_hand_quantity - after.on_hand_quantity;
    if (delta !== 0) {
      await rpc("adjust_stock", { p_location_id: CENTRAL_LOCATION_ID, p_product_id: PRODUCT_ID, p_quantity_delta: delta,
        p_reason: "Limpar limite concorrente", p_idempotency_key: `limit-stock-clean:${randomUUID()}`, p_correlation_id: randomUUID() });
    }
  }
  const released = await fetch(`${url}/rest/v1/promotion_redemptions?select=status&promotion_id=eq.${coupon.id}`, { headers });
  expect(await released.json()).toEqual([{ status: "RELEASED" }]);
});
