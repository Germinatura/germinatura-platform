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
