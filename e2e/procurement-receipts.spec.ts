import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:3000";

test("gestão recebe duas entregas e torna o lote opcional conforme o produto", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    expect((await page.request.post(`${portal}/api/auth/login`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
    const supplier = await page.request.post(`${portal}/api/v1/admin/procurement/suppliers`, {
      headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `receipt-supplier:${crypto.randomUUID()}` },
      data: { id: null, expectedRevision: null, name: `Fornecedor entregas ${crypto.randomUUID()}`, contactName: "Equipe", email: null, phone: null, document: null, notes: null, active: true, reason: "Preparar entrega" },
    });
    expect(supplier.status()).toBe(201);
    const supplierId = (await supplier.json() as { data: { id: string } }).data.id;
    const order = await page.request.post(`${portal}/api/v1/admin/procurement/orders`, {
      headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `receipt-order:${crypto.randomUUID()}` },
      data: { supplierId, orderedOn: "2026-09-18", expectedOn: null, freightCents: 250, otherCostCents: 50,
        paymentMethod: "PIX após entrega", proofReference: null, notes: null,
        items: [{ productId: "33000000-0000-4000-8000-000000000001", quantity: 2, unitCostCents: 625 }], reason: "Compra para o evento" },
    });
    expect(order.status()).toBe(201);
    const orderId = (await order.json() as { data: { id: string } }).data.id;
    await page.goto(`${portal}/admin/compras/recebimentos?orderId=${orderId}`);
    await expect(page.getByRole("heading", { name: "Recebimento de compras" })).toBeVisible();
    await expect(page.getByText("recebido 0 de 2")).toBeVisible();
    await page.getByLabel("Item do pedido").selectOption({ index: 1 });
    await expect(page.getByLabel("Código do lote (opcional)")).toBeVisible();
    await page.getByLabel("Quantidade conferida").fill("1");
    await page.getByLabel("Data do recebimento").fill("2026-09-18");
    await page.getByLabel("Validade opcional").fill("2026-10-18");
    await page.getByLabel("Motivo e conferência").fill("Entrega parcial conferida");
    const firstPromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/procurement/receipts") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Registrar recebimento" }).click();
    const first = await firstPromise;
    expect(first.status()).toBe(201);
    expect((await first.json() as { data: { totalCostCents: number } }).data.totalCostCents).toBe(775);
    await expect(page.getByText("recebido 1 de 2")).toBeVisible();
    await expect(page.getByText(/^Lote REC-/)).toBeVisible();
    await page.getByLabel("Item do pedido").selectOption({ index: 1 });
    await page.getByLabel("Data do recebimento").fill("2026-09-18");
    await page.getByLabel("Código do lote (opcional)").fill("E2E-LOTE-B");
    await page.getByLabel("Motivo e conferência").fill("Entrega final conferida");
    const secondPromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/procurement/receipts") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Registrar recebimento" }).click();
    expect((await secondPromise).status()).toBe(201);
    await expect(page.getByText("recebido 2 de 2")).toBeVisible();
    await expect(page.getByText(new RegExp(`Pedido ${orderId}.*Recebido`))).toBeVisible();
    await expect(page.getByText("E2E-LOTE-B")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test("consumidor não acessa recebimentos pela página nem pela API", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    expect((await page.request.post(`${portal}/api/auth/login`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin" }, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    expect((await page.request.get(`${portal}/api/v1/admin/procurement/receipts?orderId=63000000-0000-4000-8000-000000000001`)).status()).toBe(403);
    expect((await page.request.post(`${portal}/api/v1/admin/procurement/receipts`, { headers: { Origin: portal, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `denied:${crypto.randomUUID()}` }, data: {} })).status()).toBe(403);
    await page.goto(`${portal}/admin/compras/recebimentos`);
    await expect(page).toHaveURL(`${portal}/`);
  } finally { await context.close(); }
});

test("H1: o recebimento começa com a data de hoje em São Paulo e gera um lote PREFIXO-DDMMYY-NN editável", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const headers = { Origin: portal, "Sec-Fetch-Site": "same-origin" };
    expect((await page.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const ddmmyy = `${today.slice(8, 10)}${today.slice(5, 7)}${today.slice(2, 4)}`;
    const supplier = await page.request.post(`${portal}/api/v1/admin/procurement/suppliers`, {
      headers: { ...headers, "Idempotency-Key": `lot-supplier:${crypto.randomUUID()}` },
      data: { id: null, expectedRevision: null, name: `Fornecedor lote ${crypto.randomUUID()}`, contactName: "Equipe", email: null, phone: null, document: null, notes: null, active: true, reason: "Preparar entrega" },
    });
    const supplierId = (await supplier.json() as { data: { id: string } }).data.id;
    const order = await page.request.post(`${portal}/api/v1/admin/procurement/orders`, {
      headers: { ...headers, "Idempotency-Key": `lot-order:${crypto.randomUUID()}` },
      data: { supplierId, orderedOn: today, expectedOn: null, freightCents: 0, otherCostCents: 0, paymentMethod: "PIX", proofReference: null, notes: null,
        items: [{ productId: "33f00000-0000-4000-8000-000000000001", quantity: 3, unitCostCents: 500 }], reason: "Compra de doces" },
    });
    expect(order.status()).toBe(201);
    const orderId = (await order.json() as { data: { id: string } }).data.id;

    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${portal}/admin/compras/recebimentos?orderId=${orderId}`);
      await expect(page.getByRole("heading", { name: "Recebimento de compras" })).toBeVisible();
      // The date starts on today (São Paulo) and stays editable.
      await expect(page.getByLabel("Data do recebimento")).toHaveValue(today);
      await page.getByLabel("Item do pedido").selectOption({ index: 1 });
      const lot = page.getByLabel(/^Código do lote/);
      const generate = page.getByRole("button", { name: "Gerar lote" });
      await generate.click();
      await expect(lot).toHaveValue(new RegExp(`^IPU-${ddmmyy}-[0-9]{2,3}$`));
      const first = await lot.inputValue();
      await generate.click();
      await expect(lot).not.toHaveValue(first);
      const generated = await lot.inputValue();
      expect(Number(generated.split("-")[2])).toBeGreaterThan(Number(first.split("-")[2]));
      // The code is editable before registering; here it is kept as generated.
      await page.getByLabel("Quantidade conferida").fill("1");
      await page.getByLabel("Motivo e conferência").fill("Entrega sem lote do produtor");
      const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/v1/admin/procurement/receipts") && candidate.request().method() === "POST");
      await page.getByRole("button", { name: "Registrar recebimento" }).click();
      expect((await response).status()).toBe(201);
      await expect(page.getByText(generated)).toBeVisible();
      // After a receipt the date is still today and the lot is cleared for the next one.
      await expect(page.getByLabel("Data do recebimento")).toHaveValue(today);
      await expect(lot).toHaveValue("");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    // A lot code request without permission is refused.
    const consumer = await browser.newContext();
    expect((await consumer.request.post(`${portal}/api/auth/login`, { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
    expect((await consumer.request.post(`${portal}/api/v1/admin/procurement/receipts/lot-code`, { headers, data: { orderItemId: crypto.randomUUID(), receivedOn: today } })).status()).toBe(403);
    await consumer.close();
  } finally { await context.close(); }
});
