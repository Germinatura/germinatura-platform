import { z } from "zod";

// ADR 0010 (PAY-004): a Payment Link as the seller sees it. Never carries provider credentials or raw events.
export const paymentLinkChargeStatusSchema = z.enum(["REQUESTED", "ACTIVE", "FAILED", "UNCERTAIN", "PAID", "INACTIVE"]);
export type PaymentLinkChargeStatus = z.infer<typeof paymentLinkChargeStatusSchema>;

export const paymentLinkChargeSchema = z.object({
  chargeId: z.uuid(),
  saleId: z.uuid(),
  amountCents: z.number().int().positive(),
  orderNumber: z.string().regex(/^G[0-9A-F]{14}$/),
  status: paymentLinkChargeStatusSchema,
  checkoutUrl: z.string().regex(/^https:\/\/\S+$/).max(1000).nullable(),
  brcode: z.string().max(2048).nullable(),
  expiresAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type PaymentLinkCharge = z.infer<typeof paymentLinkChargeSchema>;

export const paymentLinkChargeResponseSchema = z.object({
  data: paymentLinkChargeSchema,
  request_id: z.string().min(1),
}).strict();
