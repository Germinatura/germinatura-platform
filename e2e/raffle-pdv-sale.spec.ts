import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };

async function admin<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<T> {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para o E2E de rifas no PDV");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(`${name}: ${result.message ?? response.status}`);
  return result;
}

test("o vendedor vende números para comprador sem cadastro e libera a reserva de um cliente cadastrado", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const name = `Rifa PDV ${Date.now().toString(36)}`;
  const campaign = await admin<{ campaign_id: string }>("create_raffle_campaign", {
    p_name: name, p_product_id: "33f00000-0000-4000-8000-000000000001", p_location_id: "50000000-0000-4000-8000-000000000001",
    p_number_count: 30, p_starts_at: new Date(Date.now() - 60_000).toISOString(), p_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    p_idempotency_key: `e2e-raffle-pdv-create-${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID(),
  });
  await admin("transition_raffle_campaign", { p_campaign_id: campaign.campaign_id, p_action: "PUBLISH",
    p_idempotency_key: `e2e-raffle-pdv-publish-${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() });

  // A consumer holds number 5 online first: the PDV must show it as unavailable.
  const consumer = await browser.newContext({ baseURL: portalUrl });
  expect((await consumer.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
  expect((await consumer.request.post(`/api/v1/raffles/${campaign.campaign_id}/numbers/reserve`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-raffle-pdv-online-${crypto.randomUUID()}` }, data: { numbers: [5] } })).status()).toBe(201);
  await consumer.close();

  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Rifas", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const board = page.getByRole("group", { name: `Números de ${name}` });
  await expect(board.getByRole("button", { name: "Número 5 indisponível" })).toBeDisabled();

  // Walk-in buyer: name and contact, paid through the Área Pix.
  await board.getByRole("button", { name: "Número 3", exact: true }).click();
  await board.getByRole("button", { name: "Número 4", exact: true }).click();
  await page.getByRole("button", { name: "Sem cadastro" }).click();
  await page.getByLabel("Nome do comprador").fill("Comprador Balcão");
  await page.getByLabel("Telefone ou e-mail").fill("(11) 98888-7777");
  await page.getByRole("button", { name: "Reservar números" }).click();
  await expect(page.getByRole("heading", { name: "Números 3, 4" })).toBeVisible();
  await page.getByRole("button", { name: "Área Pix" }).click();
  await page.getByLabel("Referência não sensível do comprovante").fill(`PIX-${Date.now().toString(36)}`);
  const confirmation = page.waitForResponse((response) => response.url().endsWith("/payments/manual-confirmation"));
  await page.getByRole("button", { name: "Confirmar recebimento manualmente" }).click();
  expect((await confirmation).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Venda de rifa confirmada" })).toBeVisible();

  // Registered buyer found by exact username; the seller cancels and the number returns to the board.
  await page.getByRole("button", { name: "Nova venda de rifa" }).click();
  await expect(board.getByRole("button", { name: "Número 3 indisponível" })).toBeDisabled();
  await board.getByRole("button", { name: "Número 10", exact: true }).click();
  await page.getByRole("button", { name: "Cliente com cadastro" }).click();
  await page.getByLabel("E-mail ou usuário do comprador").fill("consumidor.teste");
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByText("Comprador:")).toBeVisible();
  await page.getByRole("button", { name: "Reservar números" }).click();
  await expect(page.getByRole("heading", { name: "Números 10" })).toBeVisible();
  await page.getByRole("button", { name: "Cancelar e liberar números" }).click();
  await expect(board.getByRole("button", { name: "Número 10", exact: true })).toBeEnabled();
});
