import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  catalogProductFlagsSchema,
  catalogSlugSchema,
  createApiClient,
  idempotencyKeySchema,
  idempotencyStatusSchema,
  institutionalEmailSchema,
  institutionalOtpVerifySchema,
  manualPaymentConfirmationRequestSchema,
  manualPaymentConfirmationResponseSchema,
  moneyCentsSchema,
  productSkuSchema,
  pricingQuoteRequestSchema,
  pricingQuoteResponseSchema,
  publicCatalogProductsQuerySchema,
  publicCatalogProductsResponseSchema,
  saleSchema,
  saleStatusSchema,
  salesCancelResponseSchema,
  salesCheckoutRequestSchema,
  salesCheckoutResponseSchema,
  sessionUserSchema,
  stockMovementTypeSchema,
  stockReservationItemSchema,
  stockReservationStatusSchema,
  userAccessUpdateSchema,
} from "./index";

describe("shared contracts", () => {
  it("rejects an invalid session identity", () => {
    expect(() => sessionUserSchema.parse({ id: "1" })).toThrow();
  });

  it("accepts only the canonical institutional email domain", () => {
    expect(institutionalEmailSchema.parse(" Pessoa@InstitutoJef.org.br ")).toBe("pessoa@institutojef.org.br");
    for (const email of [
      "pessoa@example.org",
      "pessoa@sub.institutojef.org.br",
      "pessoa@institutojef.org.br.example.org",
      "pessoa@institutojeforgbr",
    ]) {
      expect(institutionalEmailSchema.safeParse(email).success).toBe(false);
    }
    expect(institutionalOtpVerifySchema.safeParse({
      email: "pessoa@institutojef.org.br",
      token: "123456",
    }).success).toBe(true);
    expect(institutionalOtpVerifySchema.safeParse({
      email: "pessoa@institutojef.org.br",
      token: "1234567",
    }).success).toBe(false);
  });

  it("validates cumulative user access updates", () => {
    expect(userAccessUpdateSchema.parse({ roles: ["VENDEDOR", "CONSUMIDOR"], active: true }))
      .toEqual({ roles: ["VENDEDOR", "CONSUMIDOR"], active: true });
    expect(userAccessUpdateSchema.safeParse({ roles: ["SUPERADMIN"], active: true }).success).toBe(false);
  });

  it("accepts the standard API error envelope", () => {
    expect(
      apiErrorSchema.parse({ code: "FORBIDDEN", message: "Acesso negado", request_id: "req-1" }),
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  it("validates money as safe non-negative integer cents", () => {
    expect(moneyCentsSchema.parse(1290)).toBe(1290);

    for (const invalid of [-1, 12.9, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(moneyCentsSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates portable idempotency keys and persisted statuses", () => {
    expect(idempotencyKeySchema.parse("checkout:550e8400-e29b-41d4-a716-446655440000")).toContain("checkout:");
    expect(idempotencyStatusSchema.parse("SUCCEEDED")).toBe("SUCCEEDED");

    for (const invalid of ["", "contains whitespace", "a".repeat(129)]) {
      expect(idempotencyKeySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates canonical catalog identifiers", () => {
    expect(catalogSlugSchema.parse("camiseta-turma-2026")).toBe("camiseta-turma-2026");
    expect(productSkuSchema.parse("CAMISETA-2026_P")).toBe("CAMISETA-2026_P");

    for (const invalid of [" Camiseta", "camiseta_azul", "camiseta--azul", "Camiseta"]) {
      expect(catalogSlugSchema.safeParse(invalid).success).toBe(false);
    }
    for (const invalid of ["sku minusculo", "SKU COM ESPACO", "-SKU", "SKU-"]) {
      expect(productSkuSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires every catalog behavior flag", () => {
    expect(catalogProductFlagsSchema.parse({
      active: true,
      published: false,
      sellablePdv: true,
      reservable: true,
      tracksLots: false,
    })).toMatchObject({ active: true, published: false, sellablePdv: true });
  });

  it("bounds public catalog pagination and validates its response", () => {
    expect(publicCatalogProductsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(publicCatalogProductsQuerySchema.parse({ limit: "50" })).toEqual({ limit: 50 });
    expect(publicCatalogProductsQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(publicCatalogProductsQuerySchema.safeParse({ cursor: "not-a-uuid" }).success).toBe(false);

    expect(publicCatalogProductsResponseSchema.parse({
      data: [{
        id: "33f00000-0000-4000-8000-000000000001",
        sku: "PUBLIC-ITEM",
        slug: "public-item",
        name: "Item publico",
        description: null,
        category: {
          id: "23f00000-0000-4000-8000-000000000001",
          slug: "publica",
          name: "Publica",
        },
        price: { amountCents: 2590, currency: "BRL" },
        sellablePdv: true,
        reservable: true,
      }],
      nextCursor: null,
      request_id: "req-catalog",
    })).toMatchObject({ data: [{ price: { amountCents: 2590 } }] });
  });

  it("shares the closed inventory movement vocabulary", () => {
    expect(stockMovementTypeSchema.parse("TRANSFERENCIA")).toBe("TRANSFERENCIA");
    expect(stockMovementTypeSchema.parse("AJUSTE_NEGATIVO")).toBe("AJUSTE_NEGATIVO");
    expect(stockMovementTypeSchema.safeParse("ALTERACAO_DIRETA").success).toBe(false);
  });

  it("validates reservation status and safe quantities", () => {
    expect(stockReservationStatusSchema.parse("ACTIVE")).toBe("ACTIVE");
    expect(stockReservationItemSchema.parse({
      productId: "33000000-0000-4000-8000-000000000001",
      quantity: 1,
    })).toMatchObject({ quantity: 1 });
    expect(stockReservationItemSchema.safeParse({
      productId: "33000000-0000-4000-8000-000000000001",
      quantity: 0,
    }).success).toBe(false);
  });

  it("sends a Supabase bearer token through the shared API client", async () => {
    let receivedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      receivedInit = init;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const apiFetch = createApiClient({
      getAccessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    });

    await apiFetch("https://portal.test/api/v1/auth/session");

    expect(new Headers(receivedInit?.headers).get("Authorization")).toBe("Bearer access-token");
    expect(receivedInit?.credentials).toBe("include");
  });

  it("accepts only canonical pricing inputs and rejects financial tampering", () => {
    const productId = "33000000-0000-4000-8000-000000000001";
    expect(pricingQuoteRequestSchema.parse({ channel: "PORTAL", items: [{ productId, quantity: 3 }] }))
      .toMatchObject({ channel: "PORTAL" });
    expect(pricingQuoteRequestSchema.safeParse({ channel: "PORTAL", items: [{ productId, quantity: 3 }], totalCents: 1 }).success)
      .toBe(false);
    expect(pricingQuoteRequestSchema.safeParse({ channel: "RESERVA", items: [{ productId, quantity: 3 }] }).success)
      .toBe(false);
    expect(pricingQuoteRequestSchema.safeParse({ channel: "PORTAL", items: [{ productId, quantity: 1 }, { productId, quantity: 2 }] }).success)
      .toBe(false);
  });

  it("validates an explained authoritative pricing response", () => {
    expect(pricingQuoteResponseSchema.parse({
      data: {
        channel: "PORTAL",
        quotedAt: "2026-08-29T17:00:00.000Z",
        currency: "BRL",
        rounding: "NONE",
        lines: [{
          productId: "33000000-0000-4000-8000-000000000001",
          name: "Produto",
          unitPriceCents: 1500,
          quantity: 3,
          originalSubtotalCents: 4500,
          discountCents: 2000,
          totalCents: 2500,
          appliedPromotion: {
            promotionId: "44000000-0000-4000-8000-000000000001",
            type: "QUANTIDADE_PRECO",
            groupQuantity: 2,
            groupPriceCents: 1000,
            groups: 1,
            promotedQuantity: 2,
            remainderQuantity: 1,
            savingsCents: 2000,
          },
        }],
        originalTotalCents: 4500,
        discountTotalCents: 2000,
        totalCents: 2500,
      },
      request_id: "req-pricing",
    }).data.totalCents).toBe(2500);
  });

  it("validates immutable sale snapshots and the closed status vocabulary", () => {
    expect(saleStatusSchema.parse("AWAITING_PAYMENT")).toBe("AWAITING_PAYMENT");
    expect(saleStatusSchema.safeParse("PAID").success).toBe(false);

    const sale = saleSchema.parse({
      id: "71000000-0000-4000-8000-000000000001",
      channel: "PDV",
      locationId: "50000000-0000-4000-8000-000000000002",
      createdBy: "10000000-0000-4000-8000-000000000002",
      customerId: null,
      status: "DRAFT",
      currency: "BRL",
      originalTotalCents: 3000,
      discountTotalCents: 500,
      totalCents: 2500,
      quotedAt: "2026-08-30T14:00:00.000Z",
      correlationId: "72000000-0000-4000-8000-000000000001",
      items: [{
        id: "73000000-0000-4000-8000-000000000001",
        productId: "33000000-0000-4000-8000-000000000001",
        productSku: "CONCURRENCY-ITEM",
        productName: "Item",
        quantity: 2,
        unitPriceCents: 1500,
        originalSubtotalCents: 3000,
        discountCents: 500,
        totalCents: 2500,
        promotionId: null,
        promotionSnapshot: null,
      }],
    });
    expect(sale.totalCents).toBe(2500);
    expect(saleSchema.safeParse({ ...sale, totalCents: 1, authoritativeTotal: 2500 }).success).toBe(false);
  });

  it("accepts only non-authoritative checkout inputs and explained results", () => {
    const productId = "33000000-0000-4000-8000-000000000001";
    const locationId = "50000000-0000-4000-8000-000000000002";
    expect(salesCheckoutRequestSchema.parse({
      channel: "PDV",
      locationId,
      items: [{ productId, quantity: 2 }],
    })).toMatchObject({ channel: "PDV", locationId });
    expect(salesCheckoutRequestSchema.safeParse({
      channel: "PDV",
      locationId,
      items: [{ productId, quantity: 2 }],
      totalCents: 1,
    }).success).toBe(false);

    expect(salesCheckoutResponseSchema.parse({
      data: {
        saleId: "71000000-0000-4000-8000-000000000001",
        status: "AWAITING_PAYMENT",
        channel: "PDV",
        locationId,
        quote: {
          channel: "PDV",
          quotedAt: "2026-08-30T18:00:00.000Z",
          currency: "BRL",
          rounding: "NONE",
          lines: [{
            productId,
            name: "Item",
            unitPriceCents: 1500,
            quantity: 2,
            originalSubtotalCents: 3000,
            discountCents: 0,
            totalCents: 3000,
            appliedPromotion: null,
          }],
          originalTotalCents: 3000,
          discountTotalCents: 0,
          totalCents: 3000,
        },
        reservation: {
          reservationId: "74000000-0000-4000-8000-000000000001",
          status: "ACTIVE",
          expiresAt: "2026-08-30T18:10:00.000Z",
          reservationMovementId: "75000000-0000-4000-8000-000000000001",
        },
        paymentAttempt: {
          attemptId: "76000000-0000-4000-8000-000000000001",
          status: "CREATED",
          amountCents: 3000,
          integrationChannel: null,
          confirmationSource: null,
        },
        correlationId: "72000000-0000-4000-8000-000000000001",
      },
      request_id: "request-checkout",
    }).data.paymentAttempt.status).toBe("CREATED");

    expect(salesCancelResponseSchema.parse({
      data: {
        saleId: "71000000-0000-4000-8000-000000000001",
        status: "CANCELLED",
        reservation: {
          reservationId: "74000000-0000-4000-8000-000000000001",
          status: "RELEASED",
          releaseMovementId: "75000000-0000-4000-8000-000000000002",
        },
        paymentAttempt: {
          attemptId: "76000000-0000-4000-8000-000000000001",
          status: "CANCELLED",
        },
        correlationId: "72000000-0000-4000-8000-000000000002",
      },
      request_id: "request-cancel",
    }).data.status).toBe("CANCELLED");
  });

  it("accepts only controlled manual PicPay confirmation data", () => {
    expect(manualPaymentConfirmationRequestSchema.parse({
      integrationChannel: "MAQUININHA",
      proofReference: "NSU-TEST-0001",
    }).integrationChannel).toBe("MAQUININHA");
    expect(manualPaymentConfirmationRequestSchema.safeParse({
      integrationChannel: "TAP",
      proofReference: "NSU-TEST-0002",
    }).success).toBe(false);
    expect(manualPaymentConfirmationRequestSchema.safeParse({
      integrationChannel: "PIX_AREA",
      proofReference: "4111111111111111",
    }).success).toBe(false);

    expect(manualPaymentConfirmationResponseSchema.parse({
      data: {
        saleId: "71000000-0000-4000-8000-000000000001",
        saleStatus: "CONFIRMED",
        paymentAttempt: {
          attemptId: "76000000-0000-4000-8000-000000000001",
          status: "APPROVED",
          amountCents: 3000,
          integrationChannel: "PIX_AREA",
          confirmationSource: "MANUAL",
          confirmedAt: "2026-08-30T19:00:00.000Z",
          proofReference: "PIX-TEST-0001",
        },
        stock: {
          reservationId: "74000000-0000-4000-8000-000000000001",
          status: "CONSUMED",
          saleMovementId: "75000000-0000-4000-8000-000000000001",
        },
        financialLedgerEntryId: "77000000-0000-4000-8000-000000000001",
        correlationId: "72000000-0000-4000-8000-000000000001",
      },
      request_id: "request-manual-confirmation",
    }).data.paymentAttempt.confirmationSource).toBe("MANUAL");
  });
});
