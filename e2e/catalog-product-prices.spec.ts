import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";
const productEndpoint = `${portal}/api/v1/admin/catalog/products`;
const priceEndpoint = `${portal}/api/v1/admin/catalog/product-prices`;
const headers = { Origin: portal, "Sec-Fetch-Site": "same-origin" };

test("Admin defines a price through the interface and can inspect immutable history", async ({ page, browser }, testInfo) => {
  test.slow();
  const login = await page.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "admin.teste", password: "Admin123!" } });
  expect(login.status()).toBe(200);
  const warmPriceRoute = await page.request.post(priceEndpoint, { headers: { ...headers, "Idempotency-Key": `warm:${crypto.randomUUID()}` }, data: {} });
  expect(warmPriceRoute.status()).toBe(422);
  const slug = `e2e-price-${crypto.randomUUID()}`;
  const productResponse = await page.request.post(productEndpoint, {
    headers: { ...headers, "Idempotency-Key": `product:${crypto.randomUUID()}` },
    data: { id: null, expectedRevision: null, categoryId: "23f00000-0000-4000-8000-000000000001", slug, name: slug,
      description: null, active: false, published: false, sellablePdv: false, reservable: false, tracksLots: false, reason: "Criar produto para teste de preço" },
  });
  expect(productResponse.status()).toBe(201);
  const product = await productResponse.json() as { data: { id: string; revision: number } };
  const historyEndpoint = `${portal}/api/v1/admin/catalog/products/${product.data.id}/prices`;
  expect((await page.request.get(historyEndpoint)).status()).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${portal}/admin/catalogo`);
  await page.getByRole("button", { name: `Editar preço de ${slug}`, exact: true }).click();
  await page.getByLabel("Novo preço", { exact: true }).fill("27,90");
  await page.getByLabel("Motivo", { exact: true }).fill("Preço inicial de teste");
  const saved = page.waitForResponse((response) => response.url() === priceEndpoint && response.request().method() === "POST");
  await page.getByRole("button", { name: "Definir preço", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("status")).toContainText("Preço definido");
  await page.getByRole("button", { name: `Editar preço de ${slug}`, exact: true }).click();
  await expect(page.getByText("R$ 27,90", { exact: true })).toBeVisible();
  await expect(page.getByText("Vigente", { exact: true })).toBeVisible();
  const stale = await page.request.post(priceEndpoint, {
    headers: { ...headers, "Idempotency-Key": `stale:${crypto.randomUUID()}` },
    data: { productId: product.data.id, expectedProductRevision: product.data.revision, amountCents: 2890, reason: "Preço de uma revisão antiga" },
  });
  expect(stale.status()).toBe(409);
  const invalid = await page.request.post(priceEndpoint, {
    headers: { ...headers, "Idempotency-Key": `invalid:${crypto.randomUUID()}` },
    data: { productId: product.data.id, expectedProductRevision: 2, amountCents: 2790, reason: "Campo indevido", totalCents: 1 },
  });
  expect(invalid.status()).toBe(422);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("product-prices-mobile.png"), fullPage: true });
  const consumer = await browser.newContext();
  try {
    const response = await consumer.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } });
    expect(response.status()).toBe(200);
    expect((await consumer.request.post(priceEndpoint, { headers: { ...headers, "Idempotency-Key": "price-consumer" }, data: { productId: product.data.id, expectedProductRevision: 2, amountCents: 2790, reason: "Tentativa sem permissão" } })).status()).toBe(403);
    expect((await consumer.request.get(historyEndpoint)).status()).toBe(403);
  } finally { await consumer.close(); }
});
