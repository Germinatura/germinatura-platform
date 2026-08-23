import { expect, test } from "@playwright/test";

const portalUrl = "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";

async function login(page: import("@playwright/test").Page, email: string, password: string) {
  await page.waitForLoadState("networkidle");
  const emailInput = page.locator('input[type="email"]');
  const passwordInput = page.locator('input[type="password"]');
  await emailInput.fill(email);
  await passwordInput.fill(password);
  await expect(emailInput).toHaveValue(email);
  await expect(passwordInput).toHaveValue(password);
  const loginResponse = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return response.request().method() === "POST" && (path === "/api/auth/login" || path === "/auth/v1/token");
  });
  await page.getByRole("button", { name: /Entrar na Plataforma/i }).click();
  expect((await loginResponse).status()).toBe(200);
}

test("Portal and PDV expose minimal independent health endpoints", async ({ request }) => {
  const portal = await request.get("/api/v1/health");
  await expect(portal).toBeOK();
  await expect(portal.json()).resolves.toEqual({ service: "portal", status: "ok" });

  const pdv = await request.get(`${pdvUrl}/api/v1/health`);
  await expect(pdv).toBeOK();
  await expect(pdv.json()).resolves.toEqual({ service: "pdv", status: "ok" });
  for (const response of [portal, pdv]) {
    expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(response.headers()["permissions-policy"]).toContain("camera=()");
  }
});

test("API allowlist enforces methods, authentication and CSRF origin", async ({ request }) => {
  const method = await request.get("/api/auth/login");
  expect(method.status()).toBe(405);
  expect(method.headers().allow).toBe("POST");

  const missingOrigin = await request.post("/api/auth/login", {
    data: { email: "admin@germinatura.test", password: "Admin123!" },
  });
  expect(missingOrigin.status()).toBe(403);

  const crossOrigin = await request.post("/api/auth/login", {
    headers: { Origin: "https://malicious.invalid", "Sec-Fetch-Site": "cross-site" },
    data: { email: "admin@germinatura.test", password: "Admin123!" },
  });
  expect(crossOrigin.status()).toBe(403);

  const protectedMutation = await request.post("/api/auth/reset-password", {
    headers: { Origin: portalUrl },
    data: { novaSenha: "Example123!" },
  });
  expect(protectedMutation.status()).toBe(401);
});

test("Unauthenticated page and API access are blocked", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  expect((await request.get("/api/v1/auth/session")).status()).toBe(401);
});

test("Administrator enters the Portal and can navigate through the PDV", async ({ page }) => {
  await page.goto("/login");
  await login(page, "admin@germinatura.test", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);
  await expect(page.getByText("Fundação v2.1 greenfield")).toBeVisible();

  const session = await page.request.get("/api/v1/auth/session");
  await expect(session).toBeOK();
  const sessionBody = await session.json();
  expect(sessionBody).toMatchObject({ user: { perfil: "ADMIN", roles: ["ADMIN"] } });
  const sessionText = JSON.stringify(sessionBody);
  expect(sessionText).not.toContain("access_token");
  expect(sessionText).not.toContain("refresh_token");

  await page.goto(`${pdvUrl}/`);
  await page.getByTitle("Voltar ao Painel").click();
  await expect(page).toHaveURL(`${portalUrl}/`);
});

test("Administrator leaving the PDV can log back into the Portal", async ({ page }) => {
  await page.goto(`${pdvUrl}/login`);
  await login(page, "admin@germinatura.test", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);

  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Sair do PDV" }).click();
  await expect(page).toHaveURL(`${portalUrl}/login`);
  expect((await page.request.get("/api/v1/auth/session")).status()).toBe(401);

  await page.waitForLoadState("networkidle");
  await login(page, "admin@germinatura.test", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);
});

test("Consumer enters only the Portal foundation and is rejected by the PDV", async ({ browser }) => {
  const portalContext = await browser.newContext();
  const portalPage = await portalContext.newPage();
  await portalPage.goto(`${portalUrl}/login`);
  await login(portalPage, "consumidor@germinatura.test", "Consumidor123!");
  await expect(portalPage).toHaveURL(`${portalUrl}/`);
  await expect(portalPage.getByText("Consumidor", { exact: true })).toBeVisible();
  await portalContext.close();

  const pdvContext = await browser.newContext();
  const pdvPage = await pdvContext.newPage();
  await pdvPage.goto(`${pdvUrl}/login`);
  await login(pdvPage, "consumidor@germinatura.test", "Consumidor123!");
  await expect(pdvPage).toHaveURL(new RegExp(`${pdvUrl.replaceAll(".", "\\.")}\/login$`));
  await expect(pdvPage.getByText("Seu perfil não possui acesso ao PDV")).toBeVisible();
  await pdvContext.close();
});

test("Seller enters the PDV and cannot use a consumer-only bypass", async ({ page }) => {
  await page.goto(`${pdvUrl}/login`);
  await login(page, "vendedor@germinatura.test", "Vendedor123!");
  await expect(page).toHaveURL(`${pdvUrl}/`);
  await expect(page.getByText("Acesso autorizado")).toBeVisible();

  await page.goto(`${portalUrl}/`);
  await expect(page).toHaveURL(`${portalUrl}/`);
  await expect(page.getByText("Vendedor", { exact: true })).toBeVisible();
});

test("Logout and an expired bearer session are rejected", async ({ page, request }) => {
  await page.goto("/login");
  await login(page, "admin@germinatura.test", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);

  const logoutStatus = await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).status);
  expect(logoutStatus).toBe(200);
  expect((await page.request.get("/api/v1/auth/session")).status()).toBe(401);

  const expired = await request.get("/api/v1/auth/session", { headers: { Authorization: "Bearer expired.fixture.token" } });
  expect(expired.status()).toBe(401);
});

test("Removed legacy domains are not exposed as functional APIs", async ({ page }) => {
  await page.goto("/login");
  await login(page, "admin@germinatura.test", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);
  const status = await page.evaluate(async () => (await fetch("/api/produtos")).status);
  expect(status).toBe(404);
});
