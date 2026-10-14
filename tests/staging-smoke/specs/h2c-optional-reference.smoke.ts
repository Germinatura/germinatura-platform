import { expect, test } from "@playwright/test";
import { checkout, confirmManual, fixture, key, kinder, reference, sellerA, session } from "../support";

// H2c: the external reference is optional (never invented); a typed one keeps the safe format and stays unique.
test("H2c: referência externa ausente, preenchida, inválida, sensível, repetida e idempotência", async ({ browser }) => {
  const seller = await session(browser, "pdv", sellerA.username);
  const card = { integrationChannel: "MAQUININHA", cardMethod: "DEBITO", terminalId: fixture.terminals.a.id, surchargeCents: 0 };
  try {
    // Without a reference: confirmed, stored as null.
    const noneSale = await checkout(seller.request, sellerA.locationId, kinder.id, "ref-none");
    const idempotency = key("ref-none");
    const none = await seller.request.post(`/api/v1/sales/${noneSale}/payments/manual-confirmation`, { headers: { "Idempotency-Key": idempotency }, data: card });
    expect(none.status(), await none.text()).toBe(200);
    const noneBody = await none.json() as { data: { paymentAttempt: { attemptId: string; proofReference: string | null } } };
    expect(noneBody.data.paymentAttempt.proofReference).toBeNull();
    // Replaying the same key returns the same confirmation.
    const replay = await seller.request.post(`/api/v1/sales/${noneSale}/payments/manual-confirmation`, { headers: { "Idempotency-Key": idempotency }, data: card });
    expect(replay.status()).toBe(200);
    expect((await replay.json() as typeof noneBody).data.paymentAttempt.attemptId).toBe(noneBody.data.paymentAttempt.attemptId);

    // A typed reference keeps every rule.
    const typedSale = await checkout(seller.request, sellerA.locationId, kinder.id, "ref-typed");
    for (const [invalid, tag] of [["ab", "short"], ["4111111111111111", "pan"], ["senha=1234", "format"]] as const) {
      const refused = await confirmManual(seller.request, typedSale, { ...card, proofReference: invalid }, `ref-${tag}`);
      expect(refused.status(), `${tag}: ${await refused.text()}`).toBe(422);
    }
    const typed = await confirmManual(seller.request, typedSale, { ...card, proofReference: reference("REF1") }, "ref-typed");
    expect(typed.status(), await typed.text()).toBe(200);
    expect((await typed.json() as typeof noneBody).data.paymentAttempt.proofReference).toBe(reference("REF1"));
    const repeatedSale = await checkout(seller.request, sellerA.locationId, kinder.id, "ref-repeated");
    const repeated = await confirmManual(seller.request, repeatedSale, { ...card, proofReference: reference("REF1") }, "ref-repeated");
    expect(repeated.status(), await repeated.text()).toBe(409);
    // Another sale without a reference never collides with the first one.
    const secondNone = await confirmManual(seller.request, repeatedSale, card, "ref-none-2");
    expect(secondNone.status(), await secondNone.text()).toBe(200);

    // "Minhas vendas" lists the sale without a reference.
    const mine = await seller.request.get("/api/v1/pdv/sales");
    expect(mine.status()).toBe(200);
    expect((await mine.json() as { data: { saleId: string; status: string }[] }).data.find((sale) => sale.saleId === noneSale)?.status).toBe("CONFIRMED");

    // The screen: optional label, confirmation without reference, receipt says so.
    const page = await seller.context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: `Adicionar uma unidade de ${kinder.name}` }).click({ timeout: 90_000 });
    await page.getByRole("complementary").getByRole("button", { name: "Revisar venda" }).click();
    await page.getByRole("button", { name: /^Cobrar/ }).click();
    await page.getByRole("button", { name: "Débito" }).click();
    await page.getByLabel("Maquininha usada").selectOption(fixture.terminals.b.id);
    await expect(page.getByLabel("Referência externa (opcional)")).toHaveValue("");
    await page.getByRole("button", { name: "Confirmar recebimento manualmente" }).click();
    await expect(page.getByText("Sem referência externa")).toBeVisible();
  } finally {
    await seller.context.close();
  }
});
