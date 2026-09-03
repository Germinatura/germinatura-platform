import { expect, test } from "@playwright/test";

const portalUrl = "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";

async function login(page: import("@playwright/test").Page, identifier: string, password: string) {
  const origin = new URL(page.url()).origin;
  const loginResponse = await page.request.post(`${origin}/api/auth/login`, {
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
    data: { identifier, password },
  });
  expect(loginResponse.status()).toBe(200);
  await page.goto(origin === pdvUrl && identifier.startsWith("admin.") ? `${portalUrl}/` : `${origin}/`);
}

async function latestEmailCode(
  request: import("@playwright/test").APIRequestContext,
  email: string,
) {
  let code = "";
  await expect.poll(async () => {
    const mailbox = await request.get("http://127.0.0.1:54325/api/v1/messages");
    const body = await mailbox.json() as {
      messages: Array<{ To: Array<{ Address: string }>; Subject: string; Snippet: string; Created: string }>;
    };
    const message = body.messages
      .filter((candidate) => candidate.To.some((recipient) => recipient.Address === email))
      .sort((left, right) => right.Created.localeCompare(left.Created))[0];
    code = message?.Snippet.match(/\b\d{6}\b/)?.[0] ?? "";
    return code;
  }, { timeout: 10_000 }).toMatch(/^\d{6}$/);
  return code;
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
  const rateLimitedIdentifier = `login.rate.${Date.now().toString(36)}`;
  const method = await request.get("/api/auth/login");
  expect(method.status()).toBe(405);
  expect(method.headers().allow).toBe("POST");

  const missingOrigin = await request.post("/api/auth/login", {
    data: { identifier: "admin.teste", password: "Admin123!" },
  });
  expect(missingOrigin.status()).toBe(403);

  const crossOrigin = await request.post("/api/auth/login", {
    headers: { Origin: "https://malicious.invalid", "Sec-Fetch-Site": "cross-site" },
    data: { identifier: "admin.teste", password: "Admin123!" },
  });
  expect(crossOrigin.status()).toBe(403);

  const protectedMutation = await request.post("/api/auth/reset-password", {
    headers: { Origin: portalUrl },
    data: { novaSenha: "Example123!" },
  });
  expect(protectedMutation.status()).toBe(401);

  for (const path of [
    "/api/v1/reservations",
    "/api/v1/raffles/94000000-0000-4000-8000-000000000001/numbers/reserve",
    "/api/v1/admin/raffles",
    "/api/v1/admin/users/10000000-0000-4000-8000-000000000003/signup-code",
  ]) {
    const protectedDomainMutation = await request.post(path, {
      headers: { Origin: portalUrl, "Idempotency-Key": `e2e-unauth-${path}` },
      data: {},
    });
    expect(protectedDomainMutation.status()).toBe(401);
  }

  for (const path of ["/api/v1/notifications", "/api/v1/feature-flags", "/api/v1/admin/users"]) {
    expect((await request.get(path)).status()).toBe(401);
  }

  const protectedFlagMutation = await request.patch("/api/v1/admin/feature-flags/reservations", {
    headers: { Origin: portalUrl }, data: { enabled: false, reason: "Teste sem sessão" },
  });
  expect(protectedFlagMutation.status()).toBe(401);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const invalid = await request.post("/api/auth/login", {
      headers: { Origin: portalUrl, "Sec-Fetch-Site": "same-origin" },
      data: { identifier: rateLimitedIdentifier, password: "SenhaIncorreta123!" },
    });
    expect(invalid.status()).toBe(401);
  }
  const rateLimited = await request.post("/api/auth/login", {
    headers: { Origin: portalUrl, "Sec-Fetch-Site": "same-origin" },
    data: { identifier: rateLimitedIdentifier, password: "SenhaIncorreta123!" },
  });
  expect(rateLimited.status()).toBe(429);
  await expect(rateLimited.json()).resolves.toMatchObject({ code: "RATE_LIMITED" });
});

test("Portal signup verifies institutional email, completes the profile and enables credential login", async ({ page, request }) => {
  test.setTimeout(120_000);
  const retiredOtp = await request.post("/api/v1/auth/otp/request", {
    headers: { Origin: portalUrl, "Sec-Fetch-Site": "same-origin" },
    data: { email: "pessoa@institutojef.org.br" },
  });
  expect(retiredOtp.status()).toBe(410);
  await expect(retiredOtp.json()).resolves.toMatchObject({ code: "OTP_LOGIN_REMOVED" });

  const external = await request.post("/api/v1/auth/signup/request", {
    headers: { Origin: portalUrl, "Sec-Fetch-Site": "same-origin" },
    data: { email: "pessoa@example.org" },
  });
  expect(external.status()).toBe(422);

  const suffix = Date.now().toString(36);
  const email = `cadastro.e2e.${suffix}@institutojef.org.br`;
  const username = `cadastro.${suffix}`;
  const password = "Cadastro123!";
  await page.goto("/cadastro");
  await page.getByLabel("E-mail institucional").fill(email);
  const requested = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/signup/request");
  await page.getByRole("button", { name: "Enviar código" }).click();
  expect((await requested).status()).toBe(202);

  await page.getByLabel("Código de 6 a 10 dígitos").fill(await latestEmailCode(request, email));
  const verified = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/signup/verify");
  await page.getByRole("button", { name: "Confirmar código" }).click();
  expect((await verified).status()).toBe(200);
  await expect(page).toHaveURL(`${portalUrl}/cadastro/perfil`);
  await expect(page.locator('form[data-hydrated="true"]')).toBeVisible();

  await page.getByLabel("Nome").fill("Pessoa Cadastro E2E");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByLabel("Confirmar senha").fill(password);
  await page.getByRole("button", { name: "Concluir cadastro" }).click();
  await expect(page).toHaveURL(`${portalUrl}/`);
  await expect(page.getByText("Consumidor", { exact: true })).toBeVisible();

  const session = await page.request.get("/api/v1/auth/session");
  await expect(session).toBeOK();
  await expect(session.json()).resolves.toMatchObject({ user: { email, username, roles: ["CONSUMIDOR"] } });

  await page.evaluate(async () => fetch("/api/auth/logout", { method: "POST" }));
  await page.goto("/login");
  await login(page, username, password);
  await expect(page).toHaveURL(`${portalUrl}/`);

  await page.evaluate(async () => fetch("/api/auth/logout", { method: "POST" }));
  await page.goto("/login");
  await page.getByLabel("Usuário ou e-mail").fill(email);
  await page.getByRole("link", { name: "Criar conta" }).click();
  await expect(page).toHaveURL(`${portalUrl}/cadastro`);
  await expect(page.getByLabel("E-mail institucional")).toHaveValue(email);
  await expect(page.getByRole("button", { name: "Enviar código" })).toBeVisible();

  const existingRequest = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/signup/request");
  await page.getByRole("button", { name: "Enviar código" }).click();
  expect((await existingRequest).status()).toBe(409);
  await expect(page.locator('p[role="alert"]')).toContainText("Já existe uma conta");
  await expect(page.getByRole("link", { name: "Ir para o login" })).toBeVisible();
});

test("Signup exposes one delayed resend and can switch email without leaving", async ({ page }) => {
  const email = `troca.${Date.now()}@institutojef.org.br`;
  await page.goto("/cadastro");
  await page.getByLabel("E-mail institucional").fill(email);
  const requested = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/signup/request");
  await page.getByRole("button", { name: "Enviar código" }).click();
  expect((await requested).status()).toBe(202);
  await expect(page.getByRole("button", { name: /Reenviar em 8\d+s/ })).toBeDisabled();
  await page.getByRole("button", { name: "Usar outro e-mail" }).click();
  await expect(page.getByLabel("E-mail institucional")).toBeEditable();
  await expect(page.getByLabel("E-mail institucional")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Enviar código" })).toBeVisible();
});

test("Password recovery changes the password and the third request requires an audited admin unlock", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString(36);
  const email = `recuperacao.e2e.${suffix}@institutojef.org.br`;
  const username = `recuperacao.${suffix}`;
  await page.goto("/login");
  await login(page, "admin.teste", "Admin123!");
  const provisioned = await page.request.post("/api/v1/admin/users", {
    headers: { Origin: portalUrl },
    data: {
      email,
      displayName: "Pessoa Recuperação E2E",
      username,
      password: "Recuperacao123!",
      roles: ["CONSUMIDOR"],
      active: true,
    },
  });
  expect(provisioned.status()).toBe(201);
  const provisionedBody = await provisioned.json();
  const provisionedUserId = provisionedBody.data.user_id as string;
  expect(provisionedUserId).toMatch(/^[0-9a-f-]{36}$/);
  await page.evaluate(async () => fetch("/api/auth/logout", { method: "POST" }));

  await page.goto("/esqueci-senha");
  await page.getByLabel("Usuário ou e-mail").fill(username);
  await page.getByRole("button", { name: "Enviar código" }).click();
  await page.getByLabel("Código de 6 a 10 dígitos").fill(await latestEmailCode(request, email));
  await page.getByRole("button", { name: "Confirmar código" }).click();
  await expect(page).toHaveURL(`${portalUrl}/recuperar-senha`);
  await page.getByLabel("Nova senha", { exact: true }).fill("Consumidor456!");
  await page.getByLabel("Confirmar nova senha").fill("Consumidor456!");
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page).toHaveURL(`${portalUrl}/`);

  await page.evaluate(async () => fetch("/api/auth/logout", { method: "POST" }));
  await page.goto("/login");
  await login(page, username, "Consumidor456!");
  await page.evaluate(async () => fetch("/api/auth/logout", { method: "POST" }));

  const headers = { Origin: portalUrl, "Sec-Fetch-Site": "same-origin" };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const accepted = await request.post("/api/v1/auth/password-recovery/request", {
      headers,
      data: { identifier: username },
    });
    expect(accepted.status()).toBe(202);
  }
  const blocked = await request.post("/api/v1/auth/password-recovery/request", {
    headers,
    data: { identifier: username },
  });
  expect(blocked.status()).toBe(429);
  await expect(blocked.json()).resolves.toMatchObject({ code: "ADMIN_RESET_REQUIRED" });

  await page.goto("/login");
  await login(page, "admin.teste", "Admin123!");
  const unlocked = await page.request.post(
    `/api/v1/admin/users/${provisionedUserId}/password-recovery`,
    {
      headers: { Origin: portalUrl },
      data: { reason: "Desbloqueio validado pelo teste E2E" },
    },
  );
  expect(unlocked.status()).toBe(200);
  const afterUnlock = await request.post("/api/v1/auth/password-recovery/request", {
    headers,
    data: { identifier: username },
  });
  expect(afterUnlock.status()).toBe(202);
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
  const firstBody = await first.json();
  expect(first.status(), JSON.stringify(firstBody)).toBe(201);
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
  const checkoutBody = await checkout.json();
  expect(checkout.status(), JSON.stringify(checkoutBody)).toBe(201);
  const saleId = checkoutBody.data.saleId as string;
  expect(saleId).toMatch(/^[0-9a-f-]{36}$/);

  let unsupportedStatus = 0;
  let unsupportedBody: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const unsupported = await page.request.post(`/api/v1/sales/${saleId}/payments/manual-confirmation`, {
      headers: { Origin: portalUrl, "Idempotency-Key": `${checkoutKey}-tap` },
      data: { integrationChannel: "TAP", proofReference: "TAP-E2E-0001" },
    });
    unsupportedStatus = unsupported.status();
    unsupportedBody = await unsupported.json().catch(() => null);
    if (unsupportedStatus !== 404) break;
    await page.waitForTimeout(500);
  }
  expect(unsupportedStatus, JSON.stringify(unsupportedBody)).toBe(422);

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

  const attemptId = confirmedBody.data.paymentAttempt.attemptId as string;
  const divergentKey = `${checkoutKey}-reconcile-divergent`;
  const divergentPayload = {
    observedAmountCents: 2500,
    feeAmountCents: 50,
    externalReference: `SETTLEMENT-DIVERGENT-${Date.now().toString(36)}`,
  };
  const divergent = await page.request.post(`/api/v1/payments/${attemptId}/reconciliations`, {
    headers: { Origin: portalUrl, "Idempotency-Key": divergentKey },
    data: divergentPayload,
  });
  expect(divergent.status()).toBe(200);
  const divergentBody = await divergent.json();
  expect(divergentBody).toMatchObject({
    data: {
      attemptId,
      paymentStatus: "RECONCILIATION_PENDING",
      outcome: "DIVERGENT",
      expectedAmountCents: 2590,
      observedAmountCents: 2500,
      feeAmountCents: 50,
      netAmountCents: 2450,
      source: "MANUAL",
    },
  });
  expect(divergentBody.data.ledger.divergenceEntryId).toBeTruthy();
  expect(divergentBody.data.ledger.feeEntryId).toBeNull();
  expect(divergentBody.data.ledger.settlementEntryId).toBeNull();

  const divergentReplay = await page.request.post(`/api/v1/payments/${attemptId}/reconciliations`, {
    headers: { Origin: portalUrl, "Idempotency-Key": divergentKey },
    data: divergentPayload,
  });
  expect(divergentReplay.status()).toBe(200);
  await expect(divergentReplay.json()).resolves.toMatchObject({ data: divergentBody.data });

  const matched = await page.request.post(`/api/v1/payments/${attemptId}/reconciliations`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `${checkoutKey}-reconcile-matched` },
    data: {
      observedAmountCents: 2590,
      feeAmountCents: 59,
      externalReference: `SETTLEMENT-MATCHED-${Date.now().toString(36)}`,
    },
  });
  expect(matched.status()).toBe(200);
  await expect(matched.json()).resolves.toMatchObject({
    data: {
      attemptId,
      paymentStatus: "RECONCILED",
      outcome: "MATCHED",
      expectedAmountCents: 2590,
      observedAmountCents: 2590,
      feeAmountCents: 59,
      netAmountCents: 2531,
      source: "MANUAL",
    },
  });

  const cancelled = await page.request.post(`/api/v1/sales/${saleId}/cancel`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `${checkoutKey}-cancel-confirmed` },
  });
  expect(cancelled.status()).toBe(409);
  await expect(cancelled.json()).resolves.toMatchObject({ code: "CONFIRMED_SALE_REVERSAL_REQUIRED" });

  const reversalKey = `${checkoutKey}-reverse-confirmed`;
  const reversalPayload = {
    reason: "Cliente solicitou estorno integral",
    refundReference: `ESTORNO-E2E-${Date.now().toString(36)}`,
  };
  const reversed = await page.request.post(`/api/v1/sales/${saleId}/cancel`, {
    headers: { Origin: portalUrl, "Idempotency-Key": reversalKey },
    data: reversalPayload,
  });
  const reversedBody = await reversed.json();
  expect(reversed.status(), JSON.stringify(reversedBody)).toBe(200);
  expect(reversedBody).toMatchObject({
    data: {
      saleId,
      status: "CANCELLED",
      paymentAttempt: { attemptId, status: "REFUNDED" },
      reversal: {
        amountCents: 2590,
        refundReference: reversalPayload.refundReference,
      },
    },
  });
  expect(reversedBody.data.reversal.stockMovementId).toMatch(/^[0-9a-f-]{36}$/);
  expect(reversedBody.data.reversal.refundEntryId).toMatch(/^[0-9a-f-]{36}$/);

  const reversalReplay = await page.request.post(`/api/v1/sales/${saleId}/cancel`, {
    headers: { Origin: portalUrl, "Idempotency-Key": reversalKey },
    data: reversalPayload,
  });
  expect(reversalReplay.status()).toBe(200);
  await expect(reversalReplay.json()).resolves.toMatchObject({ data: reversedBody.data });
});

test("Seller closeout endpoints enforce role, complete counts and managed reopen", async ({ page }) => {
  const productId = "33f00000-0000-4000-8000-000000000001";
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 60 * 60 * 1000);
  await page.goto("/login");
  await login(page, "consumidor.teste", "Consumidor123!");
  const consumerDenied = await page.request.post("/api/v1/closeouts", {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-closeout-consumer-${Date.now()}` },
    data: { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), stockCounts: [{ productId, countedQuantity: 0 }] },
  });
  expect(consumerDenied.status()).toBe(403);

  await page.evaluate(async () => fetch("/api/auth/logout", { method: "POST" }));
  await login(page, "vendedor.teste", "Vendedor123!");
  const incompleteCount = await page.request.post("/api/v1/closeouts", {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-closeout-incomplete-${Date.now()}` },
    data: { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), stockCounts: [{ productId, countedQuantity: 0 }] },
  });
  expect(incompleteCount.status()).toBe(422);
  await expect(incompleteCount.json()).resolves.toMatchObject({ code: "INVALID_CLOSEOUT_STOCK_COUNTS" });

  const sellerReopenDenied = await page.request.post("/api/v1/closeouts/81000000-0000-4000-8000-000000000001/reopen", {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-closeout-reopen-${Date.now()}` },
    data: { reason: "Tentativa sem permissão" },
  });
  expect(sellerReopenDenied.status()).toBe(403);
});

test("Administrator enters the Portal and can navigate through the PDV", async ({ page }) => {
  await page.goto("/login");
  await login(page, "admin.teste@institutojef.org.br", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);
  await expect(page.getByText("Germinatura v2.2")).toHaveCount(0);
  await expect(page.getByText("Fundação v2.1")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Olá, Admin Local" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Alertas e divergências" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Abrir menu da conta" })).toContainText("Admin Local");

  const usersResponse = await page.request.get("/api/v1/admin/users");
  await expect(usersResponse).toBeOK();
  await expect(usersResponse.json()).resolves.toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ email: "admin.teste@institutojef.org.br", active: true })]) });

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByText("Admin Local", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Recolher sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expandir sidebar" })).toBeVisible();

  for (const viewport of [{ width: 1280, height: 720 }, { width: 768, height: 700 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    const scrollContainer = page.getByTestId("dashboard-scroll-container");
    await expect(scrollContainer).toHaveCSS("overflow-y", "auto");
    await scrollContainer.hover();
    await page.mouse.wheel(0, 1200);
    await expect(page.getByRole("heading", { name: "Atividade recente" })).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Abrir navegação" }).click();
  const mobileNavigation = page.getByRole("navigation", { name: "Navegação principal" });
  const mobileSidebar = page.getByTestId("mobile-sidebar");
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileSidebar.getByText("Admin Local", { exact: true })).toHaveCount(0);
  await expect(mobileSidebar.getByRole("button", { name: "Sair da conta" })).toHaveCount(0);
  await page.getByRole("button", { name: "Fechar navegação" }).last().click();
  await page.getByRole("button", { name: "Notificações" }).click();
  await expect(page.getByText("Tudo em dia")).toBeVisible();
  await page.getByRole("button", { name: "Notificações" }).click();

  await page.goto(`${portalUrl}/admin/usuarios`);
  await expect(page.getByTestId("dashboard-scroll-container").getByRole("heading", { name: "Usuários e vendedores" })).toBeVisible();
  await expect(page.getByText("admin.teste@institutojef.org.br", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Adicionar usuário" })).toBeVisible();

  await page.goto(`${portalUrl}/admin/catalogo`);
  await expect(page.getByTestId("dashboard-scroll-container").getByRole("heading", { name: "Produtos e publicação" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Item público A" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Item não publicado" })).toBeVisible();

  await page.goto(`${portalUrl}/admin/estoque`);
  const inventoryContent = page.getByTestId("dashboard-scroll-container");
  await expect(inventoryContent.getByRole("heading", { name: "Saldos por localização" })).toBeVisible();
  await expect(inventoryContent.getByText(/PUBLIC-ITEM-A · Estoque central/)).toBeVisible();

  await page.goto(`${portalUrl}/admin/fechamentos`);
  const closeoutsContent = page.getByTestId("dashboard-scroll-container");
  await expect(closeoutsContent.getByRole("heading", { name: "Fechamentos", exact: true })).toBeVisible();
  await expect(closeoutsContent.getByRole("heading", { name: "Ainda não há fechamentos" })).toBeVisible();
  await expect(closeoutsContent.getByRole("button", { name: /reabrir/i })).toHaveCount(0);

  await page.goto(`${portalUrl}/trocar-senha`);
  await expect(page.getByRole("heading", { name: "Alterar senha" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Perfil e segurança" })).toBeVisible();

  const session = await page.request.get("/api/v1/auth/session");
  await expect(session).toBeOK();
  const sessionBody = await session.json();
  expect(sessionBody).toMatchObject({ user: { perfil: "ADMIN", roles: ["ADMIN"] } });
  const sessionText = JSON.stringify(sessionBody);
  expect(sessionText).not.toContain("access_token");
  expect(sessionText).not.toContain("refresh_token");

  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Abrir menu da conta" }).click();
  await page.getByTitle("Voltar ao Painel").click();
  await expect(page).toHaveURL(`${portalUrl}/`);
});

test("Administrator leaving the PDV can log back into the Portal", async ({ page }) => {
  await page.goto(`${pdvUrl}/login`);
  await login(page, "admin.teste@institutojef.org.br", "Admin123!");
  await expect(page).toHaveURL(`${portalUrl}/`);

  await page.goto(`${pdvUrl}/`);
  await page.getByRole("button", { name: "Abrir menu da conta" }).click();
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
  await portalPage.getByRole("link", { name: "Catálogo" }).click();
  await expect(portalPage).toHaveURL(`${portalUrl}/catalogo`);
  await expect(portalPage.getByRole("heading", { name: "Produtos disponíveis" })).toBeVisible();
  await expect(portalPage.getByRole("heading", { name: "Item público A" })).toBeVisible();
  await expect(portalPage.getByRole("heading", { name: "Item não publicado" })).toHaveCount(0);
  await portalPage.getByRole("link", { name: "Minhas reservas" }).click();
  await expect(portalPage).toHaveURL(`${portalUrl}/reservas`);
  await expect(portalPage.getByTestId("dashboard-scroll-container").getByRole("heading", { name: "Minhas reservas" })).toBeVisible();
  await expect(portalPage.getByRole("heading", { name: "Você ainda não tem reservas" })).toBeVisible();
  await expect(portalPage.getByRole("link", { name: "Ver catálogo" })).toBeVisible();
  await expect(portalPage.locator('nav a[href="/notificacoes"]')).toHaveCount(0);
  await portalPage.getByRole("button", { name: "Notificações" }).click();
  await portalPage.getByRole("link", { name: "Ver todas as notificações" }).click();
  await expect(portalPage).toHaveURL(`${portalUrl}/notificacoes`);
  await expect(portalPage.getByTestId("dashboard-scroll-container").getByRole("heading", { name: "Notificações" })).toBeVisible();
  await expect(portalPage.getByRole("heading", { name: "Tudo em dia" })).toBeVisible();
  await portalPage.getByRole("link", { name: "Rifas" }).click();
  await expect(portalPage).toHaveURL(`${portalUrl}/rifas`);
  await expect(portalPage.getByTestId("dashboard-scroll-container").getByRole("heading", { name: "Campanhas e meus números" })).toBeVisible();
  await expect(portalPage.getByRole("button", { name: /reservar|comprar|pagar/i })).toHaveCount(0);
  await portalPage.goto(`${portalUrl}/admin/usuarios`);
  await expect(portalPage).toHaveURL(`${portalUrl}/`);
  await expect(portalPage.getByRole("link", { name: "Usuários e vendedores" })).toHaveCount(0);
  await expect(portalPage.locator('a[href="/admin/catalogo"]')).toHaveCount(0);
  await expect(portalPage.locator('a[href="/admin/estoque"]')).toHaveCount(0);
  await expect(portalPage.locator('a[href="/admin/fechamentos"]')).toHaveCount(0);
  await portalPage.goto(`${portalUrl}/admin/fechamentos`);
  await expect(portalPage).toHaveURL(`${portalUrl}/`);
  await portalContext.close();

  const pdvContext = await browser.newContext();
  const pdvPage = await pdvContext.newPage();
  await pdvPage.goto(`${pdvUrl}/login`);
  const denied = await pdvPage.request.post(`${pdvUrl}/api/auth/login`, {
    headers: { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" },
    data: { identifier: "consumidor.teste", password: "Consumidor123!" },
  });
  expect(denied.status()).toBe(401);
  await expect(denied.json()).resolves.toMatchObject({ code: "INVALID_CREDENTIALS" });
  await pdvContext.close();
});

test("Seller enters the PDV and cannot use a consumer-only bypass", async ({ page }) => {
  await page.goto(`${pdvUrl}/login`);
  await login(page, "vendedor.teste", "Vendedor123!");
  await expect(page).toHaveURL(`${pdvUrl}/`);
  await expect(page.getByText("Acesso autorizado")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nova venda" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Item público A" })).toBeVisible();
  await expect(page.getByText("Fundação v2.1")).toHaveCount(0);
  await expect(page.getByText("Germinatura v2.2")).toHaveCount(0);

  await page.getByRole("button", { name: "Fechamento" }).click();
  await expect(page.getByRole("heading", { name: "Fechamento" })).toBeVisible();
  await expect(page.getByText("Nenhum item para contar")).toBeVisible();
  await page.getByRole("button", { name: "Operação" }).click();
  await expect(page.getByRole("heading", { name: "Nova venda" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Fechamento" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Abrir menu da conta" })).toBeVisible();
  await page.getByRole("button", { name: "Abrir menu da conta" }).click();
  await expect(page.getByRole("button", { name: "Sair do PDV" })).toBeVisible();

  const reconciliation = await page.request.post(
    "/api/v1/payments/76000000-0000-4000-8000-000000000001/reconciliations",
    {
      headers: { Origin: portalUrl, "Idempotency-Key": "seller-reconciliation-denied" },
      data: {
        observedAmountCents: 2590,
        feeAmountCents: 59,
        externalReference: "SETTLEMENT-SELLER-DENIED",
      },
    },
  );
  expect(reconciliation.status()).toBe(403);

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
  const retiredPdvFixtureLogin = await page.request.post(`${pdvUrl}/api/auth/test-login`, {
    headers: { Origin: pdvUrl },
    data: { email: "vendedor.teste@institutojef.org.br", password: "Vendedor123!" },
  });
  expect(retiredPdvFixtureLogin.status()).toBe(404);
});
