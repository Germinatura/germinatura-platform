import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

const central = "50000000-0000-4000-8000-000000000001";

it("a new product is announced exactly once under concurrent publication and stock entries", async () => {
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
  async function rpc<T>(name: string, body: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json() as T & { message?: string };
    if (!response.ok) throw new Error(`${name}: ${result.message ?? response.status}`);
    return result;
  }
  const saveProduct = (id: string | null, revision: number | null, published: boolean) => rpc<{ id: string; revision: number }>("save_catalog_product", {
    p_product_id: id, p_expected_revision: revision, p_category_id: "23f00000-0000-4000-8000-000000000001",
    p_slug: `new-product-race-${randomUUID()}`, p_name: `Novidade ${randomUUID().slice(0, 8)}`, p_description: null,
    p_active: true, p_published: published, p_sellable_pdv: published, p_reservable: true, p_tracks_lots: false,
    p_reason: "Teste de novidade concorrente", p_idempotency_key: `new-product:${randomUUID()}`, p_correlation_id: randomUUID(),
  });
  // A priced draft, ready to be published (publication requires a current price).
  async function createDraft() {
    const created = await saveProduct(null, null, false);
    const price = await rpc<{ productRevision: number }>("set_catalog_product_price", {
      p_product_id: created.id, p_expected_product_revision: created.revision, p_amount_cents: 990,
      p_reason: "Preço da novidade", p_idempotency_key: `new-product-price:${randomUUID()}`, p_correlation_id: randomUUID(),
    });
    return { id: created.id, revision: price.productRevision };
  }
  const adjust = (productId: string, delta: number) => rpc("adjust_stock", {
    p_location_id: central, p_product_id: productId, p_quantity_delta: delta, p_reason: "Entrada concorrente",
    p_idempotency_key: `new-product-stock:${randomUUID()}`, p_correlation_id: randomUUID(),
  });
  async function announcedTimes(productId: string) {
    const showcase = await rpc<{ new_products: Array<{ id: string }> }>("get_portal_showcase", {});
    return showcase.new_products.filter((product) => product.id === productId).length;
  }

  // Two stock entries at once for a product published with zero stock.
  const draft = await createDraft();
  const empty = await saveProduct(draft.id, draft.revision, true);
  expect(await announcedTimes(empty.id)).toBe(0);
  await Promise.all([adjust(empty.id, 3), adjust(empty.id, 4)]);
  expect(await announcedTimes(empty.id)).toBe(1);

  // Publication racing the first stock entry: whichever commits last still sees the other and announces.
  for (let round = 0; round < 3; round += 1) {
    const racing = await createDraft();
    await Promise.all([saveProduct(racing.id, racing.revision, true), adjust(racing.id, 5)]);
    expect(await announcedTimes(racing.id)).toBe(1);
  }
});
