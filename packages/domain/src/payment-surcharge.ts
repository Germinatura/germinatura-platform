// Acréscimo por meio de pagamento (PR D). Mirrors private.compute_payment_surcharge_cents and
// private.payment_surcharge_method_for: the PDV shows this value, the database recomputes it and refuses any other.

export type PaymentSurchargeMethod = "DINHEIRO" | "PIX" | "CREDITO" | "DEBITO";

export type PaymentSurchargeRule =
  | { mode: "NONE" }
  | { mode: "PERCENTAGE"; rateBps: number }
  | { mode: "FIXED"; fixedCents: number };

/**
 * Acréscimo in cents over the sale total (after every discount). PERCENTAGE floors to the cent (customer-favorable);
 * FIXED is charged once per sale; a zero base never receives an acréscimo.
 */
export function computePaymentSurchargeCents(rule: PaymentSurchargeRule, baseCents: number): number {
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) throw new RangeError("baseCents must be a non-negative safe integer");
  if (baseCents === 0 || rule.mode === "NONE") return 0;
  if (rule.mode === "FIXED") {
    if (!Number.isSafeInteger(rule.fixedCents) || rule.fixedCents < 1) throw new RangeError("fixedCents must be a positive integer");
    return rule.fixedCents;
  }
  if (!Number.isInteger(rule.rateBps) || rule.rateBps < 1 || rule.rateBps > 10_000) throw new RangeError("rateBps must be between 1 and 10000");
  return Number((BigInt(baseCents) * BigInt(rule.rateBps)) / 10_000n);
}

/** The surcharge method of a PDV confirmation; vouchers and the Payment Link are not eligible. */
export function paymentSurchargeMethodFor(
  channel: "DINHEIRO" | "PIX_AREA" | "MAQUININHA" | "PAYMENT_LINK",
  cardMethod?: string | null,
): PaymentSurchargeMethod | null {
  if (channel === "DINHEIRO") return "DINHEIRO";
  if (channel === "PIX_AREA") return "PIX";
  if (channel === "MAQUININHA" && cardMethod === "CREDITO") return "CREDITO";
  if (channel === "MAQUININHA" && cardMethod === "DEBITO") return "DEBITO";
  return null;
}
