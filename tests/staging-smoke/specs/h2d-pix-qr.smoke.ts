import { expect, test } from "@playwright/test";
import { checkout, confirmManual, fixture, key, kinder, reference, sellerA, sellerB, session, setRule } from "../support";

// H2d: static Pix QR for the amount the server decides. Staging runs with a synthetic receiver (the Banco Central manual's
// example key, which receives nothing): the smoke checks the payload and the amount and never pays anything.
const syntheticKey = "123e4567-e12b-12d1-a456-426655440000";

function crc16(payload: string) {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
function expectBrCode(payload: string, amount: string, txid: string) {
  expect(payload.startsWith("000201")).toBe(true);
  expect(payload).toContain(`0014br.gov.bcb.pix0136${syntheticKey}`);
  expect(payload).toContain(`54${amount.length.toString().padStart(2, "0")}${amount}5802BR`);
  expect(payload).toContain(`5917GERMINATURA SMOKE6009SAO PAULO`);
  expect(payload).toContain(`05${txid.length.toString().padStart(2, "0")}${txid}`);
  expect(payload.slice(-8, -4)).toBe("6304");
  expect(payload.slice(-4)).toBe(crc16(payload.slice(0, -4)));
}

test("H2d: QR Pix sem acréscimo, percentual, fixo e removido; payload, copia e cola e confirmação manual", async ({ browser }) => {
  const seller = await session(browser, "pdv", sellerA.username);
  const adminPortal = await session(browser, "portal", fixture.admin.username);
  const adminPdv = await session(browser, "pdv", fixture.admin.username);
  const charge = async (request: typeof seller.request, saleId: string, waive = false) => {
    const response = await request.get(`/api/v1/sales/${saleId}/payments/pix-charge${waive ? "?waiveSurcharge=true" : ""}`);
    return { status: response.status(), body: response.ok() ? (await response.json() as { data: { amountCents: number; surchargeCents: number; waived: boolean; txid: string; payload: string } }).data : null };
  };
  try {
    // Without acréscimo: the sale total; txid = PDV + 22 hex digits of the sale.
    await setRule(adminPortal.request, "PIX", { mode: "NONE" });
    const plainSale = await checkout(seller.request, sellerA.locationId, kinder.id, "pix-plain");
    const plain = await charge(seller.request, plainSale);
    expect(plain.status).toBe(200);
    const txid = `PDV${plainSale.replace(/-/g, "").toUpperCase().slice(0, 22)}`;
    expect(plain.body).toMatchObject({ amountCents: 2590, surchargeCents: 0, txid });
    expectBrCode(plain.body!.payload, "25.90", txid);
    expect((await charge(seller.request, plainSale)).body?.payload).toBe(plain.body!.payload);

    // Percentage (1%) and fixed (R$ 1,50): the amount changes and so does the payload.
    await setRule(adminPortal.request, "PIX", { mode: "PERCENTAGE", rateBps: 100 });
    const percent = await charge(seller.request, plainSale);
    expect(percent.body).toMatchObject({ amountCents: 2615, surchargeCents: 25 });
    expectBrCode(percent.body!.payload, "26.15", txid);
    await setRule(adminPortal.request, "PIX", { mode: "FIXED", fixedCents: 150 });
    const fixed = await charge(seller.request, plainSale);
    expect(fixed.body).toMatchObject({ amountCents: 2740, surchargeCents: 150 });
    expectBrCode(fixed.body!.payload, "27.40", txid);
    expect(fixed.body!.payload).not.toBe(percent.body!.payload);

    // Waiver: refused to the seller, allowed to the administrator; another seller's sale has no QR for this one.
    expect((await charge(seller.request, plainSale, true)).status).toBe(403);
    const adminSale = await checkout(adminPdv.request, fixture.central, kinder.id, "pix-admin");
    const waived = await charge(adminPdv.request, adminSale, true);
    expect(waived.body).toMatchObject({ amountCents: 2590, surchargeCents: 0, waived: true });
    expect((await charge(seller.request, adminSale)).status).toBe(404);
    // The administrator's pending sale is cancelled: no reservation stays open.
    expect((await adminPdv.request.post(`/api/v1/sales/${adminSale}/cancel`, { headers: { "Idempotency-Key": key("pix-admin-cancel") } })).status()).toBe(200);
    const other = await session(browser, "pdv", sellerB.username);
    expect((await charge(other.request, plainSale)).status).toBe(404);
    await other.context.close();

    // The manual confirmation charges the QR amount (nothing is paid: the operator would check the PicPay app).
    const confirmed = await confirmManual(seller.request, plainSale, { integrationChannel: "PIX_AREA", proofReference: reference("PIX1"), surchargeCents: 150 }, "pix-plain");
    expect(confirmed.status(), await confirmed.text()).toBe(200);
    expect((await confirmed.json() as { data: { paymentAttempt: { amountCents: number } } }).data.paymentAttempt.amountCents).toBe(2740);

    // The screen on a phone: QR, copy-and-paste, amount and the manual-confirmation notice; other methods have no QR.
    await seller.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: seller.origin });
    const page = await seller.context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    await page.getByRole("button", { name: `Adicionar uma unidade de ${kinder.name}` }).click({ timeout: 90_000 });
    await page.getByRole("button", { name: "Revisar venda" }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: /^Cobrar/ }).click();
    await page.getByRole("button", { name: /^Maquininha/ }).click();
    await expect(page.getByRole("region", { name: "Pagamento por Pix" })).toHaveCount(0);
    await page.getByRole("button", { name: /^Pix/ }).click();
    const pix = page.getByRole("region", { name: "Pagamento por Pix" });
    await expect(pix.getByTestId("pix-amount")).toContainText("27,40");
    await expect(pix.getByText("Confirme o recebimento no PicPay antes de concluir.")).toBeVisible();
    const payload = await pix.getByLabel("Pix copia e cola").inputValue();
    expect(payload).toContain("540527.40");
    await pix.getByRole("button", { name: "Copiar código Pix" }).click();
    await expect(pix.getByRole("button", { name: "Código copiado" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(payload);
    const qr = await pix.locator("svg").first().boundingBox();
    expect((qr?.width ?? 0) >= 200 && (qr?.x ?? -1) >= 0 && (qr?.x ?? 0) + (qr?.width ?? 0) <= 360).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    // Leave the pending sale: cancel it so no reservation stays open.
    await page.getByRole("button", { name: "Cancelar venda pendente" }).click();
  } finally {
    await setRule(adminPortal.request, "PIX", { mode: "NONE" });
    await Promise.all([seller.context.close(), adminPortal.context.close(), adminPdv.context.close()]);
  }
});
