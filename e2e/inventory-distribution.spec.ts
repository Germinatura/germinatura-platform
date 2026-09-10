import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";
const headers = { Origin: portal, "Sec-Fetch-Site": "same-origin" };
const centralId = "50000000-0000-4000-8000-000000000001";
const sellerId = "50000000-0000-4000-8000-000000000003";
const productId = "33000000-0000-4000-8000-000000000001";

function localSupabase() {
  const output = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = output.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = output.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local sem URL ou chave pública");
  return { url, key };
}

async function adminDatabaseSession() {
  const config = localSupabase();
  const login = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: config.key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }),
  });
  const body = await login.json() as { access_token?: string };
  if (!login.ok || !body.access_token) throw new Error("Não foi possível autenticar a fixture no banco local");
  const authenticated = { apikey: config.key, Authorization: `Bearer ${body.access_token}`, "Content-Type": "application/json" };
  return {
    async rpc(name: string, parameters: Record<string, unknown>) {
      const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, { method: "POST", headers: authenticated, body: JSON.stringify(parameters) });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`${name}: ${String(result.message ?? response.status)}`);
      return result;
    },
    async balance() {
      const response = await fetch(`${config.url}/rest/v1/inventory_balances?select=on_hand_quantity,reserved_quantity&location_id=eq.${centralId}&product_id=eq.${productId}`, { headers: authenticated });
      const rows = await response.json() as Array<{ on_hand_quantity: number; reserved_quantity: number }>;
      if (!response.ok || rows.length !== 1) throw new Error("Saldo central da fixture indisponível");
      return rows[0];
    },
  };
}

test("Admin distributes central stock to a seller through the audited interface", async ({ page, browser }) => {
  test.slow();
  const database = await adminDatabaseSession();
  const before = await database.balance();
  const delta = Math.max(0, before.reserved_quantity + 3 - before.on_hand_quantity);
  let adjustmentId: string | null = null;
  let transferId: string | null = null;
  if (delta > 0) {
    const adjustment = await database.rpc("adjust_stock", {
      p_location_id: centralId, p_product_id: productId, p_quantity_delta: delta,
      p_reason: "Preparar distribuição E2E", p_idempotency_key: `e2e-distribution-adjust:${crypto.randomUUID()}`,
      p_correlation_id: crypto.randomUUID(),
    });
    adjustmentId = String(adjustment.movement_id);
  }

  try {
    expect((await page.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${portal}/admin/estoque`);
    const form = page.getByRole("form", { name: "Distribuir estoque da central" });
    await expect(form).toBeVisible();
    await form.getByLabel("Produto").selectOption(productId);
    await form.getByLabel("Destino").selectOption(sellerId);
    await form.getByLabel("Quantidade").fill("2");
    await form.getByLabel("Motivo").fill("Separação operacional para vendedor");
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/inventory/distributions") && response.request().method() === "POST");
    await form.getByRole("button", { name: "Distribuir estoque" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const result = await response.json() as { data: { movementId: string; quantity: number } };
    transferId = result.data.movementId;
    expect(result.data.quantity).toBe(2);
    await expect(form.getByRole("status")).toContainText("2 unidade(s) distribuída(s)");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const consumer = await browser.newContext();
    try {
      expect((await consumer.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
      const denied = await consumer.request.post(`${portal}/api/v1/admin/inventory/distributions`, {
        headers: { ...headers, "Idempotency-Key": `consumer:${crypto.randomUUID()}` },
        data: { fromLocationId: centralId, toLocationId: sellerId, productId, quantity: 1, reason: "Tentativa sem permissão" },
      });
      expect(denied.status()).toBe(403);
    } finally { await consumer.close(); }
  } finally {
    if (transferId) await database.rpc("reverse_stock_movement", { p_movement_id: transferId, p_reason: "Limpeza da distribuição E2E", p_idempotency_key: `e2e-distribution-reverse:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() });
    if (adjustmentId) await database.rpc("reverse_stock_movement", { p_movement_id: adjustmentId, p_reason: "Limpeza da preparação E2E", p_idempotency_key: `e2e-adjustment-reverse:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() });
  }
});
