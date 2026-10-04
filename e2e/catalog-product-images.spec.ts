import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";
const headers = { Origin: portal, "Sec-Fetch-Site": "same-origin" };

test("Admin manages the image of a published offer without exposing mutation to consumers", async ({ page, browser }) => {
  test.slow();
  expect((await page.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portal}/admin/catalogo?q=PUBLIC-ITEM-A`);
  await page.getByRole("button", { name: "Editar imagens de Item público A" }).click();
  await page.getByLabel("Motivo da alteração").fill("Adicionar foto principal");
  await page.getByLabel("Descrição acessível").fill("Doce colorido em embalagem transparente");
  await page.getByLabel("Arquivo JPG, PNG ou WebP").setInputFiles({
    name: "produto.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  const uploadPromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/catalog/product-images") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Enviar imagem" }).click();
  const upload = await uploadPromise;
  expect(upload.status()).toBe(201);
  const uploaded = await upload.json() as { data: { id: string; productRevision: number } };
  await page.getByTestId("dashboard-scroll-container").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByText("Capa", { exact: true })).toHaveCount(1);

  const catalog = await page.request.get(`${portal}/api/v1/catalog/products?limit=50`);
  expect(catalog.status()).toBe(200);
  const publicBody = await catalog.json() as { data: Array<{ slug: string; images: Array<{ altText: string; publicUrl: string }> }> };
  const publicProduct = publicBody.data.find((product) => product.slug === "public-item-a");
  expect(publicProduct?.images).toHaveLength(1);
  expect(publicProduct?.images[0].altText).toContain("Doce colorido");
  expect(publicProduct?.images[0].publicUrl).toContain("/storage/v1/object/public/product-images/products/");
  const publicImage = await page.request.get(publicProduct?.images[0].publicUrl ?? "");
  expect(publicImage.status()).toBe(200);
  expect(publicImage.headers()["content-type"]).toBe("image/png");

  await page.goto(`${portal}/admin/catalogo?q=PUBLIC-ITEM-A`);
  await page.getByRole("button", { name: "Editar imagens de Item público A" }).click();
  await page.getByLabel("Motivo da alteração").fill("Remover foto de teste");
  const removalPromise = page.waitForResponse((response) => response.url().includes(`/api/v1/admin/catalog/product-images/${uploaded.data.id}`));
  await page.getByRole("button", { name: "Remover" }).click();
  const removal = await removalPromise;
  expect(removal.status()).toBe(200);
  await expect(page.getByText("Este produto ainda não tem imagem.")).toBeVisible();

  const consumer = await browser.newContext();
  try {
    expect((await consumer.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    const denied = await consumer.request.post(`${portal}/api/v1/admin/catalog/product-images`, { headers: { ...headers, "Idempotency-Key": "consumer-image" }, multipart: {} });
    expect(denied.status()).toBe(403);
  } finally { await consumer.close(); }

  expect(uploaded.data.productRevision).toBeGreaterThan(1);
});
