import { expect, test } from "@playwright/test";
import { available, checkout, confirmManual, fixture, key, kinder, reference, sellerA, sellerB, session, setRule } from "../support";

// Regression of the PDV money paths (cash, credit, debit, acréscimo D, waiver, refund) with real sessions of synthetic
// people. Every payment is a manual confirmation: nothing is charged on any card or Pix account.
test("PDV: dinheiro, crédito e débito com acréscimo D, remoção autorizada, estoque e estorno", async ({ browser }) => {
  const seller = await session(browser, "pdv", sellerA.username);
  const adminPortal = await session(browser, "portal", fixture.admin.username);
  const adminPdv = await session(browser, "pdv", fixture.admin.username);
  try {
    // Cash: the seller's own shift, change in cents, one unit leaves the seller's stock.
    const opened = await seller.request.post("/api/v1/pdv/shifts", { headers: { "Idempotency-Key": key("shift") }, data: { locationId: sellerA.locationId, openingCashCents: 1000 } });
    expect([200, 201], await opened.text()).toContain(opened.status());
    const before = await available(sellerA.locationId, kinder.id);
    const cashSale = await checkout(seller.request, sellerA.locationId, kinder.id, "cash");
    const cash = await seller.request.post(`/api/v1/sales/${cashSale}/payments/cash`, { headers: { "Idempotency-Key": key("cash") }, data: { tenderedCents: 3000, surchargeCents: 0 } });
    expect(cash.status(), await cash.text()).toBe(200);
    expect((await cash.json() as { data: { cash: { changeCents: number } } }).data.cash.changeCents).toBe(410);
    expect(await available(sellerA.locationId, kinder.id)).toBe(before - 1);

    // Acréscimo D: 3,49% on credit, R$ 1,50 on debit, configured by finance in the run cohort.
    await setRule(adminPortal.request, "CREDITO", { mode: "PERCENTAGE", rateBps: 349 });
    await setRule(adminPortal.request, "DEBITO", { mode: "FIXED", fixedCents: 150 });

    const creditSale = await checkout(seller.request, sellerA.locationId, kinder.id, "credit");
    // A confirmation with the wrong acréscimo is refused (the server recomputes it).
    const wrong = await confirmManual(seller.request, creditSale, { integrationChannel: "MAQUININHA", cardMethod: "CREDITO", terminalId: fixture.terminals.a.id, proofReference: reference("C0"), surchargeCents: 0 }, "credit-wrong");
    expect(wrong.status(), await wrong.text()).toBe(409);
    const credit = await confirmManual(seller.request, creditSale, { integrationChannel: "MAQUININHA", cardMethod: "CREDITO", terminalId: fixture.terminals.a.id, proofReference: reference("C1"), surchargeCents: 90 }, "credit");
    expect(credit.status(), await credit.text()).toBe(200);
    const creditBody = (await credit.json() as { data: { paymentAttempt: { amountCents: number }; surcharge: { appliedCents: number; baseCents: number } } }).data;
    expect(creditBody.paymentAttempt.amountCents).toBe(2680);
    expect(creditBody.surcharge).toMatchObject({ baseCents: 2590, appliedCents: 90 });

    const debitSale = await checkout(seller.request, sellerA.locationId, kinder.id, "debit");
    const debit = await confirmManual(seller.request, debitSale, { integrationChannel: "MAQUININHA", cardMethod: "DEBITO", terminalId: fixture.terminals.b.id, proofReference: reference("D1"), surchargeCents: 150 }, "debit");
    expect(debit.status(), await debit.text()).toBe(200);
    expect((await debit.json() as { data: { paymentAttempt: { amountCents: number } } }).data.paymentAttempt.amountCents).toBe(2740);

    // Waiver: a seller cannot remove the acréscimo; an administrator can, with a reason.
    const sellerB_ = await session(browser, "pdv", sellerB.username);
    const deniedSale = await checkout(sellerB_.request, sellerB.locationId, kinder.id, "waive-denied");
    const denied = await confirmManual(sellerB_.request, deniedSale, { integrationChannel: "MAQUININHA", cardMethod: "DEBITO", terminalId: fixture.terminals.a.id, proofReference: reference("W0"),
      surchargeCents: 150, waiveSurcharge: true, surchargeWaiverReason: "Cliente reclamou do valor" }, "waive-denied");
    expect(denied.status(), await denied.text()).toBe(403);
    // The refused sale is cancelled: no reservation stays open.
    expect((await sellerB_.request.post(`/api/v1/sales/${deniedSale}/cancel`, { headers: { "Idempotency-Key": key("waive-denied-cancel") } })).status()).toBe(200);
    await sellerB_.context.close();
    const adminSale = await checkout(adminPdv.request, fixture.central, kinder.id, "waive");
    const waived = await confirmManual(adminPdv.request, adminSale, { integrationChannel: "MAQUININHA", cardMethod: "DEBITO", terminalId: fixture.terminals.a.id, proofReference: reference("W1"),
      surchargeCents: 150, waiveSurcharge: true, surchargeWaiverReason: "Cortesia autorizada no smoke" }, "waive");
    expect(waived.status(), await waived.text()).toBe(200);
    const waivedBody = (await waived.json() as { data: { paymentAttempt: { amountCents: number }; surcharge: { waived: boolean; appliedCents: number } } }).data;
    expect(waivedBody.paymentAttempt.amountCents).toBe(2590);
    expect(waivedBody.surcharge).toMatchObject({ waived: true, appliedCents: 0 });

    // Refund of the credit sale by finance: the unit returns to the seller's stock.
    const beforeRefund = await available(sellerA.locationId, kinder.id);
    const refund = await adminPortal.request.post(`/api/v1/sales/${creditSale}/cancel`, { headers: { "Idempotency-Key": key("refund") },
      data: { reason: "Estorno do smoke automatizado", refundReference: reference("R1") } });
    expect(refund.status(), await refund.text()).toBe(200);
    expect(await available(sellerA.locationId, kinder.id)).toBe(beforeRefund + 1);
  } finally {
    await setRule(adminPortal.request, "CREDITO", { mode: "NONE" });
    await setRule(adminPortal.request, "DEBITO", { mode: "NONE" });
    await Promise.all([seller.context.close(), adminPortal.context.close(), adminPdv.context.close()]);
  }
});
