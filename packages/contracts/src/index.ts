import { moneyFromCents } from "@germinatura/domain";
import { z } from "zod";

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
});
export type PublicCatalogProduct = z.infer<typeof publicCatalogProductSchema>;

export const publicCatalogProductsResponseSchema = z.object({
  data: z.array(publicCatalogProductSchema),
  nextCursor: z.uuid().nullable(),
  request_id: z.string().min(1),
});
export type PublicCatalogProductsResponse = z.infer<typeof publicCatalogProductsResponseSchema>;

export const pricingChannelSchema = z.enum(["PORTAL", "PDV"]);
export const pricingQuoteRequestSchema = z.object({
  channel: pricingChannelSchema,
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
export const pricingQuoteResponseSchema = z.object({
  data: z.object({
    channel: pricingChannelSchema,
    quotedAt: z.iso.datetime({ offset: true }),
    currency: z.literal("BRL"),
    rounding: z.literal("NONE"),
    lines: z.array(z.object({
      productId: z.uuid(),
      name: z.string().min(1),
      unitPriceCents: moneyCentsSchema,
      quantity: z.number().int().positive(),
      originalSubtotalCents: moneyCentsSchema,
      discountCents: moneyCentsSchema,
      totalCents: moneyCentsSchema,
      appliedPromotion: appliedQuantityPromotionSchema.nullable(),
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

export const salesCancelResponseSchema = z.object({
  data: z.object({
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
  }).strict(),
  request_id: z.string().min(1),
}).strict();
export type SalesCancelResponse = z.infer<typeof salesCancelResponseSchema>;

export const manualPaymentConfirmationRequestSchema = z.object({
  integrationChannel: z.enum(["MAQUININHA", "PIX_AREA"]),
  proofReference: z.string().min(4).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$/)
    .refine((value) => !/[0-9]{12,}/.test(value), "A referência não pode conter dados de cartão"),
}).strict();
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
    }).strict(),
    stock: z.object({
      reservationId: z.uuid(),
      status: z.literal("CONSUMED"),
      saleMovementId: z.uuid(),
    }).strict(),
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
  token: z.string().regex(/^\d{6}$/),
}).strict();
export type InstitutionalOtpVerify = z.infer<typeof institutionalOtpVerifySchema>;

export const userAccessUpdateSchema = z.object({
  roles: z.array(appRoleSchema).max(7),
  active: z.boolean(),
}).strict();
export type UserAccessUpdate = z.infer<typeof userAccessUpdateSchema>;

export const permissionSchema = z.enum([
  "portal.access",
  "admin.access",
  "catalog.read",
  "catalog.manage",
  "inventory.read",
  "inventory.manage",
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
  "communications.manage",
  "community.moderate",
]);
export type Permission = z.infer<typeof permissionSchema>;

export const sessionUserSchema = z.object({
  id: z.string().min(1),
  authId: z.uuid(),
  email: z.email(),
  name: z.string().min(1),
  role: appRoleSchema,
  roles: z.array(appRoleSchema).min(1),
  active: z.literal(true),
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
  fetchImpl?: typeof fetch;
}

export function createApiClient({ getAccessToken, fetchImpl = fetch }: ApiClientOptions) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("Authorization")) {
      const accessToken = await getAccessToken();
      if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    }
    return fetchImpl(input, { ...init, headers, credentials: init.credentials ?? "include" });
  };
}
