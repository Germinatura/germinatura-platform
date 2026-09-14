import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";
const pdv = "http://127.0.0.1:3001";
const centralId = "50000000-0000-4000-8000-000000000001";
const sellerId = "50000000-0000-4000-8000-000000000002";
const productId = "33000000-0000-4000-8000-000000000001";

function localSupabase() {
  const output = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = output.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1]; const key = output.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível"); return { url, key };
}

async function databaseSession() {
  const config = localSupabase(); const login = await fetch(`${config.url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: config.key, "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const body = await login.json() as { access_token?: string }; if (!login.ok || !body.access_token) throw new Error("Fixture administrativa indisponível");
  const headers = { apikey: config.key, Authorization: `Bearer ${body.access_token}`, "Content-Type": "application/json" };
  return {
    async rpc(name: string, parameters: Record<string, unknown>) { const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(parameters) }); const result = await response.json() as Record<string, unknown>; if (!response.ok) throw new Error(`${name}: ${String(result.message ?? response.status)}`); return result; },
    async balance(locationId: string) { const response = await fetch(`${config.url}/rest/v1/inventory_balances?select=on_hand_quantity,reserved_quantity&location_id=eq.${locationId}&product_id=eq.${productId}`, { headers }); const rows = await response.json() as Array<{ on_hand_quantity: number; reserved_quantity: number }>; if (!response.ok) throw new Error("Saldo indisponível"); return rows[0] ?? { on_hand_quantity: 0, reserved_quantity: 0 }; },
  };
}

test("vendedor solicita e administração recebe uma devolução pela interface", async ({ browser }) => {
  test.slow(); const database = await databaseSession(); const sellerBefore = await database.balance(sellerId); const centralBefore = await database.balance(centralId);
  expect(sellerBefore.reserved_quantity).toBe(0); const missing = Math.max(0, 2 - sellerBefore.on_hand_quantity); let adjustmentId: string | null = null; let movementId: string | null = null;
  if (missing) { const adjustment = await database.rpc("adjust_stock", { p_location_id: sellerId, p_product_id: productId, p_quantity_delta: missing, p_reason: "Preparar devolução E2E", p_idempotency_key: `e2e-return-adjust:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }); adjustmentId = String(adjustment.movement_id); }
  const sellerContext = await browser.newContext(); const adminContext = await browser.newContext();
  try {
    const sellerPage = await sellerContext.newPage(); await sellerPage.setViewportSize({ width: 390, height: 844 });
    expect((await sellerPage.request.post(`${pdv}/api/auth/login`, { headers: { Origin: pdv, "Sec-Fetch-Site": "same-origin" }, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
    await sellerPage.goto(`${pdv}/`); await sellerPage.getByRole("button", { name: "Devoluções" }).click(); await expect(sellerPage.getByRole("heading", { name: "Devoluções à central" })).toBeVisible();
    const form = sellerPage.getByRole("form", { name: "Solicitar devolução à central" }); await form.getByLabel("Produto").selectOption(productId); await form.getByLabel("Quantidade").fill("2"); await form.getByLabel("Motivo").fill("Sobras conferidas depois do evento");
    const requestPromise = sellerPage.waitForResponse((response) => response.url().endsWith("/api/v1/inventory/returns") && response.request().method() === "POST"); await form.getByRole("button", { name: "Solicitar devolução" }).click(); const requested = await requestPromise; expect(requested.status()).toBe(201);
    const requestId = String((await requested.json() as { data: { requestId: string } }).data.requestId); await expect(sellerPage.getByText("Aguardando recebimento", { exact: true })).toBeVisible(); await expect.poll(() => sellerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const adminPage = await adminContext.newPage(); expect((await adminPage.request.post(`${portal}/api/auth/login`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200); await adminPage.goto(`${portal}/admin/estoque`);
    const card = adminPage.locator("article").filter({ hasText: "Sobras conferidas depois do evento" }); await expect(card).toBeVisible(); await card.getByLabel("Resultado da conferência").fill("Quantidade e integridade conferidas");
    const receiptPromise = adminPage.waitForResponse((response) => response.url().endsWith(`/api/v1/admin/inventory/returns/${requestId}`) && response.request().method() === "PATCH"); await card.getByRole("button", { name: "Confirmar recebimento" }).click(); const received = await receiptPromise; expect(received.status()).toBe(200); movementId = String((await received.json() as { data: { movementId: string } }).data.movementId); await expect(card.getByText("Recebida", { exact: true })).toBeVisible();
    expect(await database.balance(sellerId)).toEqual({ on_hand_quantity: sellerBefore.on_hand_quantity + missing - 2, reserved_quantity: 0 }); expect(await database.balance(centralId)).toEqual({ on_hand_quantity: centralBefore.on_hand_quantity + 2, reserved_quantity: centralBefore.reserved_quantity });

    const consumer = await browser.newContext(); try { expect((await consumer.request.post(`${portal}/api/auth/login`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" }, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200); const denied = await consumer.request.post(`${portal}/api/v1/inventory/returns`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `consumer-return:${crypto.randomUUID()}` }, data: { productId, quantity: 1, reason: "Tentativa sem autorização" } }); expect(denied.status()).toBe(403); } finally { await consumer.close(); }
  } finally {
    await sellerContext.close().catch(() => undefined); await adminContext.close().catch(() => undefined);
    if (movementId) await database.rpc("reverse_stock_movement", { p_movement_id: movementId, p_reason: "Limpeza da devolução E2E", p_idempotency_key: `e2e-return-reverse:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() });
    if (adjustmentId) await database.rpc("reverse_stock_movement", { p_movement_id: adjustmentId, p_reason: "Limpeza da preparação E2E", p_idempotency_key: `e2e-return-adjust-reverse:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() });
  }
});
