import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";

test("financeiro liquida parcialmente e reverte obrigação sem apagar histórico", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    expect((await page.request.post(`${portal}/api/auth/login`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
    const supplierName = `Fornecedor financeiro ${crypto.randomUUID()}`;
    const supplier = await page.request.post(`${portal}/api/v1/admin/procurement/suppliers`, {
      headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `payable-supplier:${crypto.randomUUID()}` },
      data: { id: null, expectedRevision: null, name: supplierName, contactName: "Equipe", email: null, phone: null, document: null, notes: null, active: true, reason: "Preparar pagamento" },
    });
    const supplierId = (await supplier.json() as { data: { id: string } }).data.id;
    const order = await page.request.post(`${portal}/api/v1/admin/procurement/orders`, {
      headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `payable-order:${crypto.randomUUID()}` },
      data: { supplierId, orderedOn: "2026-09-20", expectedOn: null, freightCents: 0, otherCostCents: 0,
        paymentMethod: "PIX após entrega", proofReference: null, notes: null,
        items: [{ productId: "33000000-0000-4000-8000-000000000001", quantity: 1, unitCostCents: 1000 }], reason: "Compra para pagamento" },
    });
    const orderId = (await order.json() as { data: { id: string } }).data.id;
    const orderView = await page.request.get(`${portal}/api/v1/admin/procurement/orders?orderId=${orderId}`);
    const itemId = (await orderView.json() as { data: Array<{ items: Array<{ id: string }> }> }).data[0]?.items[0]?.id;
    const receipt = await page.request.post(`${portal}/api/v1/admin/procurement/receipts`, {
      headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `payable-receipt:${crypto.randomUUID()}` },
      data: { orderId, orderItemId: itemId, quantity: 1, receivedOn: "2026-09-20", lotCode: "E2E-PAYABLE",
        manufacturedOn: null, expiresOn: null, reason: "Entrega conferida" },
    });
    expect(receipt.status()).toBe(201);
    await page.goto(`${portal}/admin/financeiro/contas-a-pagar`);
    await expect(page.getByTestId("dashboard-scroll-container").getByRole("heading", { name: "Contas a pagar" })).toBeVisible();
    const payable = page.getByRole("article").filter({ hasText: supplierName });
    await expect(payable.getByText("R$ 10,00").first()).toBeVisible();
    await payable.getByLabel("Valor em reais").fill("6,00");
    await payable.getByLabel("Referência ou comprovante").fill("E2E-PIX-001");
    await payable.getByLabel("Motivo").fill("Pagamento parcial conferido");
    const settlementPromise = page.waitForResponse((response) => response.url().includes(`/payables/`) && response.url().endsWith("/settlements") && response.request().method() === "POST");
    await payable.getByRole("button", { name: "Registrar liquidação" }).click();
    expect((await settlementPromise).status()).toBe(201);
    const refreshedPayable = page.getByRole("article").filter({ hasText: supplierName });
    await expect(refreshedPayable.getByText("R$ 4,00")).toBeVisible();
    await refreshedPayable.getByLabel("Motivo da reversão").fill("Pagamento lançado na conta errada");
    const reversalPromise = page.waitForResponse((response) => response.url().endsWith("/reverse") && response.request().method() === "POST");
    await refreshedPayable.getByRole("button", { name: "Reverter" }).click();
    expect((await reversalPromise).status()).toBe(200);
    await expect(page.getByRole("article").filter({ hasText: supplierName }).getByText("Reversão · R$ 6,00")).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: supplierName }).getByText("Pagamento · R$ 6,00")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test("consumidor não acessa contas a pagar pela página nem pela API", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    expect((await page.request.post(`${portal}/api/auth/login`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" }, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    expect((await page.request.get(`${portal}/api/v1/admin/finance/payables`)).status()).toBe(403);
    expect((await page.request.post(`${portal}/api/v1/admin/finance/payables/63000000-0000-4000-8000-000000000001/settlements`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `denied:${crypto.randomUUID()}` }, data: {} })).status()).toBe(403);
    await page.goto(`${portal}/admin/financeiro/contas-a-pagar`);
    await expect(page).toHaveURL(`${portal}/`);
  } finally { await context.close(); }
});
