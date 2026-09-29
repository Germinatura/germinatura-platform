import { paymentLinkChargeSchema, type PaymentLinkCharge } from "@germinatura/contracts";
import { z } from "zod";

const chargeRowSchema = z.object({
  charge_id: z.uuid(), sale_id: z.uuid(), amount_cents: z.number().int(), order_number: z.string(), status: z.string(),
  checkout_url: z.string().nullable(), brcode: z.string().nullable(), expires_at: z.string().nullable(),
  error_code: z.string().nullable(), created_at: z.string(), updated_at: z.string(),
}).passthrough();

/** Maps the database view of a Payment Link to the public contract; returns null when it does not fit. */
export function paymentLinkChargeFromRow(row: unknown): PaymentLinkCharge | null {
  const parsed = chargeRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const value = parsed.data;
  const charge = paymentLinkChargeSchema.safeParse({
    chargeId: value.charge_id, saleId: value.sale_id, amountCents: value.amount_cents, orderNumber: value.order_number,
    status: value.status, checkoutUrl: value.checkout_url, brcode: value.brcode, expiresAt: value.expires_at,
    errorCode: value.error_code, createdAt: value.created_at, updatedAt: value.updated_at,
  });
  return charge.success ? charge.data : null;
}
