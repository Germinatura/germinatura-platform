import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const centralLocationId = "50000000-0000-4000-8000-000000000001";
const productId = "33f00000-0000-4000-8000-000000000001";
const headers = { Origin: portalUrl };

// Ensures the central location has two available units for the cart reservation.
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
  if ((balance?.available_quantity ?? 0) >= 2) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers: auth, body: JSON.stringify({
    p_location_id: centralLocationId, p_product_id: productId, p_quantity_delta: 2 - (balance?.available_quantity ?? 0),
    p_reason: "Preparar carrinho E2E", p_idempotency_key: `e2e-cart-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque central");
}

test("o consumidor monta o carrinho no catálogo e reserva pelo preço calculado no servidor", async ({ page }) => {
  test.slow();
  await ensureCentralStock();
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/catalogo`);
  await expect(page.getByRole("heading", { name: "Item público A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Adicionar Item público B à reserva" })).toHaveCount(0);

  const add = page.getByRole("button", { name: "Adicionar Item público A à reserva" });
  await add.click();
  await add.click();
  const cart = page.locator("[aria-label='Carrinho de reserva']");
  await expect(cart.getByLabel("Quantidade de Item público A")).toHaveText("2");

  // The cart survives a reload in the same tab.
  await page.reload();
  await expect(page.locator("[aria-label='Carrinho de reserva']").getByLabel("Quantidade de Item público A")).toHaveText("2");
  const total = page.locator("[aria-label='Carrinho de reserva'] dl").getByText(/R\$/).last();
  await expect(total).toBeVisible();

  const created = page.waitForResponse((response) => response.url().endsWith("/api/v1/reservations") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Reservar" }).click();
  expect((await created).status()).toBe(201);
  await expect(page.getByRole("heading", { name: "Reserva criada" })).toBeVisible();
  await page.getByRole("link", { name: "Ver minhas reservas" }).click();
  await expect(page).toHaveURL(/\/reservas$/);
  await expect(page.getByText("2 unidades").first()).toBeVisible();
});
