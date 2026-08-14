import { expect, test } from "@playwright/test";

const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";

test("Portal and PDV expose independent health endpoints", async ({ request }) => {
  const portal = await request.get("/api/v1/health");
  await expect(portal).toBeOK();
  await expect(portal.json()).resolves.toMatchObject({ service: "portal", status: "ok" });

  const pdv = await request.get(`${pdvUrl}/api/v1/health`);
  await expect(pdv).toBeOK();
  await expect(pdv.json()).resolves.toMatchObject({ service: "pdv", status: "ok" });
});

test("Unauthenticated users are redirected to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("Administrator can enter the Portal", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("admin@germinatura.test");
  await page.locator('input[type="password"]').fill("Admin123!");
  await page.getByRole("button", { name: /Entrar na Plataforma/i }).click();
  await expect(page).toHaveURL(/http:\/\/127\.0\.0\.1:3000\/$/);

  const session = await page.request.get("/api/v1/auth/session");
  await expect(session).toBeOK();
  await expect(session.json()).resolves.toMatchObject({
    user: { perfil: "ADMIN", legacyUserId: "legacy-local-admin" },
  });

  await page.goto("/configuracoes/usuarios");
  await expect(page).toHaveURL(/\/configuracoes\/usuarios$/);

  await page.goto(`${pdvUrl}/`);
  await page.getByTitle("Voltar ao Painel").click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/");
});

test("Administrator leaving the PDV logs back into the Portal by default", async ({ page }) => {
  await page.goto(`${pdvUrl}/login`);
  await page.locator('input[type="email"]').fill("admin@germinatura.test");
  await page.locator('input[type="password"]').fill("Admin123!");
  await page.getByRole("button", { name: /Entrar na Plataforma/i }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/");

  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Sair do PDV" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/login");
  expect((await page.request.get("/api/v1/auth/session")).status()).toBe(401);
  await page.waitForLoadState("networkidle");

  const emailInput = page.locator('input[type="email"]');
  const passwordInput = page.locator('input[type="password"]');
  await emailInput.fill("admin@germinatura.test");
  await passwordInput.fill("Admin123!");
  await expect(emailInput).toHaveValue("admin@germinatura.test");
  await expect(passwordInput).toHaveValue("Admin123!");
  await page.getByRole("button", { name: /Entrar na Plataforma/i }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/");
});

test("Consumer is routed to reservations and cannot enter the PDV", async ({ browser }) => {
  const portalContext = await browser.newContext();
  const portalPage = await portalContext.newPage();
  await portalPage.goto("http://127.0.0.1:3000/login");
  await portalPage.locator('input[type="email"]').fill("consumer@germinatura.test");
  await portalPage.locator('input[type="password"]').fill("Consumer123!");
  await portalPage.getByRole("button", { name: /Entrar na Plataforma/i }).click();
  await expect(portalPage).toHaveURL(/\/reservas$/);
  await portalPage.goto("http://127.0.0.1:3000/configuracoes/usuarios");
  await expect(portalPage).toHaveURL(/\/reservas$/);
  await portalContext.close();

  const pdvContext = await browser.newContext();
  const pdvPage = await pdvContext.newPage();
  await pdvPage.goto(`${pdvUrl}/login`);
  await pdvPage.locator('input[type="email"]').fill("consumer@germinatura.test");
  await pdvPage.locator('input[type="password"]').fill("Consumer123!");
  await pdvPage.getByRole("button", { name: /Entrar na Plataforma/i }).click();
  await expect(pdvPage).toHaveURL(new RegExp(`${pdvUrl.replaceAll(".", "\\.")}\/login$`));
  await pdvContext.close();
});

test("Seller can enter the PDV", async ({ page }) => {
  await page.goto(`${pdvUrl}/login`);
  await page.locator('input[type="email"]').fill("vendedor@germinatura.test");
  await page.locator('input[type="password"]').fill("Vendedor123!");
  await page.getByRole("button", { name: /Entrar na Plataforma/i }).click();
  await expect(page).toHaveURL(new RegExp(`${pdvUrl.replaceAll(".", "\\.")}\/$`));

  await page.goto("http://127.0.0.1:3000/configuracoes/usuarios");
  await expect(page).toHaveURL("http://127.0.0.1:3000/");
});

test("Logout and an expired bearer session are rejected", async ({ page, request }) => {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("admin@germinatura.test");
  await page.locator('input[type="password"]').fill("Admin123!");
  await page.getByRole("button", { name: /Entrar na Plataforma/i }).click();
  await expect(page).toHaveURL(/http:\/\/127\.0\.0\.1:3000\/$/);

  const logoutStatus = await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).status);
  expect(logoutStatus).toBe(200);
  expect((await page.request.get("/api/v1/auth/session")).status()).toBe(401);

  const expired = await request.get("/api/v1/auth/session", {
    headers: { Authorization: "Bearer expired.fixture.token" },
  });
  expect(expired.status()).toBe(401);
});

test("Unsigned payment webhook stays disabled", async ({ request }) => {
  const response = await request.post("/api/webhooks/abacatepay", {
    data: { event: "BILLING_PAID" },
  });
  expect(response.status()).toBe(503);
  await expect(response.json()).resolves.toMatchObject({ code: "PAYMENTS_DISABLED" });
});
