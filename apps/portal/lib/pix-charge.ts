import { computePaymentSurchargeCents, type PaymentSurchargeRule } from "@germinatura/domain";
import { buildPixStaticPayload, pixTxidForSale, readPixReceiver, type PixReceiverProblem } from "@germinatura/payments";

/** The rule in force as the surcharge listing returns it. */
export interface PixRuleView { mode: "NONE" | "PERCENTAGE" | "FIXED"; rateBps: number | null; fixedCents: number | null }

function toDomainRule(rule: PixRuleView): PaymentSurchargeRule {
  if (rule.mode === "PERCENTAGE" && rule.rateBps !== null) return { mode: "PERCENTAGE", rateBps: rule.rateBps };
  if (rule.mode === "FIXED" && rule.fixedCents !== null) return { mode: "FIXED", fixedCents: rule.fixedCents };
  if (rule.mode === "NONE") return { mode: "NONE" };
  throw new Error("INVALID_SURCHARGE_RULE");
}

/**
 * H2d: the amount of the Pix QR of a PDV sale, decided by the server. It is the sale total (after discounts) plus the
 * Pix acréscimo in force, or the total alone when an authorized operator waives the acréscimo; the client never sends
 * an amount. The manual confirmation later checks the same acréscimo again.
 */
export function pixChargeAmount({ saleTotalCents, rule, waive }: { saleTotalCents: number; rule: PixRuleView; waive: boolean }) {
  const surchargeCents = waive ? 0 : computePaymentSurchargeCents(toDomainRule(rule), saleTotalCents);
  return { productCents: saleTotalCents, surchargeCents, amountCents: saleTotalCents + surchargeCents };
}

export const pixReceiverMessages: Record<PixReceiverProblem, string> = {
  MISSING: "O Pix do PDV não está configurado neste ambiente (chave, nome ou cidade do recebedor).",
  INVALID_KEY: "A chave Pix configurada neste ambiente é inválida.",
  INVALID_NAME: "O nome do recebedor Pix configurado é inválido (até 25 caracteres).",
  INVALID_CITY: "A cidade do recebedor Pix configurada é inválida (até 15 caracteres).",
};

/** The QR payload of a sale for an amount, or the configuration problem that prevents it (never a wrong code). */
export function pixChargeFor(env: Parameters<typeof readPixReceiver>[0], saleId: string, amountCents: number) {
  const read = readPixReceiver(env);
  if (read.problem !== null) return { problem: read.problem, payload: null, txid: null } as const;
  const txid = pixTxidForSale(saleId);
  return { problem: null, payload: buildPixStaticPayload({ receiver: read.receiver, amountCents, txid }), txid } as const;
}
