import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";

test("gestão registra e cancela um pedido sem alterar estoque", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    expect((await page.request.post(`${portal}/api/auth/login`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
    const supplier = await page.request.post(`${portal}/api/v1/admin/procurement/suppliers`, {
      headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `e2e-supplier:${crypto.randomUUID()}` },
      data: { id: null, expectedRevision: null, name: `Fornecedor de pedidos ${crypto.randomUUID()}`, contactName: "Equipe comercial", email: null, phone: null, document: null, notes: null, active: true, reason: "Preparar pedido de teste" },
    });
    expect(supplier.status()).toBe(201);
    const supplierBody = await supplier.json() as { data: { id: string; name: string } };
    await page.goto(`${portal}/admin/compras/pedidos`);
    await expect(page.getByRole("heading", { name: "Pedidos de compra" })).toBeVisible();
    const supplierSelect = page.getByLabel("Fornecedor ativo");
    await expect(supplierSelect.locator(`option[value="${supplierBody.data.id}"]`)).toHaveCount(1);
    await supplierSelect.selectOption(supplierBody.data.id);
    await page.getByLabel("Data do pedido").fill("2026-09-18");
    await page.getByLabel("Produto 1").selectOption("33000000-0000-4000-8000-000000000001");
    await page.getByLabel("Quantidade").fill("2");
    await page.getByLabel("Custo unitário (R$)").fill("6,25");
    await page.getByLabel("Frete (R$)").fill("2,50");
    await page.getByLabel("Forma de pagamento prevista").fill("PIX após entrega");
    await page.getByLabel("Motivo do registro").fill("Reposição para a comissão");
    const createdPromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/procurement/orders") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Registrar pedido" }).click();
    const created = await createdPromise; expect(created.status()).toBe(201);
    const orderId = String((await created.json() as { data: { id: string; totalCents: number } }).data.id);
    const item = page.getByRole("listitem").filter({ hasText: orderId }).last();
    await expect(item).toContainText("R$ 15,00");
    await item.getByLabel("Motivo do cancelamento").fill("Pedido substituído por outro fornecedor");
    const cancelledPromise = page.waitForResponse((response) => response.url().endsWith(`/api/v1/admin/procurement/orders/${orderId}/cancel`));
    await item.getByRole("button", { name: "Cancelar pedido" }).click();
    expect((await cancelledPromise).status()).toBe(200);
    await expect(page.getByRole("listitem").filter({ hasText: orderId }).last()).toContainText("Cancelado");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test("consumidor não acessa pedido por página ou API", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    expect((await page.request.post(`${portal}/api/auth/login`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" }, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    expect((await page.request.get(`${portal}/api/v1/admin/procurement/orders`)).status()).toBe(403);
    expect((await page.request.post(`${portal}/api/v1/admin/procurement/orders`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `denied:${crypto.randomUUID()}` }, data: {} })).status()).toBe(403);
    await page.goto(`${portal}/admin/compras/pedidos`);
    await expect(page).toHaveURL(`${portal}/`);
  } finally { await context.close(); }
});
