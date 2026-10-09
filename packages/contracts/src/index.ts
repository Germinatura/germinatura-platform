import { moneyFromCents } from "@germinatura/domain";
import { z } from "zod";

export * from "./catalog-categories";
export * from "./catalog-products";
export * from "./catalog-product-images";
export * from "./catalog-product-prices";
export * from "./inventory-distribution";
export * from "./seller-stock-transfers";
export * from "./stock-returns";
export * from "./stock-losses";
export * from "./inventory-counts";
export * from "./cash-shifts";
export * from "./finance-entries";
export * from "./finance-treasury";
export * from "./payment-link-admin";
export * from "./raffle-pdv";
export * from "./share-campaigns";
export * from "./payment-links";
export * from "./management-indicators";
export * from "./fundraising-goal";
export * from "./audit";
export * from "./picpay-statement";
export * from "./picpay-reconciliation";
export * from "./portal-events";
export * from "./portal-showcase";

export const moneyCentsSchema = z.number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Money cents must be a safe integer")
  .transform(moneyFromCents);

export const idempotencyKeySchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const catalogSlugSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const productSkuSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$/);

export const catalogProductFlagsSchema = z.object({
  active: z.boolean(),
  published: z.boolean(),
  sellablePdv: z.boolean(),
  reservable: z.boolean(),
  tracksLots: z.boolean(),
});
export type CatalogProductFlags = z.infer<typeof catalogProductFlagsSchema>;

export const publicCatalogProductsQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PublicCatalogProductsQuery = z.infer<typeof publicCatalogProductsQuerySchema>;

export const publicCatalogProductSchema = z.object({
  id: z.uuid(),
  sku: productSkuSchema,
  slug: catalogSlugSchema,
  name: z.string().min(1).max(160),
  description: z.string().min(1).max(2000).nullable(),
  category: z.object({
    id: z.uuid(),
    slug: catalogSlugSchema,
    name: z.string().min(1).max(120),
  }),
  price: z.object({
    amountCents: moneyCentsSchema,
    currency: z.literal("BRL"),
  }),
  sellablePdv: z.boolean(),
  reservable: z.boolean(),
  // NOTIF-004 / spec 4.2: yes/no availability in the central (Portal) stock; quantities are never exposed.
  portalAvailable: z.boolean().optional(),
  images: z.array(z.object({
    id: z.uuid(),
    altText: z.string().trim().min(1).max(180),
    sortOrder: z.number().int().min(0).max(5),
    publicUrl: z.url(),
  })).max(6),
});
export type PublicCatalogProduct = z.infer<typeof publicCatalogProductSchema>;

export const publicCatalogProductsResponseSchema = z.object({
  data: z.array(publicCatalogProductSchema),
  nextCursor: z.uuid().nullable(),
  request_id: z.string().min(1),
});
export type PublicCatalogProductsResponse = z.infer<typeof publicCatalogProductsResponseSchema>;

export const pricingChannelSchema = z.enum(["PORTAL", "PDV"]);
/** Coupon codes are case-insensitive and normalized to upper case (PROMO-006). */
export const couponCodeSchema = z.string().trim().min(3).max(40)
  .regex(/^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/).transform((value) => value.toUpperCase());
export const pricingRoundingSchema = z.enum(["NONE", "FLOOR_PER_UNIT", "FLOOR_PER_LINE", "FLOOR_PER_UNIT_AND_LINE"]);
export const pricingQuoteRequestSchema = z.object({
  channel: pricingChannelSchema,
  couponCode: couponCodeSchema.optional(),
  items: z.array(z.object({
    productId: z.uuid(),
    quantity: z.number().int().positive().refine(Number.isSafeInteger, "Quantity must be a safe integer"),
  }).strict()).min(1).max(100),
}).strict().superRefine(({ items }, context) => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.productId)) {
      context.addIssue({ code: "custom", message: "Duplicate product", path: ["items", index, "productId"] });
    }
    seen.add(item.productId);
  }
});
export type PricingQuoteRequest = z.infer<typeof pricingQuoteRequestSchema>;

const appliedQuantityPromotionSchema = z.object({
  promotionId: z.uuid(),
  type: z.literal("QUANTIDADE_PRECO"),
  groupQuantity: z.number().int().min(2),
  groupPriceCents: moneyCentsSchema,
  groups: z.number().int().positive(),
  promotedQuantity: z.number().int().positive(),
  remainderQuantity: z.number().int().nonnegative(),
  savingsCents: moneyCentsSchema,
});
const appliedPercentagePromotionSchema = z.object({
  promotionId: z.uuid(),
  type: z.literal("PERCENTUAL"),
  percentageBasisPoints: z.number().int().min(1).max(9_999),
  discountedUnitPriceCents: moneyCentsSchema,
  savingsCents: moneyCentsSchema,
});
const appliedFixedUnitPricePromotionSchema = z.object({
  promotionId: z.uuid(),
  type: z.literal("VALOR_FIXO_UNITARIO"),
  fixedUnitPriceCents: moneyCentsSchema,
  savingsCents: moneyCentsSchema,
});
const appliedBuyPayPromotionSchema = z.object({
  promotionId: z.uuid(),
  type: z.literal("LEVE_PAGUE"),
  buyQuantity: z.number().int().min(2),
  payQuantity: z.number().int().positive(),
  groups: z.number().int().positive(),
  freeQuantity: z.number().int().positive(),
  savingsCents: moneyCentsSchema,
});
const appliedTieredPromotionSchema = z.object({
  promotionId: z.uuid(),
  type: z.literal("ESCALONADA"),
  minQuantity: z.number().int().min(2),
  percentageBasisPoints: z.number().int().min(1).max(9_999),
  discountedUnitPriceCents: moneyCentsSchema,
  savingsCents: moneyCentsSchema,
});
const appliedComboPromotionSchema = z.object({
  promotionId: z.uuid(),
  type: z.literal("COMBO_MIX"),
  comboPriceCents: moneyCentsSchema,
  combos: z.number().int().positive(),
  componentQuantity: z.number().int().positive(),
  savingsCents: moneyCentsSchema,
});
export const appliedCouponSchema = z.object({
  promotionId: z.uuid(),
  type: z.literal("CUPOM"),
  code: z.string().min(3).max(40),
  discountKind: z.enum(["PERCENTUAL", "VALOR_FIXO"]),
  percentageBasisPoints: z.number().int().min(1).max(9_999).nullable(),
  amountCents: moneyCentsSchema.nullable(),
  cumulative: z.boolean(),
  savingsCents: moneyCentsSchema,
});
export const appliedPromotionSchema = z.discriminatedUnion("type", [
  appliedCouponSchema,
  appliedQuantityPromotionSchema,
  appliedPercentagePromotionSchema,
  appliedFixedUnitPricePromotionSchema,
  appliedBuyPayPromotionSchema,
  appliedTieredPromotionSchema,
  appliedComboPromotionSchema,
]);
export const pricingQuoteResponseSchema = z.object({
  data: z.object({
    channel: pricingChannelSchema,
    quotedAt: z.iso.datetime({ offset: true }),
    currency: z.literal("BRL"),
    rounding: pricingRoundingSchema,
    coupon: z.object({ code: z.string().min(3).max(40), applied: z.boolean() }).strict().nullable(),
    lines: z.array(z.object({
      productId: z.uuid(),
      name: z.string().min(1),
      unitPriceCents: moneyCentsSchema,
      quantity: z.number().int().positive(),
      originalSubtotalCents: moneyCentsSchema,
      discountCents: moneyCentsSchema,
      totalCents: moneyCentsSchema,
      appliedPromotion: appliedPromotionSchema.nullable(),
      appliedCoupon: appliedCouponSchema.nullable(),
    })),
    originalTotalCents: moneyCentsSchema,
    discountTotalCents: moneyCentsSchema,
    totalCents: moneyCentsSchema,
  }),
  request_id: z.string().min(1),
});
export type PricingQuoteResponse = z.infer<typeof pricingQuoteResponseSchema>;

export const saleStatusSchema = z.enum([
  "DRAFT",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "CANCELLED",
]);
export type SaleStatus = z.infer<typeof saleStatusSchema>;

export const saleItemSnapshotSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  productSku: productSkuSchema,
  productName: z.string().min(1).max(160),
  quantity: z.number().int().positive().refine(Number.isSafeInteger, "Quantity must be a safe integer"),
  unitPriceCents: moneyCentsSchema,
  originalSubtotalCents: moneyCentsSchema,
  discountCents: moneyCentsSchema,
  totalCents: moneyCentsSchema,
  promotionId: z.uuid().nullable(),
  promotionSnapshot: z.record(z.string(), z.unknown()).nullable(),
}).strict();
export type SaleItemSnapshot = z.infer<typeof saleItemSnapshotSchema>;

export const saleSchema = z.object({
  id: z.uuid(),
  channel: pricingChannelSchema,
  locationId: z.uuid(),
  createdBy: z.uuid(),
  customerId: z.uuid().nullable(),
  status: saleStatusSchema,
  currency: z.literal("BRL"),
  originalTotalCents: moneyCentsSchema,
  discountTotalCents: moneyCentsSchema,
  totalCents: moneyCentsSchema,
  quotedAt: z.iso.datetime({ offset: true }),
  correlationId: z.uuid(),
  items: z.array(saleItemSnapshotSchema).min(1).max(100),
}).strict();
export type Sale = z.infer<typeof saleSchema>;

export const paymentAttemptStatusSchema = z.enum([
  "CREATED",
  "PENDING",
  "AWAITING_EXTERNAL_CONFIRMATION",
  "APPROVED",
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
  "REFUNDED",
  "RECONCILIATION_PENDING",
  "RECONCILED",
]);
export type PaymentAttemptStatus = z.infer<typeof paymentAttemptStatusSchema>;

export const paymentIntegrationChannelSchema = z.enum([
  "PIX_AREA",
  "CHECKOUT_API",
  "PICPAY_WALLET",
  "PAYMENT_LINK",
  "MAQUININHA",
  "TAP",
  "DINHEIRO",
]);
export type PaymentIntegrationChannel = z.infer<typeof paymentIntegrationChannelSchema>;

export const paymentConfirmationSourceSchema = z.enum([
  "WEBHOOK",
  "STATUS_QUERY",
  "MANUAL",
  "RECONCILIATION_IMPORT",
]);
export type PaymentConfirmationSource = z.infer<typeof paymentConfirmationSourceSchema>;

export const salesCheckoutRequestSchema = pricingQuoteRequestSchema.extend({
  locationId: z.uuid(),
}).strict();
export type SalesCheckoutRequest = z.infer<typeof salesCheckoutRequestSchema>;

export const salesCheckoutResponseSchema = z.object({
  data: z.object({
    saleId: z.uuid(),
    status: z.literal("AWAITING_PAYMENT"),
    channel: pricingChannelSchema,
    locationId: z.uuid(),
    quote: pricingQuoteResponseSchema.shape.data,
    reservation: z.object({
      reservationId: z.uuid(),
      status: z.literal("ACTIVE"),
      expiresAt: z.iso.datetime({ offset: true }),
      reservationMovementId: z.uuid(),
    }).strict(),
    paymentAttempt: z.object({
      attemptId: z.uuid(),
      status: z.literal("CREATED"),
      amountCents: moneyCentsSchema,
      integrationChannel: z.null(),
      confirmationSource: z.null(),
    }).strict(),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type SalesCheckoutResponse = z.infer<typeof salesCheckoutResponseSchema>;

export const confirmedSaleReversalRequestSchema = z.object({
  reason: z.string().trim().min(8).max(500),
  refundReference: z.string().trim().min(4).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$/)
    .refine((value) => !/[0-9]{12,}/.test(value), "A referência não pode conter dados de cartão"),
  // PAY-009a: open shift whose drawer physically hands the cash back; omitted when refunded by other means.
  cashPayoutShiftId: z.uuid().nullable().optional(),
}).strict();
export type ConfirmedSaleReversalRequest = z.infer<typeof confirmedSaleReversalRequestSchema>;

export const salesCancelResponseSchema = z.object({
  data: z.union([z.object({
    saleId: z.uuid(),
    status: z.literal("CANCELLED"),
    reservation: z.object({
      reservationId: z.uuid(),
      status: z.enum(["RELEASED", "EXPIRED"]),
      releaseMovementId: z.uuid().nullable(),
    }).strict(),
    paymentAttempt: z.object({
      attemptId: z.uuid(),
      status: z.literal("CANCELLED"),
    }).strict(),
    correlationId: z.uuid(),
  }).strict(), z.object({
    saleId: z.uuid(),
    status: z.literal("CANCELLED"),
    paymentAttempt: z.object({
      attemptId: z.uuid(),
      status: z.literal("REFUNDED"),
    }).strict(),
    reversal: z.object({
      stockMovementId: z.uuid().nullable(),
      refundEntryId: z.uuid(),
      amountCents: moneyCentsSchema,
      refundReference: z.string().min(4).max(128),
      cashPayout: z.object({
        movementId: z.uuid(),
        shiftId: z.uuid(),
        amountCents: moneyCentsSchema,
      }).strict().nullable(),
      raffle: z.object({ campaignId: z.uuid(), numbers: z.array(z.number().int().positive()) }).strict().nullable(),
    }).strict(),
    correlationId: z.uuid(),
  }).strict()]),
  request_id: z.string().min(1),
}).strict();
export type SalesCancelResponse = z.infer<typeof salesCancelResponseSchema>;

// Spec 6.7: card method of a card-present payment; meal vouchers depend on the meal_voucher flag.
export const cardPaymentMethodSchema = z.enum(["CREDITO", "DEBITO", "VOUCHER_ALIMENTACAO", "VOUCHER_REFEICAO"]);
export type CardPaymentMethod = z.infer<typeof cardPaymentMethodSchema>;

// Spec 6.10: PDV "Minhas vendas" — the seller's own sales, pending ones highlighted.
export const mySalesFilterSchema = z.enum(["PENDING", "CONFIRMED", "CANCELLED"]);
export type MySalesFilter = z.infer<typeof mySalesFilterSchema>;

export const mySalesQuerySchema = z.object({
  filter: mySalesFilterSchema.optional(),
  cursor: z.uuid().optional(),
}).strict();

export const mySaleSchema = z.object({
  saleId: z.uuid(),
  status: saleStatusSchema.exclude(["DRAFT"]),
  channel: z.enum(["PDV", "RESERVA"]),
  createdAt: z.iso.datetime({ offset: true }),
  locationId: z.uuid(),
  originalTotalCents: moneyCentsSchema,
  discountTotalCents: moneyCentsSchema,
  totalCents: moneyCentsSchema,
  pendingReason: z.enum(["AWAITING_PAYMENT", "RECONCILIATION_PENDING"]).nullable(),
  reservationExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  payment: z.object({
    attemptId: z.uuid(),
    status: paymentAttemptStatusSchema,
    integrationChannel: paymentIntegrationChannelSchema.nullable(),
    confirmationSource: paymentConfirmationSourceSchema.nullable(),
    confirmedAt: z.iso.datetime({ offset: true }).nullable(),
    cardMethod: cardPaymentMethodSchema.nullable(),
    terminalCode: z.string().nullable(),
  }).strict().nullable(),
  items: z.array(z.object({
    productName: z.string().min(1).max(160),
    quantity: z.number().int().positive().refine(Number.isSafeInteger, "Quantity must be a safe integer"),
    totalCents: moneyCentsSchema,
  }).strict()).max(100),
}).strict();
export type MySale = z.infer<typeof mySaleSchema>;

export const mySalesResponseSchema = z.object({
  data: z.array(mySaleSchema),
  nextCursor: z.uuid().nullable(),
  pendingCount: z.number().int().nonnegative(),
  request_id: z.string().min(1),
}).strict();
export type MySalesResponse = z.infer<typeof mySalesResponseSchema>;

// Etapa 6: finance sale list and detail. Dates are São Paulo calendar days (YYYY-MM-DD), both inclusive.
const saleChannelSchema = z.enum(["PORTAL", "PDV", "RESERVA"]);
const calendarDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const adminSalesQuerySchema = z.object({
  status: saleStatusSchema.exclude(["DRAFT"]).optional(),
  channel: saleChannelSchema.optional(),
  pending: z.enum(["true", "false"]).optional(),
  from: calendarDaySchema.optional(),
  to: calendarDaySchema.optional(),
  cursor: z.uuid().optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, { message: "Período inválido", path: ["to"] });

export const adminSaleSchema = z.object({
  saleId: z.uuid(),
  status: saleStatusSchema.exclude(["DRAFT"]),
  channel: saleChannelSchema,
  createdAt: z.iso.datetime({ offset: true }),
  locationId: z.uuid(),
  locationName: z.string(),
  sellerId: z.uuid(),
  sellerName: z.string(),
  originalTotalCents: moneyCentsSchema,
  discountTotalCents: moneyCentsSchema,
  totalCents: moneyCentsSchema,
  pendingReason: z.enum(["AWAITING_PAYMENT", "RECONCILIATION_PENDING"]).nullable(),
  payment: z.object({
    attemptId: z.uuid(),
    status: paymentAttemptStatusSchema,
    integrationChannel: paymentIntegrationChannelSchema.nullable(),
    confirmationSource: paymentConfirmationSourceSchema.nullable(),
    confirmedAt: z.iso.datetime({ offset: true }).nullable(),
    proofReference: z.string().nullable(),
    cardMethod: cardPaymentMethodSchema.nullable(),
    terminalCode: z.string().nullable(),
  }).strict().nullable(),
}).strict();
export type AdminSale = z.infer<typeof adminSaleSchema>;

export const adminSalesResponseSchema = z.object({
  data: z.array(adminSaleSchema),
  nextCursor: z.uuid().nullable(),
  request_id: z.string().min(1),
}).strict();

export const adminSaleDetailSchema = adminSaleSchema.extend({
  items: z.array(z.object({
    productName: z.string(),
    productSku: z.string(),
    quantity: z.number().int().positive(),
    unitPriceCents: moneyCentsSchema,
    discountCents: moneyCentsSchema,
    totalCents: moneyCentsSchema,
  }).strict()),
  ledger: z.array(z.object({
    id: z.uuid(),
    entryType: z.string(),
    amountCents: z.number().int().refine(Number.isSafeInteger),
    createdAt: z.iso.datetime({ offset: true }),
    refundMethod: z.enum(["OTHER", "CASH_DRAWER"]).nullable(),
    reference: z.string().nullable(),
  }).strict()),
  cashMovements: z.array(z.object({
    id: z.uuid(),
    movementType: z.enum(["OPENING_FLOAT", "SALE_RECEIPT", "REFUND_PAYOUT"]),
    amountCents: z.number().int().refine(Number.isSafeInteger),
    shiftId: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
  }).strict()),
  history: z.array(z.object({
    fromStatus: saleStatusSchema.nullable(),
    toStatus: saleStatusSchema,
    reason: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  }).strict()),
  reversal: z.object({
    allowed: z.boolean(),
    blockedReason: z.string().nullable(),
    cashPayoutAllowed: z.boolean(),
  }).strict(),
  // RAF-005: numbers held (or refunded) by a raffle sale.
  raffle: z.object({
    campaignId: z.uuid(),
    campaignName: z.string(),
    campaignStatus: z.string(),
    numbers: z.array(z.number().int().positive()),
  }).strict().nullable(),
}).strict();
export type AdminSaleDetail = z.infer<typeof adminSaleDetailSchema>;

export const adminSaleDetailResponseSchema = z.object({
  data: adminSaleDetailSchema,
  request_id: z.string().min(1),
}).strict();

export const commercialReservationCreateRequestSchema = z.object({
  // RES-004: omitted by the Portal cart; the server holds Portal reservations at the central location.
  locationId: z.uuid().optional(),
  couponCode: couponCodeSchema.optional(),
  items: z.array(z.object({
    productId: z.uuid(),
    quantity: z.number().int().positive().refine(Number.isSafeInteger),
  }).strict()).min(1).max(100),
}).strict();
export type CommercialReservationCreateRequest = z.infer<typeof commercialReservationCreateRequestSchema>;

export const commercialReservationCreateResponseSchema = z.object({
  data: z.object({
    reservationId: z.uuid(),
    status: z.literal("ACTIVE"),
    locationId: z.uuid(),
    quote: pricingQuoteResponseSchema.shape.data,
    stockReservation: z.object({
      reservationId: z.uuid(),
      status: z.literal("ACTIVE"),
      expiresAt: z.iso.datetime({ offset: true }),
      reservationMovementId: z.uuid(),
    }).strict(),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type CommercialReservationCreateResponse = z.infer<typeof commercialReservationCreateResponseSchema>;

export const commercialReservationCancelResponseSchema = z.object({
  data: z.object({
    reservationId: z.uuid(),
    status: z.enum(["CANCELLED", "EXPIRED"]),
    stockReservation: z.object({
      reservationId: z.uuid(),
      status: z.enum(["RELEASED", "EXPIRED"]),
      releaseMovementId: z.uuid().nullable(),
    }).strict(),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type CommercialReservationCancelResponse = z.infer<typeof commercialReservationCancelResponseSchema>;

export const commercialReservationConvertResponseSchema = z.object({
  data: z.discriminatedUnion("status", [
    z.object({
      reservationId: z.uuid(),
      status: z.literal("CONVERTED"),
      saleId: z.uuid(),
      saleStatus: z.literal("AWAITING_PAYMENT"),
      paymentAttemptId: z.uuid(),
      stockReservationId: z.uuid(),
      totalCents: moneyCentsSchema,
      correlationId: z.uuid(),
    }).strict(),
    z.object({
      reservationId: z.uuid(),
      status: z.literal("EXPIRED"),
      saleId: z.null(),
      paymentAttemptId: z.null(),
      correlationId: z.uuid(),
    }).strict(),
  ]),
  request_id: z.string().min(1),
}).strict();
export type CommercialReservationConvertResponse = z.infer<typeof commercialReservationConvertResponseSchema>;

// Spec 4.3 / 5.10 (RES-002): reservation administration by the commission.
export const commercialReservationStatusSchema = z.enum(["ACTIVE", "READY", "CONVERTED", "COMPLETED", "CANCELLED", "EXPIRED"]);
export type CommercialReservationStatus = z.infer<typeof commercialReservationStatusSchema>;

export const reservationSettingsSchema = z.object({
  holdHours: z.number().int().min(1).max(720),
  pickupHours: z.number().int().min(1).max(720),
}).strict();
export type ReservationSettings = z.infer<typeof reservationSettingsSchema>;
export const reservationSettingsResponseSchema = z.object({ data: reservationSettingsSchema, request_id: z.string().min(1) }).strict();

export const markReservationReadyRequestSchema = z.object({
  pickupInstructions: z.string().trim().min(3).max(500).nullable(),
}).strict();

export const adminReservationsQuerySchema = z.object({
  status: commercialReservationStatusSchema.optional(),
  query: z.string().trim().min(1).max(80).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.uuid().optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, { message: "Período inválido", path: ["to"] });

export const adminReservationSchema = z.object({
  reservationId: z.uuid(),
  status: commercialReservationStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
  customerId: z.uuid(),
  customerName: z.string(),
  locationName: z.string(),
  totalCents: moneyCentsSchema,
  discountTotalCents: moneyCentsSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  readyAt: z.iso.datetime({ offset: true }).nullable(),
  pickupDeadline: z.iso.datetime({ offset: true }).nullable(),
  pickupInstructions: z.string().nullable(),
  convertedSaleId: z.uuid().nullable(),
  items: z.array(z.object({ productName: z.string(), quantity: z.number().int().positive(), totalCents: moneyCentsSchema }).strict()),
}).strict();
export type AdminReservation = z.infer<typeof adminReservationSchema>;

// RES-003: pickup of a prepared reservation at the PDV, charged at the frozen reservation price.
export const pickupReservationSchema = z.object({
  reservationId: z.uuid(),
  customerName: z.string(),
  locationId: z.uuid(),
  locationName: z.string(),
  totalCents: moneyCentsSchema,
  discountTotalCents: moneyCentsSchema,
  // RES-005: an order paid online has no preparation window; it is delivered without charging.
  readyAt: z.iso.datetime({ offset: true }).nullable(),
  pickupDeadline: z.iso.datetime({ offset: true }).nullable(),
  pickupInstructions: z.string().nullable(),
  paidOnline: z.boolean(),
  paidAt: z.iso.datetime({ offset: true }).nullable(),
  items: z.array(z.object({ productName: z.string(), quantity: z.number().int().positive(), totalCents: moneyCentsSchema }).strict()),
}).strict();
export type PickupReservation = z.infer<typeof pickupReservationSchema>;

export const pickupReservationsResponseSchema = z.object({
  data: z.array(pickupReservationSchema),
  request_id: z.string().min(1),
}).strict();

export const completePickupRequestSchema = z.object({
  integrationChannel: z.enum(["DINHEIRO", "MAQUININHA", "PIX_AREA"]),
  tenderedCents: moneyCentsSchema.nullable(),
  proofReference: z.string().min(4).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$/)
    .refine((value) => !/[0-9]{12,}/.test(value), "A referência não pode conter dados de cartão").nullable(),
  cardMethod: cardPaymentMethodSchema.nullable(),
  terminalId: z.uuid().nullable(),
}).strict().superRefine((value, context) => {
  if (value.integrationChannel === "DINHEIRO") {
    if (value.tenderedCents === null) context.addIssue({ code: "custom", path: ["tenderedCents"], message: "Informe o valor recebido" });
    if (value.proofReference || value.cardMethod || value.terminalId) context.addIssue({ code: "custom", path: ["integrationChannel"], message: "Dinheiro não tem comprovante nem cartão" });
  } else {
    if (value.tenderedCents !== null) context.addIssue({ code: "custom", path: ["tenderedCents"], message: "Só dinheiro tem valor recebido" });
    if (!value.proofReference) context.addIssue({ code: "custom", path: ["proofReference"], message: "Informe a referência não sensível" });
    if (value.integrationChannel === "MAQUININHA" && !value.cardMethod) context.addIssue({ code: "custom", path: ["cardMethod"], message: "Informe crédito ou débito" });
    if (value.integrationChannel === "PIX_AREA" && (value.cardMethod || value.terminalId)) context.addIssue({ code: "custom", path: ["cardMethod"], message: "Área Pix não tem cartão" });
  }
});
export type CompletePickupRequest = z.infer<typeof completePickupRequestSchema>;

export const completePickupResponseSchema = z.object({
  data: z.object({
    reservationId: z.uuid(),
    status: z.literal("COMPLETED"),
    saleId: z.uuid(),
    totalCents: moneyCentsSchema,
    integrationChannel: z.enum(["DINHEIRO", "MAQUININHA", "PIX_AREA"]),
    changeCents: moneyCentsSchema.nullable(),
    cardMethod: cardPaymentMethodSchema.nullable(),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type CompletePickupResponse = z.infer<typeof completePickupResponseSchema>;

// RES-005: hands over an order already paid online, without a second charge.
export const deliverPaidPickupResponseSchema = z.object({
  data: z.object({
    reservationId: z.uuid(),
    status: z.literal("COMPLETED"),
    saleId: z.uuid(),
    totalCents: moneyCentsSchema,
    paidOnline: z.literal(true),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type DeliverPaidPickupResponse = z.infer<typeof deliverPaidPickupResponseSchema>;

export const adminReservationsResponseSchema = z.object({
  data: z.array(adminReservationSchema),
  nextCursor: z.uuid().nullable(),
  request_id: z.string().min(1),
}).strict();

// Spec 5.11: DRAFT is editable; ACTIVE and PAUSED sell; CLOSED freezes the eligible universe; DRAWN and CANCELLED are final.
export const raffleCampaignStatusSchema = z.enum(["DRAFT", "ACTIVE", "PAUSED", "CLOSED", "DRAWN", "CANCELLED"]);
export type RaffleCampaignStatus = z.infer<typeof raffleCampaignStatusSchema>;

export const raffleCampaignCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  productId: z.uuid(),
  locationId: z.uuid(),
  numberCount: z.number().int().min(1).max(10000),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
}).strict().refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), {
  path: ["endsAt"], message: "Campaign end must be after start",
});
export type RaffleCampaignCreateRequest = z.infer<typeof raffleCampaignCreateRequestSchema>;

export const raffleCampaignUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable(),
  productId: z.uuid(),
  locationId: z.uuid(),
  numberCount: z.number().int().min(1).max(10000),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
}).strict().refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), {
  path: ["endsAt"], message: "Campaign end must be after start",
});
export const raffleCampaignTransitionRequestSchema = z.object({ action: z.enum(["PUBLISH", "PAUSE", "RESUME", "CLOSE"]) }).strict();
export const raffleCampaignCancelRequestSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

export const adminRaffleCampaignSchema = z.object({
  campaignId: z.uuid(), name: z.string(), description: z.string().nullable(), productId: z.uuid(), productName: z.string(),
  locationId: z.uuid(), status: raffleCampaignStatusSchema, numberCount: z.number().int(),
  startsAt: z.string(), endsAt: z.string(), publishedAt: z.string().nullable(), closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(), cancelReason: z.string().nullable(),
  availableCount: z.number().int(), reservedCount: z.number().int(), paidCount: z.number().int(),
  paidTotalCents: z.number().int(), paidSales: z.number().int(),
  draw: z.object({
    winnerNumber: z.number().int(), winnerIndex: z.number().int(), eligibleNumbers: z.array(z.number().int()),
    randomMaterial: z.string(), auditHash: z.string(), drawnAt: z.string(),
  }).strict().nullable(),
}).strict();
export type AdminRaffleCampaign = z.infer<typeof adminRaffleCampaignSchema>;

// RAF-006 / spec 15.5: buyers and contacts, visible to raffle managers only.
export const adminRaffleBuyerSchema = z.object({
  saleId: z.uuid(), numbers: z.array(z.number().int().positive()), status: z.enum(["RESERVED", "PAID", "REFUNDED"]),
  channel: z.string(), registered: z.boolean(), buyerName: z.string().nullable(), buyerContact: z.string().nullable(),
  sellerName: z.string().nullable(), totalCents: z.number().int().nonnegative(), createdAt: z.string(), won: z.boolean(),
}).strict();
export type AdminRaffleBuyer = z.infer<typeof adminRaffleBuyerSchema>;
export const adminRaffleBuyersResponseSchema = z.object({ data: z.array(adminRaffleBuyerSchema), request_id: z.string().min(1) }).strict();

export const raffleCampaignResponseSchema = z.object({
  data: z.object({
    campaignId: z.uuid(), status: raffleCampaignStatusSchema,
    numberCount: z.number().int().min(1).max(10000).optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
    correlationId: z.uuid(),
    releasedReservations: z.number().int().nonnegative().optional(),
    paidSalesToRefund: z.number().int().nonnegative().optional(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type RaffleCampaignResponse = z.infer<typeof raffleCampaignResponseSchema>;

export const raffleNumberReservationRequestSchema = z.object({
  numbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100),
}).strict().refine((value) => new Set(value.numbers).size === value.numbers.length, {
  path: ["numbers"], message: "Raffle numbers must be unique",
});
export type RaffleNumberReservationRequest = z.infer<typeof raffleNumberReservationRequestSchema>;

export const raffleNumberReservationResponseSchema = z.object({
  data: z.object({
    campaignId: z.uuid(), numbers: z.array(z.number().int().positive()).min(1),
    status: z.literal("RESERVED"), saleId: z.uuid(), saleStatus: z.literal("AWAITING_PAYMENT"),
    paymentAttemptId: z.uuid(), totalCents: moneyCentsSchema,
    expiresAt: z.iso.datetime({ offset: true }), correlationId: z.uuid(),
  }).strict(), request_id: z.string().min(1),
}).strict();
export type RaffleNumberReservationResponse = z.infer<typeof raffleNumberReservationResponseSchema>;

export const raffleDrawResponseSchema = z.object({
  data: z.object({
    drawId: z.uuid(), campaignId: z.uuid(),
    eligibleNumbers: z.array(z.number().int().positive()).min(1),
    randomMaterial: z.string().regex(/^[0-9a-f]{64}$/),
    auditHash: z.string().regex(/^[0-9a-f]{64}$/),
    winnerIndex: z.number().int().positive(), winnerNumber: z.number().int().positive(),
    correlationId: z.uuid(),
  }).strict(), request_id: z.string().min(1),
}).strict();
export type RaffleDrawResponse = z.infer<typeof raffleDrawResponseSchema>;

export const paymentTerminalSchema = z.object({
  id: z.uuid(),
  code: z.string().regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/).min(2).max(32),
  label: z.string().min(2).max(80),
  active: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type PaymentTerminal = z.infer<typeof paymentTerminalSchema>;

export const paymentTerminalsResponseSchema = z.object({
  data: z.array(paymentTerminalSchema),
  request_id: z.string().min(1),
}).strict();

export const savePaymentTerminalRequestSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, "Use letras, números e hífen").min(2).max(32),
  label: z.string().trim().min(2).max(80),
  active: z.boolean(),
}).strict();
export type SavePaymentTerminalRequest = z.infer<typeof savePaymentTerminalRequestSchema>;

export const paymentTerminalResponseSchema = z.object({
  data: paymentTerminalSchema,
  request_id: z.string().min(1),
}).strict();

export const manualPaymentConfirmationRequestSchema = z.object({
  integrationChannel: z.enum(["MAQUININHA", "PIX_AREA"]),
  proofReference: z.string().min(4).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$/)
    .refine((value) => !/[0-9]{12,}/.test(value), "A referência não pode conter dados de cartão"),
  cardMethod: cardPaymentMethodSchema.nullable().optional(),
  terminalId: z.uuid().nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.integrationChannel === "MAQUININHA" && !value.cardMethod) {
    context.addIssue({ code: "custom", path: ["cardMethod"], message: "Informe crédito, débito ou voucher" });
  }
  if (value.integrationChannel === "PIX_AREA" && (value.cardMethod || value.terminalId)) {
    context.addIssue({ code: "custom", path: ["cardMethod"], message: "Área Pix não tem método de cartão nem terminal" });
  }
});
export type ManualPaymentConfirmationRequest = z.infer<typeof manualPaymentConfirmationRequestSchema>;

export const manualPaymentConfirmationResponseSchema = z.object({
  data: z.object({
    saleId: z.uuid(),
    saleStatus: z.literal("CONFIRMED"),
    paymentAttempt: z.object({
      attemptId: z.uuid(),
      status: z.literal("APPROVED"),
      amountCents: moneyCentsSchema,
      integrationChannel: z.enum(["MAQUININHA", "PIX_AREA"]),
      confirmationSource: z.literal("MANUAL"),
      confirmedAt: z.iso.datetime({ offset: true }),
      proofReference: z.string().min(4).max(128),
      cardMethod: cardPaymentMethodSchema.nullable(),
      terminal: z.object({ id: z.uuid(), code: z.string(), label: z.string() }).strict().nullable(),
    }).strict(),
    // Raffle tickets hold numbers, not stock, so their confirmation reports the numbers instead of a stock movement.
    stock: z.union([
      z.object({ reservationId: z.uuid(), status: z.literal("CONSUMED"), saleMovementId: z.uuid() }).strict(),
      z.object({ status: z.literal("RAFFLE_TICKETS"), raffleNumbers: z.array(z.number().int().positive()).min(1) }).strict(),
    ]),
    financialLedgerEntryId: z.uuid(),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type ManualPaymentConfirmationResponse = z.infer<typeof manualPaymentConfirmationResponseSchema>;

export const paymentReconciliationRequestSchema = z.object({
  observedAmountCents: moneyCentsSchema.refine((value) => value > 0, "Observed amount must be positive"),
  feeAmountCents: moneyCentsSchema,
  externalReference: z.string().min(4).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$/)
    .refine((value) => !/[0-9]{12,}/.test(value), "A referência não pode conter dados de cartão"),
}).strict().superRefine(({ observedAmountCents, feeAmountCents }, context) => {
  if (feeAmountCents >= observedAmountCents) {
    context.addIssue({
      code: "custom",
      path: ["feeAmountCents"],
      message: "Fee must be lower than the observed amount",
    });
  }
});
export type PaymentReconciliationRequest = z.infer<typeof paymentReconciliationRequestSchema>;

export const paymentReconciliationResponseSchema = z.object({
  data: z.object({
    reconciliationId: z.uuid(),
    attemptId: z.uuid(),
    paymentStatus: z.enum(["RECONCILIATION_PENDING", "RECONCILED"]),
    outcome: z.enum(["DIVERGENT", "MATCHED"]),
    expectedAmountCents: moneyCentsSchema,
    observedAmountCents: moneyCentsSchema,
    feeAmountCents: moneyCentsSchema,
    netAmountCents: moneyCentsSchema,
    source: z.literal("MANUAL"),
    externalReference: z.string().min(4).max(128),
    ledger: z.object({
      feeEntryId: z.uuid().nullable(),
      settlementEntryId: z.uuid().nullable(),
      divergenceEntryId: z.uuid().nullable(),
    }).strict(),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type PaymentReconciliationResponse = z.infer<typeof paymentReconciliationResponseSchema>;

export const sellerCloseoutRequestSchema = z.object({
  periodStart: z.iso.datetime({ offset: true }),
  periodEnd: z.iso.datetime({ offset: true }),
  stockCounts: z.array(z.object({
    productId: z.uuid(),
    countedQuantity: z.number().int().nonnegative().refine(Number.isSafeInteger, "Quantity must be a safe integer"),
  }).strict()).min(1).max(500),
  justification: z.string().trim().min(4).max(500).nullable().default(null),
}).strict().superRefine(({ periodStart, periodEnd, stockCounts }, context) => {
  if (new Date(periodStart).getTime() >= new Date(periodEnd).getTime()) {
    context.addIssue({ code: "custom", path: ["periodEnd"], message: "Period end must be after start" });
  }
  const seen = new Set<string>();
  for (const [index, item] of stockCounts.entries()) {
    if (seen.has(item.productId)) context.addIssue({ code: "custom", path: ["stockCounts", index, "productId"], message: "Duplicate product" });
    seen.add(item.productId);
  }
});
export type SellerCloseoutRequest = z.infer<typeof sellerCloseoutRequestSchema>;

const sellerCloseoutPaymentSummarySchema = z.object({
  integrationChannel: paymentIntegrationChannelSchema,
  paymentCount: z.number().int().nonnegative(),
  totalCents: moneyCentsSchema,
}).strict();

const sellerCloseoutStockCountSchema = z.object({
  productId: z.uuid(),
  expectedQuantity: z.number().int().nonnegative(),
  countedQuantity: z.number().int().nonnegative(),
  differenceQuantity: z.number().int(),
}).strict();

export const sellerCloseoutResponseSchema = z.object({
  data: z.object({
    closeoutId: z.uuid(),
    sellerId: z.uuid(),
    locationId: z.uuid(),
    status: z.literal("CLOSED"),
    periodStart: z.iso.datetime({ offset: true }),
    periodEnd: z.iso.datetime({ offset: true }),
    confirmedSalesCount: z.number().int().nonnegative(),
    confirmedSalesTotalCents: moneyCentsSchema,
    paymentCount: z.number().int().nonnegative(),
    paymentTotalCents: moneyCentsSchema,
    paymentDifferenceCents: z.number().int().refine(Number.isSafeInteger),
    stockDifferenceUnits: z.number().int().nonnegative(),
    justification: z.string().min(4).max(500).nullable(),
    paymentSummaries: z.array(sellerCloseoutPaymentSummarySchema),
    stockCounts: z.array(sellerCloseoutStockCountSchema),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type SellerCloseoutResponse = z.infer<typeof sellerCloseoutResponseSchema>;

export const reopenSellerCloseoutRequestSchema = z.object({
  reason: z.string().trim().min(4).max(500),
}).strict();

export const reopenSellerCloseoutResponseSchema = z.object({
  data: z.object({
    closeoutId: z.uuid(),
    status: z.literal("REOPENED"),
    reopenedAt: z.iso.datetime({ offset: true }),
    reopenedBy: z.uuid(),
    reopenReason: z.string().min(4).max(500),
    correlationId: z.uuid(),
  }).strict(),
  request_id: z.string().min(1),
}).strict();

export const stockMovementTypeSchema = z.enum([
  "SALDO_INICIAL",
  "ENTRADA_COMPRA",
  "TRANSFERENCIA",
  "VENDA",
  "RESERVA",
  "LIBERACAO_RESERVA",
  "PERDA",
  "VENCIMENTO",
  "DEVOLUCAO",
  "AJUSTE_POSITIVO",
  "AJUSTE_NEGATIVO",
  "CANCELAMENTO_VENDA",
]);
export type StockMovementType = z.infer<typeof stockMovementTypeSchema>;

export const stockReservationStatusSchema = z.enum([
  "ACTIVE",
  "CONSUMED",
  "RELEASED",
  "EXPIRED",
]);
export type StockReservationStatus = z.infer<typeof stockReservationStatusSchema>;

export const stockReservationItemSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().positive().refine(Number.isSafeInteger, "Quantity must be a safe integer"),
});
export type StockReservationItem = z.infer<typeof stockReservationItemSchema>;

export const idempotencyStatusSchema = z.enum([
  "IN_PROGRESS",
  "SUCCEEDED",
  "REJECTED",
  "FAILED",
]);
export type IdempotencyStatus = z.infer<typeof idempotencyStatusSchema>;

export const appRoleSchema = z.enum([
  "ADMIN",
  "VENDEDOR",
  "ESTOQUE",
  "FINANCEIRO",
  "COMUNICACAO",
  "MODERADOR",
  "CONSUMIDOR",
]);
export type AppRole = z.infer<typeof appRoleSchema>;

// ADR 0011: ADMIN_MASTER is a global capability (admin_masters), never a role granted per cohort, so it is not an
// AppRole (the roles that can be assigned). The session lists it next to the roles of the request cohort.
export const sessionRoleSchema = z.enum([...appRoleSchema.options, "ADMIN_MASTER"]);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

// Cohort context of a request: a concrete cohort, every cohort ("ALL", ADMIN_MASTER only, read/aggregate) or none.
export const COHORT_HEADER = "x-germinatura-cohort";
export const cohortSelectionSchema = z.union([z.uuid(), z.literal("all")]);
export type CohortSelection = z.infer<typeof cohortSelectionSchema>;
export const cohortModeSchema = z.enum(["COHORT", "ALL", "NONE"]);
export type CohortMode = z.infer<typeof cohortModeSchema>;
export const cohortStatusSchema = z.enum(["PREPARING", "ACTIVE", "ARCHIVED"]);
export type CohortStatus = z.infer<typeof cohortStatusSchema>;
export const cohortSummarySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  year: z.number().int(),
  slug: z.string().min(1),
  status: cohortStatusSchema,
  isDefault: z.boolean().optional(),
}).strict();
export type CohortSummary = z.infer<typeof cohortSummarySchema>;
export const cohortSelectionRequestSchema = z.object({ cohort: cohortSelectionSchema }).strict();

// ADR 0011: cohort administration (ADMIN_MASTER only; global operations, allowed in "Todas as turmas").
const cohortNameSchema = z.string().trim().min(3).max(80);
export const cohortCreateRequestSchema = z.object({
  name: cohortNameSchema,
  year: z.number().int().min(2000).max(2100),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60),
  status: z.enum(["PREPARING", "ACTIVE"]),
}).strict();
export type CohortCreateRequest = z.infer<typeof cohortCreateRequestSchema>;
export const cohortUpdateRequestSchema = z.object({
  name: cohortNameSchema,
  status: cohortStatusSchema,
  reason: z.string().trim().min(4).max(500),
}).strict();
export type CohortUpdateRequest = z.infer<typeof cohortUpdateRequestSchema>;
export const cohortResponseSchema = z.object({ data: cohortSummarySchema, request_id: z.string() }).strict();
export const cohortListResponseSchema = z.object({ data: z.array(cohortSummarySchema), request_id: z.string() }).strict();
export const adminMasterUpdateRequestSchema = z.object({
  granted: z.boolean(),
  reason: z.string().trim().min(4).max(500),
}).strict();

// Spec 5.15 (NOTIF-003): announcements to everyone, to roles or to specific users by e-mail.
export const publishAnnouncementRequestSchema = z.object({
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(3).max(1000),
  all: z.boolean(),
  roles: z.array(appRoleSchema).max(7),
  emails: z.array(z.string().trim().toLowerCase().pipe(z.email())).max(200),
}).strict().refine((value) => value.all || value.roles.length > 0 || value.emails.length > 0, {
  message: "Escolha para quem enviar", path: ["roles"],
});
export type PublishAnnouncementRequest = z.infer<typeof publishAnnouncementRequestSchema>;

export const announcementSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  audienceAll: z.boolean(),
  audienceRoles: z.array(z.string()),
  audienceEmails: z.array(z.string()),
  recipientCount: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  createdByName: z.string(),
}).strict();
export type Announcement = z.infer<typeof announcementSchema>;

export const announcementsResponseSchema = z.object({
  data: z.array(announcementSchema),
  request_id: z.string().min(1),
}).strict();

export const publishAnnouncementResponseSchema = z.object({
  data: z.object({ id: z.uuid(), title: z.string(), recipientCount: z.number().int().positive(), correlationId: z.uuid() }).strict(),
  request_id: z.string().min(1),
}).strict();

export const institutionalEmailSchema = z.string().max(254)
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email().refine(
    (value) => /^[^@\s]+@institutojef\.org\.br$/.test(value),
    "Use um email institucional válido",
  ));

export const institutionalOtpRequestSchema = z.object({
  email: institutionalEmailSchema,
}).strict();
export type InstitutionalOtpRequest = z.infer<typeof institutionalOtpRequestSchema>;

export const institutionalOtpVerifySchema = z.object({
  email: institutionalEmailSchema,
  token: z.string().regex(/^\d{6,10}$/),
}).strict();
export type InstitutionalOtpVerify = z.infer<typeof institutionalOtpVerifySchema>;

export const usernameSchema = z.string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z][a-z0-9._]{2,31}$/);

export const accountPasswordSchema = z.string()
  .min(8)
  .max(128)
  .regex(/[a-z]/, "A senha deve conter letra minúscula")
  .regex(/[A-Z]/, "A senha deve conter letra maiúscula")
  .regex(/[0-9]/, "A senha deve conter número");

export const loginIdentifierSchema = z.string().trim().toLowerCase().min(3).max(254)
  .refine((value) => (
    value.includes("@")
      ? /^[^@\s]+@institutojef\.org\.br$/.test(value)
      : /^[a-z][a-z0-9._]{2,31}$/.test(value)
  ), "Use um email institucional ou username válido");

export const credentialLoginRequestSchema = z.object({
  identifier: loginIdentifierSchema,
  password: z.string().min(1).max(128),
}).strict();
export type CredentialLoginRequest = z.infer<typeof credentialLoginRequestSchema>;

export const signupRequestSchema = z.object({ email: institutionalEmailSchema }).strict();
export const signupVerifySchema = institutionalOtpVerifySchema;
export const signupCompleteSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  username: usernameSchema,
  password: accountPasswordSchema,
  avatarPath: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/).nullable().default(null),
}).strict();
export type SignupComplete = z.infer<typeof signupCompleteSchema>;

export const passwordRecoveryRequestSchema = z.object({ identifier: loginIdentifierSchema }).strict();
export const passwordRecoveryVerifySchema = z.object({
  identifier: loginIdentifierSchema,
  token: z.string().regex(/^\d{6,10}$/),
}).strict();
export const passwordRecoveryCompleteSchema = z.object({ password: accountPasswordSchema }).strict();
export const passwordRecoveryUnlockSchema = z.object({ reason: z.string().trim().min(4).max(500) }).strict();
export const signupCodeUnlockSchema = passwordRecoveryUnlockSchema;

export const adminProvisionUserSchema = z.object({
  email: institutionalEmailSchema,
  displayName: z.string().trim().min(2).max(120),
  username: usernameSchema,
  password: accountPasswordSchema,
  roles: z.array(appRoleSchema.exclude(["ADMIN"])).min(1).max(6),
  active: z.boolean().default(true),
}).strict();
export type AdminProvisionUser = z.infer<typeof adminProvisionUserSchema>;

export const userAccessUpdateSchema = z.object({
  roles: z.array(appRoleSchema).max(7),
  active: z.boolean(),
}).strict();
export type UserAccessUpdate = z.infer<typeof userAccessUpdateSchema>;

export const adminUserSchema = z.object({
  id: z.string().uuid(),
  email: institutionalEmailSchema,
  displayName: z.string().nullable(),
  username: z.string().nullable(),
  active: z.boolean(),
  onboardingCompleted: z.boolean(),
  roles: z.array(appRoleSchema),
  // Spec 5.17: requests blocked after too many attempts, which only an administrator unlocks.
  locks: z.object({ passwordRecovery: z.boolean(), signupCode: z.boolean() }).strict().optional(),
}).strict();
export type AdminUser = z.infer<typeof adminUserSchema>;

// ADR 0011 (PR 3): people of the request cohort, filtered and paginated by the server (list_cohort_users).
export const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["ALL", "ACTIVE", "INACTIVE"]).default("ALL"),
  onboarding: z.enum(["ALL", "COMPLETE", "INCOMPLETE"]).default("ALL"),
  roles: z.string().optional()
    .transform((value) => (value ? value.split(",").filter(Boolean) : []))
    .pipe(z.array(appRoleSchema).max(7)),
  roleMatch: z.enum(["ANY", "ALL"]).default("ANY"),
  cohort: z.uuid().optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;

export const adminUserCohortSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  active: z.boolean(),
  roles: z.array(appRoleSchema),
}).strict();

export const adminUsersResponseSchema = z.object({
  data: z.array(adminUserSchema.extend({ cohorts: z.array(adminUserCohortSchema).optional(), adminMaster: z.boolean().optional() })),
  page: z.object({
    total: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }).strict(),
  request_id: z.string().uuid(),
}).strict();

export const permissionSchema = z.enum([
  "portal.access",
  "admin.access",
  "catalog.read",
  "catalog.manage",
  "inventory.read",
  "inventory.manage",
  "inventory.transfer.own",
  "inventory.return.own",
  "inventory.loss.own",
  "inventory.count.own",
  "procurement.manage",
  "sales.create",
  "sales.read.own",
  "sales.read.all",
  "reservations.manage.own",
  "reservations.manage.all",
  "raffles.buy",
  "raffles.sell",
  "raffles.manage",
  "users.manage",
  "finance.manage",
  "closeouts.create",
  "closeouts.manage",
  "communications.manage",
  "community.moderate",
  "audit.read",
  "cohorts.manage",
]);
export type Permission = z.infer<typeof permissionSchema>;

// Closed list: every kind the outbox worker writes must be here, otherwise the whole notification list fails.
export const notificationKindSchema = z.enum([
  "ACCOUNT_UPDATED",
  "RESERVATION_CREATED",
  "RESERVATION_CONVERTED",
  "RESERVATION_EXPIRED",
  "RESERVATION_READY",
  "RESERVATION_COMPLETED",
  "PAYMENT_CONFIRMED",
  "CLOSEOUT_REOPENED",
  "CLOSEOUT_PENDING",
  "RAFFLE_RESERVED",
  "RAFFLE_RESERVATION_EXPIRED",
  "RAFFLE_EXPIRED",
  "RAFFLE_DRAWN",
  "LOSS_PENDING",
  "COUNT_PENDING",
  "RETURN_PENDING",
  "TRANSFER_PENDING",
  "SALE_DIVERGENT",
  "ANNOUNCEMENT",
  "PRODUCT_BACK_IN_STOCK",
  "NEW_PRODUCT",
  "PROMOTION_LIVE",
  "RAFFLE_OPENED",
  "RAFFLE_WINNER_CONTACT",
  "RAFFLE_CANCELLED",
  "RAFFLE_REFUNDS_PENDING",
  "RAFFLE_REFUNDED",
  "EVENT_PUBLISHED",
  "EVENT_CANCELLED",
]);

// Spec 4.7 (NOTIF-004): optional notification categories each user can turn off.
export const notificationCategorySchema = z.enum(["NOVOS_PRODUTOS", "PROMOCOES", "ESTOQUE_DE_VOLTA", "EVENTOS", "RIFAS", "COMUNICADOS"]);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;
export const notificationPreferencesResponseSchema = z.object({
  data: z.array(z.object({ category: notificationCategorySchema, enabled: z.boolean() }).strict()),
  request_id: z.string().min(1),
}).strict();
export const setNotificationPreferenceRequestSchema = z.object({ category: notificationCategorySchema, enabled: z.boolean() }).strict();
export const setStockAlertRequestSchema = z.object({ enabled: z.boolean() }).strict();

export const notificationsQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

export const notificationSchema = z.object({
  id: z.uuid(),
  kind: notificationKindSchema,
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(1000),
  data: z.record(z.string(), z.unknown()),
  readAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

export const notificationsResponseSchema = z.object({
  data: z.array(notificationSchema),
  nextCursor: z.uuid().nullable(),
  request_id: z.string().min(1),
}).strict();

export const notificationReadResponseSchema = z.object({
  data: notificationSchema.pick({ id: true, readAt: true }),
  request_id: z.string().min(1),
}).strict();

export const featureFlagKeySchema = z.enum([
  "reservations",
  "raffles",
  "notifications",
  "card_present",
  "pix_area_manual",
  "cash_payment",
  "online_checkout",
  "picpay_checkout",
  "picpay_tap",
  "payment_link",
  "meal_voucher",
  "community",
  "comments",
  "procurement",
  "events",
]);

export const featureFlagSchema = z.object({
  key: featureFlagKeySchema,
  description: z.string().min(1).max(500),
  enabled: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }),
  updatedBy: z.uuid().nullable(),
}).strict();

export const featureFlagsResponseSchema = z.object({
  data: z.array(featureFlagSchema),
  request_id: z.string().min(1),
}).strict();

export const featureFlagUpdateRequestSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(4).max(500),
}).strict();

export const featureFlagUpdateResponseSchema = z.object({
  data: featureFlagSchema,
  request_id: z.string().min(1),
}).strict();

export const sessionUserSchema = z.object({
  id: z.string().min(1),
  authId: z.uuid(),
  email: z.email(),
  name: z.string().min(1),
  username: usernameSchema,
  avatarPath: z.string().nullable(),
  role: sessionRoleSchema,
  roles: z.array(sessionRoleSchema).min(1),
  active: z.literal(true),
  adminMaster: z.boolean(),
  cohortMode: cohortModeSchema,
  cohort: cohortSummarySchema.nullable(),
  cohorts: z.array(cohortSummarySchema),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
  request_id: z.string().min(1),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function createApiError(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ApiError {
  return apiErrorSchema.parse({ code, message, request_id: requestId, details });
}

export interface ApiClientOptions {
  getAccessToken: () => Promise<string | null>;
  /** The cohort this client operates in (the PDV); the Portal validates it against the session on every request. */
  getCohort?: () => string | null;
  fetchImpl?: typeof fetch;
}

export function createApiClient({ getAccessToken, getCohort, fetchImpl = fetch }: ApiClientOptions) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("Authorization")) {
      const accessToken = await getAccessToken();
      if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    }
    const cohort = getCohort?.();
    if (cohort) headers.set(COHORT_HEADER, cohort);
    return fetchImpl(input, { ...init, headers, credentials: init.credentials ?? "include" });
  };
}
export * from "./profile";
export * from "./suppliers";
export * from "./purchase-orders";
export * from "./purchase-receipts";
export * from "./purchase-payables";
export * from "./inventory-lots";

export * from "./promotion-management";
