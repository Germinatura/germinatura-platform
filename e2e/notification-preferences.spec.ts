// Runs after foundation.spec.ts on purpose: it drains the outbox, which gives the admin new notices.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const headers = { Origin: portalUrl };
const centralLocationId = "50000000-0000-4000-8000-000000000001";
const productId = "33f00000-0000-4000-8000-000000000001";

function localSupabase() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const publishable = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  const service = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !publishable || !service || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Supabase local indisponível");
  return { url, publishable, service };
}

// Sets the central stock of the product to an exact available quantity through the ledger.
async function setCentralStock(target: number) {
  const { url, publishable } = localSupabase();
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: publishable, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const auth = { apikey: publishable, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const balances = await fetch(`${url}/rest/v1/inventory_balances?select=available_quantity&location_id=eq.${centralLocationId}&product_id=eq.${productId}`, { headers: auth });
  const [balance] = await balances.json() as Array<{ available_quantity: number }>;
  const delta = target - (balance?.available_quantity ?? 0);
  if (delta === 0) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers: auth, body: JSON.stringify({
    p_location_id: centralLocationId, p_product_id: productId, p_quantity_delta: delta,
    p_reason: "Preparar avise-me E2E", p_idempotency_key: `e2e-alert-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível ajustar o estoque central");
}

// Runs the outbox worker once with the local service role, as apps/jobs does in staging.
async function processOutbox() {
  const { url, service } = localSupabase();
  const auth = { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" };
  const worker = `e2e-worker-${Date.now().toString(36)}`;
  for (let round = 0; round < 50; round += 1) {
    const claimed = await fetch(`${url}/rest/v1/rpc/worker_claim_outbox_events`, { method: "POST", headers: auth,
      body: JSON.stringify({ p_worker_id: worker, p_batch_size: 100, p_lease_seconds: 300 }) });
    const events = await claimed.json() as Array<{ id: string }>;
    if (!Array.isArray(events) || events.length === 0) return;
    for (const event of events) {
      await fetch(`${url}/rest/v1/rpc/worker_process_outbox_event`, { method: "POST", headers: auth,
        body: JSON.stringify({ p_event_id: event.id, p_worker_id: worker }) });
    }
  }
}

test("o consumidor pede aviso de um produto indisponível e é avisado quando ele volta", async ({ page }) => {
  test.slow();
  await setCentralStock(0);
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
  // Start from announcements enabled, whatever an earlier run left behind (retrying while next dev compiles).
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await page.request.put(`${portalUrl}/api/v1/notifications/preferences`, { headers, data: { category: "COMUNICADOS", enabled: true } })).status() === 200) break;
    await page.waitForTimeout(500);
  }
  await page.goto(`${portalUrl}/catalogo`);
  const card = page.getByRole("region", { name: "Produtos do catálogo" }).locator("> *").filter({ has: page.getByRole("heading", { name: "Item público A" }) });
  await expect(card.getByText("Indisponível")).toBeVisible();
  await expect(card.getByRole("button", { name: "Adicionar Item público A à reserva" })).toHaveCount(0);
  await card.getByRole("button", { name: "Avise-me quando voltar" }).click();
  await expect(card.getByRole("button", { name: "Aviso ativado" })).toBeVisible();

  await setCentralStock(1);
  await processOutbox();
  // next dev compiles routes on first use and may answer 404 meanwhile.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await page.request.get(`${portalUrl}/api/v1/notifications/preferences`)).status() === 200) break;
    await page.waitForTimeout(500);
  }
  await page.goto(`${portalUrl}/notificacoes`);
  await expect(page.getByText("Item público A voltou ao estoque. Reserve pelo catálogo.").first()).toBeVisible();

  // Preferences: silencing announcements is saved, then restored for the other suites.
  const preferences = page.locator("[aria-label='Preferências de notificação']");
  const announcements = preferences.getByLabel(/Comunicados da comissão/);
  await expect(announcements).toBeEnabled();
  await expect(announcements).toBeChecked();
  const silenced = page.waitForResponse((response) => response.url().endsWith("/api/v1/notifications/preferences") && response.request().method() === "PUT");
  await announcements.uncheck();
  expect((await silenced).status()).toBe(200);
  await expect(announcements).not.toBeChecked();
  const saved = await page.request.get(`${portalUrl}/api/v1/notifications/preferences`);
  expect(((await saved.json()).data as Array<{ category: string; enabled: boolean }>).find((item) => item.category === "COMUNICADOS")?.enabled).toBe(false);
  const restored = page.waitForResponse((response) => response.url().endsWith("/api/v1/notifications/preferences") && response.request().method() === "PUT");
  await announcements.check();
  expect((await restored).status()).toBe(200);
  await expect(announcements).toBeChecked();
  // Other suites expect the consumer to receive announcements.
  expect((await page.request.put(`${portalUrl}/api/v1/notifications/preferences`, { headers, data: { category: "COMUNICADOS", enabled: true } })).status()).toBe(200);
});
