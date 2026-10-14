import { expect, test, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const pdvHeaders = { Origin: pdvUrl, "Sec-Fetch-Site": "same-origin" };
const portalHeaders = { Origin: portalUrl, "Sec-Fetch-Site": "same-origin" };
const sellerLocationId = "50000000-0000-4000-8000-000000000002";
const itemA = "33f00000-0000-4000-8000-000000000001"; // R$ 25,90
// The fictitious receiver the E2E Portal runs with (playwright.config.ts).
const e2eKey = "123e4567-e12b-12d1-a456-426655440000";

async function ensureSellerStock(units: number) {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível para preparar o estoque E2E");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const balances = await fetch(`${url}/rest/v1/inventory_balances?select=available_quantity&location_id=eq.${sellerLocationId}&product_id=eq.${itemA}`, { headers });
  const current = ((await balances.json()) as Array<{ available_quantity: number }>)[0]?.available_quantity ?? 0;
  if (current >= units) return;
  const response = await fetch(`${url}/rest/v1/rpc/adjust_stock`, { method: "POST", headers, body: JSON.stringify({
    p_location_id: sellerLocationId, p_product_id: itemA, p_quantity_delta: units - current,
    p_reason: "Preparar QR Pix E2E", p_idempotency_key: `e2e-pix-qr-stock:${crypto.randomUUID()}`, p_correlation_id: crypto.randomUUID() }) });
  if (!response.ok) throw new Error("Não foi possível preparar o estoque do vendedor");
}

/** CRC16/CCITT-FALSE, as the BR Code requires (independent of the implementation under test). */
function crc16(payload: string) {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function expectValidBrCode(payload: string, amount: string) {
  expect(payload.startsWith("000201")).toBe(true);
  expect(payload).toContain(`0014br.gov.bcb.pix0136${e2eKey}`);
  expect(payload).toContain(`54${amount.length.toString().padStart(2, "0")}${amount}5802BR`);
  expect(payload.slice(-8, -4)).toBe("6304");
  expect(payload.slice(-4)).toBe(crc16(payload.slice(0, -4)));
}

async function checkout(request: APIRequestContext, label: string) {
  const response = await request.post(`${pdvUrl}/api/v1/sales/checkout`, { headers: { ...pdvHeaders, "Idempotency-Key": `e2e-pix-${label}-${Date.now()}` },
    data: { channel: "PDV", locationId: sellerLocationId, items: [{ productId: itemA, quantity: 1 }] } });
  expect(response.ok()).toBe(true);
  return (await response.json()).data.saleId as string;
}

async function pixCharge(request: APIRequestContext, saleId: string, waive = false) {
  return request.get(`${pdvUrl}/api/v1/sales/${saleId}/payments/pix-charge${waive ? "?waiveSurcharge=true" : ""}`, { headers: pdvHeaders });
}

test("PDV: Pix mostra QR e copia e cola com o valor do servidor; acréscimo e remoção mudam o valor; outros meios sem QR", async ({ page, browser, context }) => {
  test.slow();
  await ensureSellerStock(6);
  const finance = await browser.newContext({ baseURL: portalUrl });
  expect((await finance.request.post("/api/auth/login", { headers: portalHeaders, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  const setPixRule = (data: Record<string, unknown>) => finance.request.post("/api/v1/admin/finance/surcharges", {
    headers: { ...portalHeaders, "Idempotency-Key": `e2e-pix-rule-${crypto.randomUUID()}` }, data: { method: "PIX", reason: "Teste do QR Pix E2E", ...data } });
  expect((await page.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);

  try {
    // Without an acréscimo the QR charges the sale total, for the seller's own sale only.
    await setPixRule({ mode: "NONE" });
    const plainSale = await checkout(page.request, "plain");
    const plain = await pixCharge(page.request, plainSale);
    expect(plain.status()).toBe(200);
    const plainBody = (await plain.json()).data as { amountCents: number; surchargeCents: number; txid: string; payload: string };
    expect(plainBody).toMatchObject({ amountCents: 2590, surchargeCents: 0, txid: `PDV${plainSale.replace(/-/g, "").toUpperCase().slice(0, 22)}` });
    expectValidBrCode(plainBody.payload, "25.90");
    expect(plainBody.payload).toContain(`0525${plainBody.txid}`);
    expect((await pixCharge(page.request, plainSale)).status()).toBe(200);
    expect(((await (await pixCharge(page.request, plainSale)).json()).data as { payload: string }).payload).toBe(plainBody.payload);
    // Waiving needs the waiver permission: the seller cannot.
    expect((await pixCharge(page.request, plainSale, true)).status()).toBe(403);

    // Percentage and fixed acréscimos are added by the server.
    await setPixRule({ mode: "PERCENTAGE", rateBps: 100 });
    const percentSale = await checkout(page.request, "percent");
    const percent = (await (await pixCharge(page.request, percentSale)).json()).data as { amountCents: number; surchargeCents: number; payload: string };
    expect(percent).toMatchObject({ amountCents: 2615, surchargeCents: 25 });
    expectValidBrCode(percent.payload, "26.15");
    await setPixRule({ mode: "FIXED", fixedCents: 150 });
    const fixed = (await (await pixCharge(page.request, percentSale)).json()).data as { amountCents: number; surchargeCents: number; payload: string };
    expect(fixed).toMatchObject({ amountCents: 2740, surchargeCents: 150 });
    expectValidBrCode(fixed.payload, "27.40");
    expect(fixed.payload).not.toBe(percent.payload);

    // An administrator who may waive gets the QR without the acréscimo.
    const adminPdv = await browser.newContext();
    expect((await adminPdv.request.post(`${pdvUrl}/api/auth/login`, { headers: pdvHeaders, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
    const adminSale = await checkout(adminPdv.request, "admin");
    const waived = (await (await pixCharge(adminPdv.request, adminSale, true)).json()).data as { amountCents: number; waived: boolean; payload: string };
    expect(waived).toMatchObject({ amountCents: 2590, waived: true });
    expectValidBrCode(waived.payload, "25.90");
    // Another seller's sale has no QR for this seller.
    expect((await pixCharge(page.request, adminSale)).status()).toBe(404);
    await adminPdv.close();

    // The screen: Pix shows the QR, the copy-and-paste code and the amount with the fixed acréscimo; copying works.
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: pdvUrl });
    for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 740 }]) {
      const label = `${viewport.width}×${viewport.height}`;
      await page.setViewportSize(viewport);
      await page.goto(`${pdvUrl}/`);
      await page.getByRole("button", { name: "Adicionar uma unidade de Item público A" }).click();
      await page.getByRole("button", { name: "Revisar venda" }).filter({ visible: true }).first().click();
      await page.getByRole("button", { name: /^Cobrar/ }).click();
      await expect(page.getByRole("heading", { name: "Confirmar pagamento" }), label).toBeVisible();

      // Other methods have no QR.
      await page.getByRole("button", { name: /^Maquininha/ }).click();
      await expect(page.getByRole("region", { name: "Pagamento por Pix" }), label).toHaveCount(0);
      await page.getByRole("button", { name: /^Pix/ }).click();
      const pix = page.getByRole("region", { name: "Pagamento por Pix" });
      await expect(pix, label).toBeVisible();
      await expect(pix.getByTestId("pix-amount"), label).toContainText("27,40");
      await expect(pix.getByText("Confirme o recebimento no PicPay antes de concluir.")).toBeVisible();
      await expect(pix.locator("svg").first()).toBeVisible();
      const payload = await pix.getByLabel("Pix copia e cola").inputValue();
      expectValidBrCode(payload, "27.40");
      await pix.getByRole("button", { name: "Copiar código Pix" }).click();
      await expect(pix.getByRole("button", { name: "Código copiado" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(payload);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${label}: sem rolagem horizontal`).toBeLessThanOrEqual(0);
      const qr = await pix.locator("svg").first().boundingBox();
      expect((qr?.width ?? 0) >= 200, `${label}: QR legível`).toBe(true);
      expect((qr?.x ?? -1) >= 0 && (qr?.x ?? 0) + (qr?.width ?? 0) <= viewport.width, `${label}: QR dentro da tela`).toBe(true);

      // The manual confirmation is still required and works with the QR amount.
      const confirmation = page.waitForResponse((response) => response.url().endsWith("/payments/manual-confirmation"));
      await page.getByRole("button", { name: "Confirmar recebimento manualmente" }).click();
      const confirmed = await confirmation;
      expect(confirmed.status(), label).toBe(200);
      expect(((await confirmed.json()).data as { paymentAttempt: { amountCents: number } }).paymentAttempt.amountCents).toBe(2740);
      await expect(page.getByRole("heading", { name: "Venda concluída" })).toBeVisible();
    }
  } finally {
    await setPixRule({ mode: "NONE" });
    await finance.close();
  }
});
