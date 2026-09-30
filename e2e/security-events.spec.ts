import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";

test("login recusado e acesso negado ficam no registro de segurança da auditoria", async ({ page, browser }) => {
  test.slow();
  const visitor = await browser.newContext({ baseURL: portalUrl });
  expect((await visitor.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "consumidor.teste", password: "SenhaErrada123!" } })).status()).toBe(401);
  await visitor.close();

  const seller = await browser.newContext({ baseURL: portalUrl });
  expect((await seller.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  expect((await seller.request.get("/api/v1/admin/finance/indicators?from=2026-01-01&to=2026-01-31")).status()).toBe(403);
  await seller.close();

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/auditoria`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Segurança" }).click();
  const filters = page.getByRole("form", { name: "Filtrar eventos de segurança" });
  const events = page.getByRole("list", { name: "Eventos de segurança" });

  await filters.getByLabel("Evento").selectOption({ label: "Acesso negado" });
  await filters.getByLabel("Usuário ou identificador").fill("vendedor");
  const denied = page.waitForResponse((response) => response.url().includes("kind=AUTHORIZATION_DENIED") && response.ok());
  await filters.getByRole("button", { name: "Pesquisar" }).click();
  await denied;
  await expect(events.getByText("GET /api/v1/admin/finance/indicators").first()).toBeVisible();

  await filters.getByLabel("Evento").selectOption({ label: "Login recusado" });
  await filters.getByLabel("Usuário ou identificador").fill("consumidor");
  const refused = page.waitForResponse((response) => response.url().includes("kind=LOGIN_FAILED") && response.ok());
  await filters.getByRole("button", { name: "Pesquisar" }).click();
  await refused;
  await expect(events.getByRole("listitem").first()).toContainText("Login recusado");
});
