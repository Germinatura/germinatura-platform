import { expect, test } from "@playwright/test";
import { fixture, session } from "../support";

// H1: the delivery date starts on today in São Paulo; the automatic lot code PREFIX-DDMMYY-NN is reserved by the
// database (never twice, even under concurrency) and stays editable.
test("H1: data de São Paulo, lote gerado, concorrência de lote e recebimento com o lote gerado", async ({ browser }) => {
  const admin = await session(browser, "portal", fixture.admin.username);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const ddmmyy = `${today.slice(8, 10)}${today.slice(5, 7)}${today.slice(2, 4)}`;
  const pattern = new RegExp(`^BKI-${ddmmyy}-[0-9]{2,3}$`);
  try {
    // Concurrency: 12 reservations at the same time are all different and contiguous.
    const reservations = await Promise.all(Array.from({ length: 12 }, () => admin.request.post("/api/v1/admin/procurement/receipts/lot-code",
      { data: { orderItemId: fixture.purchaseOrder.itemId, receivedOn: today } })));
    const codes: string[] = [];
    for (const response of reservations) {
      expect(response.status(), await response.text()).toBe(200);
      codes.push((await response.json() as { data: { lotCode: string } }).data.lotCode);
    }
    expect(new Set(codes).size).toBe(12);
    for (const code of codes) expect(code).toMatch(pattern);
    const numbers = codes.map((code) => Number(code.split("-")[2])).sort((left, right) => left - right);
    expect(numbers[11] - numbers[0]).toBe(11);
    // A future date is refused.
    const future = new Date(Date.now() + 3 * 86_400_000);
    const futureDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(future);
    expect((await admin.request.post("/api/v1/admin/procurement/receipts/lot-code", { data: { orderItemId: fixture.purchaseOrder.itemId, receivedOn: futureDay } })).status()).toBe(422);

    // The screen: date = today (São Paulo); "Gerar lote" fills a code above the reserved ones; the receipt keeps it.
    const page = await admin.context.newPage();
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`/admin/compras/recebimentos?orderId=${fixture.purchaseOrder.id}`);
      await expect(page.getByLabel("Data do recebimento")).toHaveValue(today, { timeout: 90_000 });
      await page.getByLabel("Item do pedido").selectOption(fixture.purchaseOrder.itemId);
      await page.getByRole("button", { name: "Gerar lote" }).click();
      const lot = page.getByLabel(/^Código do lote/);
      await expect(lot).toHaveValue(pattern);
      const generated = await lot.inputValue();
      expect(Number(generated.split("-")[2])).toBeGreaterThan(numbers[11]);
      await page.getByLabel("Quantidade conferida").fill("1");
      await page.getByLabel("Motivo e conferência").fill("Entrega do smoke automatizado");
      const receipt = page.waitForResponse((response) => response.url().endsWith("/api/v1/admin/procurement/receipts") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Registrar recebimento" }).click();
      expect((await receipt).status()).toBe(201);
      await expect(page.getByText(generated)).toBeVisible();
      await expect(page.getByLabel("Data do recebimento")).toHaveValue(today);
      await expect(lot).toHaveValue("");
      numbers.push(Number(generated.split("-")[2]));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  } finally {
    await admin.context.close();
  }
});
