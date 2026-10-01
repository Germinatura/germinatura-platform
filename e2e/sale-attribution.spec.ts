import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const productId = "33f00000-0000-4000-8000-000000000001";

// Ensures the seller location has at least one available unit; the confirmed sale consumes it.
async function ensureSellerStock() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para preparar o estoque E2E");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const balances = await fetch(`${url}/rest/v1/inventory_balances?select=available_quantity&location_id=eq.${sellerLocationId}&product_id=eq.${productId}`, { headers });
  const [balance] = await balances.json() as Array<{ available_quantity: number }>;
  if ((balance?.available_quantity ?? 0) >= 1) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers, body: JSON.stringify({
    p_location_id: sellerLocationId, p_product_id: productId, p_quantity_delta: 1 - (balance?.available_quantity ?? 0),
    p_reason: "Preparar venda atribuída E2E", p_idempotency_key: `e2e-attribution-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

test("vendedor cria o próprio link, atribui uma venda paga e a comunicação vê o resultado", async ({ browser }) => {
  test.slow();
  await ensureSellerStock();
  const tag = Date.now().toString(36);
  const title = `Grupo da turma ${tag}`;
  const seller = await (await browser.newContext()).newPage();
  expect((await seller.request.post(`${pdvUrl}/api/auth/login`, { headers: { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" },
    data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  await seller.goto(`${pdvUrl}/`);
  await expect(seller.getByRole("heading", { name: "Nova venda" })).toBeVisible({ timeout: 90_000 });

  await seller.getByRole("button", { name: "Divulgação" }).click();
  const form = seller.getByRole("form", { name: "Novo link" });
  await form.getByLabel("Nome do link").fill(title);
  await form.getByRole("button", { name: "Criar link" }).click();
  await expect(seller.getByText("Link criado.")).toBeVisible({ timeout: 60_000 });
  const link = seller.getByRole("listitem", { name: title });
  await expect(link.getByRole("img", { name: `QR Code do link ${title}` })).toBeVisible();
  await expect(link.getByText(/\/d\/[a-z0-9]{8}$/)).toBeVisible();

  // A cash sale, then the origin chosen on the confirmation screen.
  await seller.getByRole("button", { name: "Meu turno" }).click();
  const openShift = seller.getByRole("button", { name: "Abrir turno" });
  await expect(openShift.or(seller.getByRole("heading", { name: "Turno aberto" }))).toBeVisible();
  if (await openShift.isVisible()) {
    await seller.getByLabel("Fundo de troco (R$)").fill("10,00");
    await openShift.click();
  }
  await expect(seller.getByRole("heading", { name: "Turno aberto" })).toBeVisible();
  await seller.getByRole("button", { name: "Operação" }).click();
  await seller.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
  await seller.getByRole("button", { name: "Revisar venda" }).click();
  await seller.getByRole("button", { name: /^Cobrar/ }).click();
  await seller.getByRole("button", { name: /Dinheiro/ }).click();
  await seller.getByLabel("Valor recebido (R$)").fill("50,00");
  await seller.getByRole("button", { name: "Registrar recebimento em dinheiro" }).click();
  await expect(seller.getByRole("heading", { name: "Venda concluída" })).toBeVisible();
  const origin = seller.getByLabel("O cliente veio por uma divulgação? (opcional)");
  await expect(origin).toBeVisible({ timeout: 60_000 });
  await origin.selectOption({ label: `Meu link: ${title}` });
  await seller.getByRole("button", { name: "Registrar origem" }).click();
  await expect(seller.getByText(`Origem registrada: ${title}.`)).toBeVisible();

  await seller.getByRole("button", { name: "Divulgação" }).click();
  await expect(seller.getByRole("listitem", { name: title }).getByText(/^1 venda\(s\) paga\(s\)/)).toBeVisible({ timeout: 60_000 });
  await seller.context().close();

  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  const campaigns = await admin.request.get(`${portalUrl}/api/v1/admin/share-campaigns`);
  expect(campaigns.status()).toBe(200);
  const mine = (await campaigns.json() as { data: { title: string; sellerName: string | null; paidSales: number }[] }).data.find((item) => item.title === title);
  expect(mine?.sellerName).toBeTruthy();
  expect(mine?.paidSales).toBe(1);
  await admin.context().close();
});
