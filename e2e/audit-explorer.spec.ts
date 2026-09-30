import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";

async function admin<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<T> {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para o E2E de auditoria");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(`${name}: ${result.message ?? response.status}`);
  return result;
}

test("o administrador investiga uma ação pela correlação; o vendedor não acessa a auditoria", async ({ page, browser }) => {
  test.slow();
  const correlationId = crypto.randomUUID();
  await admin("create_raffle_campaign", {
    p_name: `Rifa auditoria ${Date.now().toString(36)}`, p_product_id: "33f00000-0000-4000-8000-000000000001", p_location_id: "50000000-0000-4000-8000-000000000001",
    p_number_count: 5, p_starts_at: new Date(Date.now() - 60_000).toISOString(), p_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    p_idempotency_key: `e2e-audit-${correlationId}`, p_correlation_id: correlationId,
  });

  const seller = await browser.newContext({ baseURL: portalUrl });
  expect((await seller.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  expect((await seller.request.get(`/api/v1/admin/audit/correlations/${correlationId}`)).status()).toBe(403);
  await seller.close();

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/auditoria`);
  await expect(page.getByRole("main").getByRole("heading", { name: "Auditoria", level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const filters = page.getByRole("form", { name: "Filtrar auditoria" });
  await filters.getByLabel("Correlação").fill(correlationId);
  await filters.getByRole("button", { name: "Pesquisar" }).click();
  const entry = page.getByRole("list", { name: "Registros de auditoria" }).getByRole("listitem", { name: /raffles\.campaign\.created/ });
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Ver correlação" }).click();
  await expect(page.getByRole("region", { name: "Ações auditadas" })).toContainText("raffles.campaign.created");
  await expect(page.getByText(correlationId, { exact: true })).toBeVisible();
});
