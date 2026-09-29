import { z } from "zod";

// ADR 0010 (PAY-004, PAY-007): finance view of online payments — recovery queue, recent links and provider refunds.
export const paymentRecoveryKindSchema = z.enum([
  "UNKNOWN_LINK", "AMOUNT_MISMATCH", "LATE_PAYMENT", "DUPLICATE_PAYMENT", "UNCERTAIN_CREATION", "REFUND_CONFIRMED",
  "UNMATCHED_REFUND", "UNSUPPORTED_EVENT", "APPLY_FAILED", "INACTIVATION_FAILED", "REFUND_UNCERTAIN",
]);
export type PaymentRecoveryKind = z.infer<typeof paymentRecoveryKindSchema>;

export const paymentRecoveryItemSchema = z.object({
  id: z.uuid(),
  kind: paymentRecoveryKindSchema,
  status: z.enum(["OPEN", "RESOLVED"]),
  receiptId: z.uuid().nullable(),
  chargeId: z.uuid().nullable(),
  saleId: z.uuid().nullable(),
  amountCents: z.number().int().nullable(),
  transactionId: z.string().nullable(),
  detail: z.string(),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  resolvedByName: z.string().nullable(),
}).strict();
export type PaymentRecoveryItem = z.infer<typeof paymentRecoveryItemSchema>;

export const adminPaymentLinkSchema = z.object({
  chargeId: z.uuid(),
  saleId: z.uuid(),
  orderNumber: z.string(),
  amountCents: z.number().int(),
  status: z.enum(["REQUESTED", "ACTIVE", "FAILED", "UNCERTAIN", "PAID", "INACTIVE"]),
  errorCode: z.string().nullable(),
  paidTransactionId: z.string().nullable(),
  checkoutUrl: z.string().nullable(),
  saleStatus: z.string(),
  saleChannel: z.string(),
  requestedByName: z.string(),
  inactivationPending: z.boolean(),
  inactivatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type AdminPaymentLink = z.infer<typeof adminPaymentLinkSchema>;

export const adminPaymentLinkRefundSchema = z.object({
  refundId: z.uuid(),
  transactionId: z.string(),
  chargeId: z.uuid().nullable(),
  saleId: z.uuid().nullable(),
  amountCents: z.number().int(),
  reason: z.string(),
  status: z.enum(["REQUESTED", "ACCEPTED", "CONFIRMED", "FAILED", "UNCERTAIN"]),
  errorCode: z.string().nullable(),
  requestedByName: z.string(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
}).strict();
export type AdminPaymentLinkRefund = z.infer<typeof adminPaymentLinkRefundSchema>;

export const onlinePaymentsAdminResponseSchema = z.object({
  data: z.object({
    recovery: z.array(paymentRecoveryItemSchema),
    links: z.array(adminPaymentLinkSchema),
    refunds: z.array(adminPaymentLinkRefundSchema),
  }).strict(),
  request_id: z.string().min(1),
}).strict();

const note = z.string().trim().min(3).max(500);
export const resolvePaymentRecoveryRequestSchema = z.object({ note }).strict();
export const reconcilePaymentLinkRequestSchema = z.object({
  providerLinkId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).nullable(),
  checkoutUrl: z.string().regex(/^https:\/\/\S+$/).max(1000).nullable(),
  note,
}).strict().refine((value) => (value.providerLinkId === null) === (value.checkoutUrl === null), { message: "Informe o ID e o link juntos." });
export const requestPaymentLinkRefundRequestSchema = z.object({
  transactionId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  amountCents: z.number().int().min(1).max(999_999_998),
  reason: z.string().trim().min(3).max(300),
  recoveryItemId: z.uuid().nullable(),
}).strict();
export const reconcilePaymentLinkRefundRequestSchema = z.object({ processed: z.boolean(), note }).strict();
export const onlinePaymentActionResponseSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  request_id: z.string().min(1),
}).strict();
