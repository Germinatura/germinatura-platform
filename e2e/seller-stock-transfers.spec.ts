import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";
const pdv = "http://127.0.0.1:3001";
const sourceLocationId = "50000000-0000-4000-8000-000000000002";
const destinationLocationId = "50000000-0000-4000-8000-000000000003";
const productId = "33000000-0000-4000-8000-000000000001";

function localSupabase() {
  const output = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = output.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = output.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível");
  return { url, key };
}

async function adminDatabaseSession() {
  const config = localSupabase();
  const login = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: config.key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }),
  });
  const body = await login.json() as { access_token?: string };
  if (!login.ok || !body.access_token) throw new Error("Não foi possível autenticar a fixture administrativa");
  const headers = { apikey: config.key, Authorization: `Bearer ${body.access_token}`, "Content-Type": "application/json" };
  return {
    async rpc(name: string, parameters: Record<string, unknown>) {
      const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(parameters) });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`${name}: ${String(result.message ?? response.status)}`);
      return result;
    },
    async balance(locationId: string) {
      const response = await fetch(`${config.url}/rest/v1/inventory_balances?select=on_hand_quantity,reserved_quantity&location_id=eq.${locationId}&product_id=eq.${productId}`, { headers });
      const rows = await response.json() as Array<{ on_hand_quantity: number; reserved_quantity: number }>;
      if (!response.ok) throw new Error("Saldo da fixture indisponível");
      return rows[0] ?? { on_hand_quantity: 0, reserved_quantity: 0 };
    },
  };
}

async function loginPdv(page: import("@playwright/test").Page, identifier: string, password: string) {
  const response = await page.request.post(`${pdv}/api/auth/login`, {
    headers: { Origin: pdv, "Sec-Fetch-Site": "same-origin" }, data: { identifier, password },
  });
  expect(response.status()).toBe(200);
  await page.goto(`${pdv}/`);
}

test("vendedores solicitam e aceitam uma transferência pelo PDV", async ({ browser }) => {
  test.slow();
  const database = await adminDatabaseSession();
  const sourceBefore = await database.balance(sourceLocationId);
  const destinationBefore = await database.balance(destinationLocationId);
  expect(sourceBefore.reserved_quantity).toBe(0);
  let adjustmentId: string | null = null;
  let transferMovementId: string | null = null;
  const missing = Math.max(0, 2 - sourceBefore.on_hand_quantity);
  if (missing > 0) {
    const adjustment = await database.rpc("adjust_stock", {
      p_location_id: sourceLocationId, p_product_id: productId, p_quantity_delta: missing,
      p_reason: "Preparar transferência E2E", p_idempotency_key: `e2e-seller-transfer-adjust:${crypto.randomUUID()}`,
      p_correlation_id: crypto.randomUUID(),
    });
    adjustmentId = String(adjustment.movement_id);
  }

  const destinationContext = await browser.newContext();
  const sourceContext = await browser.newContext();
  try {
    const destinationPage = await destinationContext.newPage();
    await destinationPage.setViewportSize({ width: 390, height: 844 });
    await loginPdv(destinationPage, "vendedor.destino", "VendedorDestino123!");
    await destinationPage.getByRole("button", { name: "Transferências" }).click();
    await expect(destinationPage.getByRole("heading", { name: "Transferências entre vendedores" })).toBeVisible();
    const form = destinationPage.getByRole("form", { name: "Solicitar transferência de estoque" });
    await form.getByLabel("Produto e origem").selectOption(`${sourceLocationId}:${productId}`);
    await form.getByLabel("Quantidade").fill("2");
    await form.getByLabel("Motivo").fill("Reposição para atendimento no evento");
    const requestPromise = destinationPage.waitForResponse((response) => response.url().endsWith("/api/v1/inventory/transfer-requests") && response.request().method() === "POST");
    await form.getByRole("button", { name: "Enviar solicitação" }).click();
    const requested = await requestPromise;
    expect(requested.status()).toBe(201);
    const requestId = String((await requested.json() as { data: { requestId: string } }).data.requestId);
    await expect(destinationPage.getByText("Pendente", { exact: true }).first()).toBeVisible();
    await expect.poll(() => destinationPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const sourcePage = await sourceContext.newPage();
    await loginPdv(sourcePage, "vendedor.teste", "Vendedor123!");
    await sourcePage.getByRole("button", { name: "Transferências" }).click();
    const card = sourcePage.locator("section").filter({ hasText: "Solicitações para o seu estoque" }).locator("div.space-y-3 > div").filter({ hasText: "Reposição para atendimento no evento" });
    await expect(card).toBeVisible();
    await card.getByLabel("Motivo da decisão").fill("Saldo conferido e separado");
    const acceptPromise = sourcePage.waitForResponse((response) => response.url().endsWith(`/api/v1/inventory/transfer-requests/${requestId}`) && response.request().method() === "PATCH");
    await card.getByRole("button", { name: "Aceitar" }).click();
    const accepted = await acceptPromise;
    expect(accepted.status()).toBe(200);
    const acceptedBody = await accepted.json() as { data: { movementId: string } };
    transferMovementId = acceptedBody.data.movementId;
    await expect(card.getByText("Aceita", { exact: true })).toBeVisible();

    expect(await database.balance(sourceLocationId)).toEqual({ on_hand_quantity: sourceBefore.on_hand_quantity + missing - 2, reserved_quantity: 0 });
    expect(await database.balance(destinationLocationId)).toEqual({ on_hand_quantity: destinationBefore.on_hand_quantity + 2, reserved_quantity: destinationBefore.reserved_quantity });

    const consumer = await browser.newContext();
    try {
      expect((await consumer.request.post(`${portal}/api/auth/login`, {
        headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" },
        data: { identifier: "consumidor.teste", password: "Consumidor123!" },
      })).status()).toBe(200);
      const denied = await consumer.request.post(`${portal}/api/v1/inventory/transfer-requests`, {
        headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `consumer-transfer:${crypto.randomUUID()}` },
        data: { fromLocationId: sourceLocationId, productId, quantity: 1, reason: "Tentativa sem autorização" },
      });
      expect(denied.status()).toBe(403);
    } finally { await consumer.close(); }
  } finally {
    await destinationContext.close().catch(() => undefined); await sourceContext.close().catch(() => undefined);
    if (transferMovementId) await database.rpc("reverse_stock_movement", {
      p_movement_id: transferMovementId, p_reason: "Limpeza da transferência E2E",
      p_idempotency_key: `e2e-seller-transfer-reverse:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID(),
    });
    if (adjustmentId) await database.rpc("reverse_stock_movement", {
      p_movement_id: adjustmentId, p_reason: "Limpeza da preparação E2E",
      p_idempotency_key: `e2e-seller-transfer-adjust-reverse:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID(),
    });
  }
});
