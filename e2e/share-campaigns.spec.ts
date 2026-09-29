import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const centralLocationId = "50000000-0000-4000-8000-000000000001";
const productId = "33f00000-0000-4000-8000-000000000001";
const headers = { Origin: portalUrl };

// Ensures the central location has one available unit for the attributed reservation.
async function ensureCentralStock() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para preparar o estoque E2E");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const auth = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const balances = await fetch(`${url}/rest/v1/inventory_balances?select=available_quantity&location_id=eq.${centralLocationId}&product_id=eq.${productId}`, { headers: auth });
  const [balance] = await balances.json() as Array<{ available_quantity: number }>;
  if ((balance?.available_quantity ?? 0) >= 1) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers: auth, body: JSON.stringify({
    p_location_id: centralLocationId, p_product_id: productId, p_quantity_delta: 1 - (balance?.available_quantity ?? 0),
    p_reason: "Preparar divulgação E2E", p_idempotency_key: `e2e-share-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque central");
}

test("a comunicação cria uma divulgação rastreável e vê a visita e a reserva que ela trouxe", async ({ page, browser }) => {
  test.slow();
  await ensureCentralStock();
  const tag = Date.now().toString(36);
  const title = `Doces da semana ${tag}`;
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/comunicacao/divulgacao`);
  const form = page.getByRole("form", { name: "Nova divulgação" });
  // Products arrive from the client-side load, so their presence means the form is hydrated.
  await expect(form.getByLabel("Item público A")).toBeVisible();
  await form.getByLabel("Título").fill(title);
  await form.getByLabel("Item público A").check();
  await form.getByRole("button", { name: "Criar divulgação" }).click();
  await expect(page.getByText("Divulgação criada.")).toBeVisible();
  const item = page.getByRole("listitem", { name: `Divulgação ${title}` });
  const text = await item.getByLabel("Texto da divulgação").inputValue();
  expect(text).toContain(`*${title}*`);
  expect(text).toContain("• Item público A — R$ 25,90");
  const link = text.match(/https?:\/\/\S+\/d\/[a-z0-9]{8}/)?.[0];
  expect(link).toBeTruthy();
  await expect(item.getByLabel(`QR Code da divulgação ${title}`)).toBeVisible();

  // A consumer follows the link (the visit is counted and the origin kept) and then reserves.
  const consumer = await browser.newContext({ baseURL: portalUrl });
  const consumerPage = await consumer.newPage();
  const visit = await consumerPage.request.get(link ?? "", { maxRedirects: 0 });
  expect(visit.status()).toBe(307);
  expect(visit.headers()["location"]).toContain("/catalogo");
  expect((await consumerPage.request.post("/api/auth/login", { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
  expect((await consumerPage.request.post("/api/v1/reservations", { headers: { ...headers, "Idempotency-Key": `e2e-share-res-${tag}` },
    data: { items: [{ productId, quantity: 1 }] } })).status()).toBe(201);
  await consumer.close();

  const campaigns = await page.request.get(`${portalUrl}/api/v1/admin/share-campaigns`);
  const campaign = ((await campaigns.json()).data as Array<{ title: string; visits: number; reservations: number }>).find((row) => row.title === title);
  expect(campaign).toMatchObject({ visits: 1, reservations: 1 });
});
