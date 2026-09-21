import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";
const headers = { Origin: portal, "Sec-Fetch-Site": "same-origin" };

test("gestão acompanha compra por lote, custo e movimento; consumidor fica bloqueado", async ({ browser }) => {
  const admin = await browser.newContext();
  const consumer = await browser.newContext();
  try {
    const page = await admin.newPage();
    expect((await page.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
    const supplier = await page.request.post(`${portal}/api/v1/admin/procurement/suppliers`, {
      headers: { ...headers, "Idempotency-Key": `lot-supplier:${crypto.randomUUID()}` },
      data: { id: null, expectedRevision: null, name: `Fornecedor lote ${crypto.randomUUID()}`, contactName: "Equipe", email: null, phone: null, document: null, notes: null, active: true, reason: "Preparar rastreabilidade" },
    });
    expect(supplier.status()).toBe(201);
    const supplierId = (await supplier.json() as { data: { id: string } }).data.id;
    const order = await page.request.post(`${portal}/api/v1/admin/procurement/orders`, {
      headers: { ...headers, "Idempotency-Key": `lot-order:${crypto.randomUUID()}` },
      data: { supplierId, orderedOn: "2026-09-18", expectedOn: null, freightCents: 0, otherCostCents: 0,
        paymentMethod: "PIX após entrega", proofReference: null, notes: null,
        items: [{ productId: "33000000-0000-4000-8000-000000000001", quantity: 2, unitCostCents: 625 }],
        reason: "Compra rastreável" },
    });
    expect(order.status()).toBe(201);
    const orderId = (await order.json() as { data: { id: string } }).data.id;
    const itemResponse = await page.request.get(`${portal}/api/v1/admin/procurement/orders?orderId=${orderId}`);
    expect(itemResponse.status()).toBe(200);
    const itemId = (await itemResponse.json() as { data: Array<{ items: Array<{ id: string }> }> }).data[0].items[0].id;
    const lotCode = `E2E-TRACE-${crypto.randomUUID().slice(0, 8)}`;
    const receipt = await page.request.post(`${portal}/api/v1/admin/procurement/receipts`, {
      headers: { ...headers, "Idempotency-Key": `lot-receipt:${crypto.randomUUID()}` },
      data: { orderId, orderItemId: itemId, quantity: 2, receivedOn: "2026-09-18", lotCode,
        manufacturedOn: null, expiresOn: "2026-10-18", reason: "Lote conferido na entrada" },
    });
    expect(receipt.status()).toBe(201);
    const lotId = (await receipt.json() as { data: { lotId: string } }).data.lotId;
    const api = await page.request.get(`${portal}/api/v1/admin/inventory/lots?lotId=${lotId}`);
    expect(api.status()).toBe(200);
    const body = await api.json() as { data: Array<{ lotCode: string; totalCostCents: number }>; history: Array<{ movementType: string }> };
    expect(body.data[0]).toMatchObject({ lotCode, totalCostCents: 1250 });
    expect(body.history.some((entry) => entry.movementType === "ENTRADA_COMPRA")).toBe(true);
    await page.goto(`${portal}/admin/estoque/lotes`);
    await expect(page.getByRole("heading", { name: "Rastreabilidade por lote" })).toBeVisible();
    await page.getByPlaceholder("Lote, produto, SKU ou localização").fill(lotCode);
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByText(`lote ${lotCode}`)).toBeVisible();
    await page.getByRole("button", { name: "Ver histórico" }).click();
    await expect(page.getByRole("heading", { name: `Histórico do lote ${lotCode}` })).toBeVisible();
    await expect(page.getByText("Entrada de compra")).toBeVisible();
    const consumerPage = await consumer.newPage();
    expect((await consumerPage.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    expect((await consumerPage.request.get(`${portal}/api/v1/admin/inventory/lots?lotId=${lotId}`)).status()).toBe(403);
    await consumerPage.goto(`${portal}/admin/estoque/lotes`);
    await expect(consumerPage).toHaveURL(`${portal}/`);
  } finally {
    await admin.close();
    await consumer.close();
  }
});
