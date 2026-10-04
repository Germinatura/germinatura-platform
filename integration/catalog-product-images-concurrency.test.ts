import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

it("uploads real objects and serializes concurrent cover changes", async () => {
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
  const jsonHeaders = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function rpc<T>(name: string, body: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
    const result = await response.json() as T & { message?: string };
    return response.ok ? { ok: true as const, value: result } : { ok: false as const, message: result.message };
  }
  const created = await rpc<{ id: string; revision: number }>("save_catalog_product", {
    p_product_id: null, p_expected_revision: null, p_category_id: "23f00000-0000-4000-8000-000000000001",
    p_slug: `image-race-${randomUUID()}`, p_name: "Produto com imagens", p_description: null,
    p_active: true, p_published: false, p_sellable_pdv: false, p_reservable: false, p_tracks_lots: false,
    p_reason: "Teste integrado de imagens", p_idempotency_key: `create:${randomUUID()}`, p_correlation_id: randomUUID(),
  });
  if (!created.ok) throw new Error(created.message);
  let revision = created.value.revision;
  const imageIds = [randomUUID(), randomUUID()];
  const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
  for (const [index, imageId] of imageIds.entries()) {
    const path = `products/${created.value.id}/${imageId}.png`;
    const upload = await fetch(`${url}/storage/v1/object/product-images/${path}`, {
      method: "POST", headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "image/png", "x-upsert": "false" }, body: png,
    });
    expect(upload.ok).toBe(true);
    const added = await rpc<{ productRevision: number }>("add_catalog_product_image", {
      p_product_id: created.value.id, p_expected_product_revision: revision, p_image_id: imageId,
      p_object_path: path, p_alt_text: `Imagem ${index + 1} do produto`, p_reason: "Adicionar imagem no teste",
      p_idempotency_key: `image:${randomUUID()}`, p_correlation_id: randomUUID(),
    });
    if (!added.ok) throw new Error(added.message);
    revision = added.value.productRevision;
  }
  const request = (ids: string[]) => rpc<{ productRevision: number }>("reorder_catalog_product_images", {
    p_product_id: created.value.id, p_expected_product_revision: revision, p_image_ids: ids,
    p_reason: "Definir capa concorrente", p_idempotency_key: `order:${randomUUID()}`, p_correlation_id: randomUUID(),
  });
  const raced = await Promise.all([request(imageIds), request([...imageIds].reverse())]);
  expect(raced.filter((result) => result.ok)).toHaveLength(1);
  expect(raced.filter((result) => !result.ok)).toEqual([{ ok: false, message: "PRODUCT_REVISION_CONFLICT" }]);
});
