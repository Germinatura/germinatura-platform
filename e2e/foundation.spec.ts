import { expect, test } from "@playwright/test";

const portalUrl = "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";

async function login(page: import("@playwright/test").Page, email: string, password: string) {
  const origin = new URL(page.url()).origin;
  const route = origin === pdvUrl ? "/api/auth/test-login" : "/api/auth/login";
  const loginResponse = await page.request.post(`${origin}${route}`, {
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
    data: { email, password },
  });
  expect(loginResponse.status()).toBe(200);
  await page.goto(origin === pdvUrl && email.startsWith("admin.") ? `${portalUrl}/` : `${origin}/`);
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
    data: { email: "admin.teste@institutojef.org.br", password: "Admin123!" },
  });
  expect(missingOrigin.status()).toBe(403);

  const crossOrigin = await request.post("/api/auth/login", {
    headers: { Origin: "https://malicious.invalid", "Sec-Fetch-Site": "cross-site" },
    data: { email: "admin.teste@institutojef.org.br", password: "Admin123!" },
  });
  expect(crossOrigin.status()).toBe(403);

  const protectedMutation = await request.post("/api/auth/reset-password", {
    headers: { Origin: portalUrl },
    data: { novaSenha: "Example123!" },
  });
  expect(protectedMutation.status()).toBe(401);
});

test("Institutional OTP creates only a consumer session and rejects external domains", async ({ page, request }) => {
  const external = await request.post("/api/v1/auth/otp/request", {
    headers: { Origin: portalUrl, "Sec-Fetch-Site": "same-origin" },
    data: { email: "pessoa@example.org" },
  });
  expect(external.status()).toBe(422);

  const email = `otp.e2e.${Date.now()}@institutojef.org.br`;
  await page.goto("/login");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByLabel("Email institucional").fill(email);
  const requested = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/otp/request");
  await page.getByRole("button", { name: "Receber código" }).click();
  expect((await requested).status()).toBe(202);

  let otpCode = "";
  await expect.poll(async () => {
    const mailbox = await request.get("http://127.0.0.1:54325/api/v1/messages");
    const body = await mailbox.json() as { messages: Array<{ To: Array<{ Address: string }>; Snippet: string }> };
    const message = body.messages.find((candidate) => candidate.To.some((recipient) => recipient.Address === email));
    otpCode = message?.Snippet.match(/\b\d{6}\b/)?.[0] ?? "";
    return otpCode;
  }, { timeout: 10_000 }).toMatch(/^\d{6}$/);

  await page.getByLabel("Código de 6 dígitos").fill(otpCode);
  const verified = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/otp/verify");
  await page.getByRole("button", { name: "Confirmar código" }).click();
  expect((await verified).status()).toBe(200);
  await expect(page).toHaveURL(`${portalUrl}/`);
  await expect(page.getByText("Consumidor", { exact: true })).toBeVisible();
});

test("Public catalog is bounded, paginated and restricted to the anonymous RLS view", async ({ page, request }) => {
  const invalidLimit = await request.get("/api/v1/catalog/products?limit=51");
  expect(invalidLimit.status()).toBe(422);
  await expect(invalidLimit.json()).resolves.toMatchObject({ code: "INVALID_QUERY" });

  const invalidCursor = await request.get("/api/v1/catalog/products?cursor=not-a-uuid");
  expect(invalidCursor.status()).toBe(422);

  const method = await request.post("/api/v1/catalog/products");
  expect(method.status()).toBe(405);
  expect(method.headers().allow).toBe("GET");

  const firstPage = await request.get("/api/v1/catalog/products?limit=1");
  await expect(firstPage).toBeOK();
  const firstBody = await firstPage.json();
  expect(firstBody).toMatchObject({
    data: [{ sku: "PUBLIC-ITEM-A", price: { amountCents: 2590, currency: "BRL" } }],
  });
  expect(firstBody.data).toHaveLength(1);
  expect(firstBody.nextCursor).toBe(firstBody.data[0].id);
  expect(firstPage.headers()["x-request-id"]).toBe(firstBody.request_id);

  const secondPage = await request.get(`/api/v1/catalog/products?limit=1&cursor=${firstBody.nextCursor}`);
  await expect(secondPage).toBeOK();
  await expect(secondPage.json()).resolves.toMatchObject({
    data: [{ sku: "PUBLIC-ITEM-B" }],
    nextCursor: null,
  });

  await page.goto("/login");
  await login(page, "admin.teste@institutojef.org.br", "Admin123!");
  const authenticatedResponse = await page.request.get("/api/v1/catalog/products?limit=50");
  await expect(authenticatedResponse).toBeOK();
  const authenticatedBody = await authenticatedResponse.json();
  expect(authenticatedBody.data.map((product: { sku: string }) => product.sku)).toEqual([
    "PUBLIC-ITEM-A",
    "PUBLIC-ITEM-B",
  ]);
});

test("Unauthenticated page and API access are blocked", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  expect((await request.get("/api/v1/auth/session")).status()).toBe(401);
});

test("Pricing quote rejects client totals and calculates public prices server-side", async ({ request }) => {
  const productId = "33f00000-0000-4000-8000-000000000001";
  const tampered = await request.post("/api/v1/pricing/quote", {
    headers: { Origin: portalUrl },
    data: { channel: "PORTAL", items: [{ productId, quantity: 2 }], totalCents: 1 },
  });
  expect(tampered.status()).toBe(422);
  await expect(tampered.json()).resolves.toMatchObject({ code: "INVALID_QUOTE" });

  const response = await request.post("/api/v1/pricing/quote", {
    headers: { Origin: portalUrl },
    data: { channel: "PORTAL", items: [{ productId, quantity: 2 }] },
  });
  await expect(response).toBeOK();
  await expect(response.json()).resolves.toMatchObject({
    data: {
      channel: "PORTAL",
      originalTotalCents: 5180,
      discountTotalCents: 0,
      totalCents: 5180,
      lines: [{ productId, unitPriceCents: 2590, quantity: 2, appliedPromotion: null }],
    },
  });
});

test("Checkout rejects client totals and deduplicates Cobrar atomically", async ({ page }) => {
  const productId = "33f00000-0000-4000-8000-000000000001";
  const locationId = "50000000-0000-4000-8000-000000000001";
  await page.goto("/login");
  await login(page, "admin.teste@institutojef.org.br", "Admin123!");

  const tampered = await page.request.post("/api/v1/sales/checkout", {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-tampered-${Date.now()}` },
    data: { channel: "PDV", locationId, items: [{ productId, quantity: 1 }], totalCents: 1 },
  });
  expect(tampered.status()).toBe(422);
  await expect(tampered.json()).resolves.toMatchObject({ code: "INVALID_CHECKOUT" });

  const key = `e2e-checkout-${Date.now()}`;
  const payload = { channel: "PDV", locationId, items: [{ productId, quantity: 1 }] };
  const first = await page.request.post("/api/v1/sales/checkout", {
    headers: { Origin: portalUrl, "Idempotency-Key": key },
    data: payload,
  });
  expect(first.status()).toBe(201);
  const firstBody = await first.json();
  expect(firstBody).toMatchObject({
    data: {
      status: "AWAITING_PAYMENT",
      channel: "PDV",
      locationId,
      quote: { totalCents: 2590 },
      reservation: { status: "ACTIVE" },
      paymentAttempt: {
        status: "CREATED",
        amountCents: 2590,
        integrationChannel: null,
        confirmationSource: null,
      },
    },
  });

  const replay = await page.request.post("/api/v1/sales/checkout", {
    headers: { Origin: portalUrl, "Idempotency-Key": key },
    data: payload,
  });
  expect(replay.status()).toBe(201);
  await expect(replay.json()).resolves.toMatchObject({
    data: {
      saleId: firstBody.data.saleId,
      reservation: { reservationId: firstBody.data.reservation.reservationId },
      paymentAttempt: { attemptId: firstBody.data.paymentAttempt.attemptId },
    },
  });

  const conflictingReplay = await page.request.post("/api/v1/sales/checkout", {
    headers: { Origin: portalUrl, "Idempotency-Key": key },
    data: { ...payload, items: [{ productId, quantity: 2 }] },
  });
  expect(conflictingReplay.status()).toBe(409);
  await expect(conflictingReplay.json()).resolves.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

  const noStock = await page.request.post("/api/v1/sales/checkout", {
    headers: { Origin: portalUrl, "Idempotency-Key": `${key}-no-stock` },
    data: payload,
  });
  expect(noStock.status()).toBe(409);
  await expect(noStock.json()).resolves.toMatchObject({ code: "STOCK_CONFLICT" });

  const cancelKey = `${key}-cancel`;
  const cancelled = await page.request.post(`/api/v1/sales/${firstBody.data.saleId}/cancel`, {
    headers: { Origin: portalUrl, "Idempotency-Key": cancelKey },
  });
  expect(cancelled.status()).toBe(200);
  const cancelledBody = await cancelled.json();
  expect(cancelledBody).toMatchObject({
    data: {
      saleId: firstBody.data.saleId,
      status: "CANCELLED",
      reservation: {
        reservationId: firstBody.data.reservation.reservationId,
        status: "RELEASED",
      },
      paymentAttempt: {
        attemptId: firstBody.data.paymentAttempt.attemptId,
        status: "CANCELLED",
      },
    },
  });

  const cancelReplay = await page.request.post(`/api/v1/sales/${firstBody.data.saleId}/cancel`, {
    headers: { Origin: portalUrl, "Idempotency-Key": cancelKey },
  });
  expect(cancelReplay.status()).toBe(200);
  await expect(cancelReplay.json()).resolves.toMatchObject({ data: cancelledBody.data });
});

test("Manual PicPay confirmation is explicit, idempotent and consumes stock once", async ({ page }) => {
  const productId = "33f00000-0000-4000-8000-000000000001";
  const locationId = "50000000-0000-4000-8000-000000000001";
  await page.goto("/login");
  await login(page, "admin.teste@institutojef.org.br", "Admin123!");

  const checkoutKey = `e2e-manual-checkout-${Date.now()}`;
  const checkout = await page.request.post("/api/v1/sales/checkout", {
    headers: { Origin: portalUrl, "Idempotency-Key": checkoutKey },
    data: { channel: "PDV", locationId, items: [{ productId, quantity: 1 }] },
  });
  expect(checkout.status()).toBe(201);
  const checkoutBody = await checkout.json();
  const saleId = checkoutBody.data.saleId as string;

  const unsupported = await page.request.post(`/api/v1/sales/${saleId}/payments/manual-confirmation`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `${checkoutKey}-tap` },
    data: { integrationChannel: "TAP", proofReference: "TAP-E2E-0001" },
  });
  expect(unsupported.status()).toBe(422);

  const sensitive = await page.request.post(`/api/v1/sales/${saleId}/payments/manual-confirmation`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `${checkoutKey}-pan` },
    data: { integrationChannel: "MAQUININHA", proofReference: "4111111111111111" },
  });
  expect(sensitive.status()).toBe(422);

  const confirmationKey = `${checkoutKey}-confirm`;
  const confirmationPayload = {
    integrationChannel: "PIX_AREA",
    proofReference: `PIX-E2E-${Date.now().toString(36)}`,
  };
  const confirmed = await page.request.post(`/api/v1/sales/${saleId}/payments/manual-confirmation`, {
    headers: { Origin: portalUrl, "Idempotency-Key": confirmationKey },
    data: confirmationPayload,
  });
  expect(confirmed.status()).toBe(200);
  const confirmedBody = await confirmed.json();
  expect(confirmedBody).toMatchObject({
    data: {
      saleId,
      saleStatus: "CONFIRMED",
      paymentAttempt: {
        attemptId: checkoutBody.data.paymentAttempt.attemptId,
        status: "APPROVED",
        amountCents: 2590,
        integrationChannel: "PIX_AREA",
        confirmationSource: "MANUAL",
        proofReference: confirmationPayload.proofReference,
      },
      stock: {
        reservationId: checkoutBody.data.reservation.reservationId,
        status: "CONSUMED",
      },
    },
  });

  const replay = await page.request.post(`/api/v1/sales/${saleId}/payments/manual-confirmation`, {
    headers: { Origin: portalUrl, "Idempotency-Key": confirmationKey },
    data: confirmationPayload,
  });
  expect(replay.status()).toBe(200);
  await expect(replay.json()).resolves.toMatchObject({ data: confirmedBody.data });

  const cancelled = await page.request.post(`/api/v1/sales/${saleId}/cancel`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `${checkoutKey}-cancel-confirmed` },
  });
  expect(cancelled.status()).toBe(409);
  await expect(cancelled.json()).resolves.toMatchObject({ code: "CONFIRMED_SALE_REVERSAL_REQUIRED" });
});

test("Administrator enters the Portal and can navigate through the PDV", async ({ page }) => {
  await page.goto("/login");
  await login(page, "admin.teste@institutojef.org.br", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);
  await expect(page.getByText("Germinatura v2.2")).toBeVisible();

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
  await login(page, "admin.teste@institutojef.org.br", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);

  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Sair do PDV" }).click();
  await expect(page).toHaveURL(`${portalUrl}/login`);
  expect((await page.request.get("/api/v1/auth/session")).status()).toBe(401);

  await page.waitForLoadState("networkidle");
  await login(page, "admin.teste@institutojef.org.br", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);
});

test("Consumer enters only the Portal foundation and is rejected by the PDV", async ({ browser }) => {
  const portalContext = await browser.newContext();
  const portalPage = await portalContext.newPage();
  await portalPage.goto(`${portalUrl}/login`);
  await login(portalPage, "consumidor.teste@institutojef.org.br", "Consumidor123!");
  await expect(portalPage).toHaveURL(`${portalUrl}/`);
  await expect(portalPage.getByText("Consumidor", { exact: true })).toBeVisible();
  await portalContext.close();

  const pdvContext = await browser.newContext();
  const pdvPage = await pdvContext.newPage();
  await pdvPage.goto(`${pdvUrl}/login`);
  await login(pdvPage, "consumidor.teste@institutojef.org.br", "Consumidor123!");
  await expect(pdvPage).toHaveURL(`${portalUrl}/`);
  await expect(pdvPage.getByText("Consumidor", { exact: true })).toBeVisible();
  await pdvContext.close();
});

test("Seller enters the PDV and cannot use a consumer-only bypass", async ({ page }) => {
  await page.goto(`${pdvUrl}/login`);
  await login(page, "vendedor.teste@institutojef.org.br", "Vendedor123!");
  await expect(page).toHaveURL(`${pdvUrl}/`);
  await expect(page.getByText("Acesso autorizado")).toBeVisible();

  await page.goto(`${portalUrl}/`);
  await expect(page).toHaveURL(`${portalUrl}/`);
  await expect(page.getByText("Vendedor", { exact: true })).toBeVisible();
});

test("Logout and an expired bearer session are rejected", async ({ page, request }) => {
  await page.goto("/login");
  await login(page, "admin.teste@institutojef.org.br", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);

  const logoutStatus = await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).status);
  expect(logoutStatus).toBe(200);
  expect((await page.request.get("/api/v1/auth/session")).status()).toBe(401);

  const expired = await request.get("/api/v1/auth/session", { headers: { Authorization: "Bearer expired.fixture.token" } });
  expect(expired.status()).toBe(401);
});

test("Removed legacy domains are not exposed as functional APIs", async ({ page }) => {
  await page.goto("/login");
  await login(page, "admin.teste@institutojef.org.br", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);
  const status = await page.evaluate(async () => (await fetch("/api/produtos")).status);
  expect(status).toBe(404);
});
