import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";
const endpoint = `${portal}/api/v1/admin/catalog/products`;
const headers = { Origin: portal, "Sec-Fetch-Site": "same-origin" };

test("Admin manages products with generated SKU and stale edits cannot overwrite changes", async ({ page, browser }, testInfo) => {
  test.slow();
  const login = await page.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "admin.teste", password: "Admin123!" } });
  expect(login.status()).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${portal}/admin/catalogo`);
  const warmRoute = await page.request.post(endpoint, { headers: { ...headers, "Idempotency-Key": `warm:${crypto.randomUUID()}` }, data: {} });
  expect(warmRoute.status()).toBe(422);
  const slug = `e2e-product-${crypto.randomUUID()}`;
  await page.getByLabel("Nome", { exact: true }).fill(slug);
  await page.getByLabel("Identificador", { exact: true }).fill(slug);
  await page.getByLabel("Permite reserva", { exact: true }).check();
  await page.getByLabel("Motivo", { exact: true }).fill("Cadastro para teste operacional");
  const createResponse = page.waitForResponse((response) => response.url() === endpoint && response.request().method() === "POST");
  await page.getByRole("button", { name: "Criar produto", exact: true }).click();
  const created = await createResponse;
  expect(created.status()).toBe(201);
  const result = await created.json() as { data: { id: string; revision: number; categoryId: string; sku: string } };
  expect(result.data.sku).toMatch(/^PROD-\d{6,}$/);
  await expect(page.getByRole("status")).toContainText("Produto salvo");
  await page.getByRole("button", { name: `Editar produto ${slug}`, exact: true }).click();
  await page.getByLabel("Produto ativo", { exact: true }).uncheck();
  await page.getByLabel("Motivo", { exact: true }).fill("Inativação operacional de teste");
  const editResponse = page.waitForResponse((response) => response.url() === endpoint && response.request().method() === "POST");
  await page.getByRole("button", { name: "Salvar produto", exact: true }).click();
  expect((await editResponse).status()).toBe(200);
  await expect(page.getByRole("listitem").filter({ hasText: slug })).toContainText("Inativo");
  const payload = { id: result.data.id, expectedRevision: result.data.revision, categoryId: result.data.categoryId, slug, name: slug,
    description: null, active: true, published: false, sellablePdv: false, reservable: true, tracksLots: false, reason: "Edição concorrente antiga" };
  const stale = await page.request.post(endpoint, { headers: { ...headers, "Idempotency-Key": `stale:${crypto.randomUUID()}` }, data: payload });
  expect(stale.status()).toBe(409);
  expect((await stale.json() as { code: string }).code).toBe("PRODUCT_REVISION_CONFLICT");
  const badOrigin = await page.request.post(endpoint, { headers: { Origin: "https://untrusted.invalid", "Idempotency-Key": "product-bad-origin" }, data: payload });
  expect(badOrigin.status()).toBe(403);
  const unknownField = await page.request.post(endpoint, { headers: { ...headers, "Idempotency-Key": "product-unknown-field" }, data: { ...payload, totalCents: 1 } });
  expect(unknownField.status()).toBe(422);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("products-mobile.png"), fullPage: true });
  const consumer = await browser.newContext();
  try {
    const response = await consumer.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } });
    expect(response.status()).toBe(200);
    expect((await consumer.request.post(endpoint, { headers: { ...headers, "Idempotency-Key": "product-consumer" }, data: payload })).status()).toBe(403);
    const consumerPage = await consumer.newPage();
    await consumerPage.goto(`${portal}/admin/catalogo`);
    await expect(consumerPage).toHaveURL(`${portal}/`);
  } finally { await consumer.close(); }
});
