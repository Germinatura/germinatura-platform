import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

it("concurrent price commands preserve one price winner and one product revision", async () => {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Local Supabase required");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }),
  });
  expect(login.ok).toBe(true);
  const { access_token: token } = await login.json() as { access_token: string };
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function saveProduct(body: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/save_catalog_product`, { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json() as { id?: string; message?: string };
    if (!response.ok || !result.id) throw new Error(result.message ?? "Product creation failed");
    return result.id;
  }
  async function setPrice(amountCents: number) {
    const response = await fetch(`${url}/rest/v1/rpc/set_catalog_product_price`, {
      method: "POST", headers, body: JSON.stringify({
        p_product_id: productId, p_expected_product_revision: 1, p_amount_cents: amountCents,
        p_reason: "Teste de concorrência de preço", p_idempotency_key: `price:${randomUUID()}`,
        p_correlation_id: randomUUID(),
      }),
    });
    const result = await response.json() as { amountCents?: number; productRevision?: number; message?: string };
    return response.ok ? { ok: true as const, value: result } : { ok: false as const, message: result.message };
  }
  const productId = await saveProduct({
    p_product_id: null, p_expected_revision: null, p_category_id: "23f00000-0000-4000-8000-000000000001",
    p_slug: `price-race-${randomUUID()}`, p_name: "Preço concorrente", p_description: null,
    p_active: false, p_published: false, p_sellable_pdv: false, p_reservable: false, p_tracks_lots: false,
    p_reason: "Criar produto para preço", p_idempotency_key: `product:${randomUUID()}`, p_correlation_id: randomUUID(),
  });
  const race = await Promise.all([setPrice(2790), setPrice(2890)]);
  expect(race.filter((result) => result.ok)).toHaveLength(1);
  expect(race.filter((result) => !result.ok)).toEqual([{ ok: false, message: "PRODUCT_REVISION_CONFLICT" }]);
  const winner = race.find((result) => result.ok);
  expect(winner?.ok && winner.value.productRevision).toBe(2);
  expect([2790, 2890]).toContain(winner?.ok ? winner.value.amountCents : undefined);
});
