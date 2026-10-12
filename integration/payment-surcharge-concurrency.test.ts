import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

const SELLER_LOCATION_ID = "50000000-0000-4000-8000-000000000002";
const PRODUCT_ID = "33f00000-0000-4000-8000-000000000001";

it("acréscimo rules version once per change and a sale is charged once, with the acréscimo it showed", async () => {
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
  type Rules = { rules: Array<{ method: string; mode: string; version: number; rate_bps: number | null }>; history: Array<{ method: string; version: number }> };
  const save = (mode: string, rateBps: number | null, reason: string) => finance.rpc<{ version: number }>("save_payment_surcharge_rule", {
    p_method: "CREDITO", p_mode: mode, p_rate_bps: rateBps, p_fixed_cents: null, p_reason: reason,
    p_idempotency_key: `surcharge-race-rule:${randomUUID()}`, p_correlation_id: randomUUID() });
  const credit = async () => (await finance.rpc<Rules>("list_payment_surcharge_rules", {})).rules.find((rule) => rule.method === "CREDITO")!;

  try {
    // Six finance operators change the credit rule at once: six consecutive versions, the last one in force.
    const before = (await credit()).version;
    const saved = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => save("PERCENTAGE", 101 + index, `Corrida de regras ${index}`)));
    const versions = saved.flatMap((result) => result.status === "fulfilled" ? [result.value.version] : []).sort((left, right) => left - right);
    expect(versions).toEqual(Array.from({ length: 6 }, (_, index) => before + 1 + index));
    expect((await credit()).version).toBe(before + 6);

    await save("PERCENTAGE", 500, "Regra da venda concorrente").catch(() => undefined);
    await finance.rpc("adjust_stock", { p_location_id: SELLER_LOCATION_ID, p_product_id: PRODUCT_ID, p_quantity_delta: 2,
      p_reason: "Preparar acréscimo concorrente", p_idempotency_key: `surcharge-race-stock:${randomUUID()}`, p_correlation_id: randomUUID() });
    const checkout = () => seller.rpc<{ sale_id: string; quote: { total_cents: number } }>("checkout_sale", {
      p_channel: "PDV", p_location_id: SELLER_LOCATION_ID, p_items: [{ product_id: PRODUCT_ID, quantity: 1 }],
      p_idempotency_key: `surcharge-race-checkout:${randomUUID()}`, p_correlation_id: randomUUID() });
    const confirm = (saleId: string, surchargeCents: number) => seller.rpc<{ payment_attempt: { amount_cents: number }; surcharge: { applied_cents: number } | null }>(
      "confirm_manual_payment", { p_sale_id: saleId, p_integration_channel: "MAQUININHA", p_proof_reference: `NSU-RACE-${randomUUID().slice(0, 8)}`,
        p_card_method: "CREDITO", p_terminal_id: null, p_idempotency_key: `surcharge-race-confirm:${randomUUID()}`, p_correlation_id: randomUUID(),
        p_surcharge_cents: surchargeCents });

    // Four confirmations of the same sale: exactly one charge, with exactly one acréscimo snapshot.
    const sale = await checkout();
    const expected = Math.floor(sale.quote.total_cents * 500 / 10_000);
    const confirmations = await Promise.allSettled(Array.from({ length: 4 }, () => confirm(sale.sale_id, expected)));
    const charged = confirmations.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(charged).toHaveLength(1);
    expect(charged[0].payment_attempt.amount_cents).toBe(sale.quote.total_cents + expected);
    const detail = await finance.rpc<{ payment: { amount_cents: number; surcharge: { applied_cents: number } | null } }>("get_sale_admin", { p_sale_id: sale.sale_id });
    expect(detail.payment.amount_cents).toBe(sale.quote.total_cents + expected);
    expect(detail.payment.surcharge?.applied_cents).toBe(expected);

    // A rule change racing a confirmation: the sale is charged the acréscimo it showed, or refused; never another value.
    const racing = await checkout();
    const shown = Math.floor(racing.quote.total_cents * 500 / 10_000);
    const [confirmation] = await Promise.allSettled([confirm(racing.sale_id, shown), save("PERCENTAGE", 900, "Mudança durante a cobrança")]);
    if (confirmation.status === "fulfilled") {
      expect(confirmation.value.payment_attempt.amount_cents).toBe(racing.quote.total_cents + shown);
    } else {
      expect(String(confirmation.reason)).toContain("PAYMENT_SURCHARGE_CHANGED");
    }
  } finally {
    // Later suites charge without an acréscimo: leave the credit rule as NONE (a new version, history kept).
    if ((await credit()).mode !== "NONE") await save("NONE", null, "Fim do teste de concorrência");
  }
});
