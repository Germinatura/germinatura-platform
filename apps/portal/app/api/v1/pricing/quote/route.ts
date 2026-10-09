import {
  createApiError,
  managedPromotionRuleSchema,
  pricingQuoteRequestSchema,
  pricingQuoteResponseSchema,
} from "@germinatura/contracts";
import {
  DomainError,
  moneyFromCents,
  priceCartWithPromotions,
  type CartPromotionRule,
} from "@germinatura/domain";
import { createRequestId } from "@germinatura/observability";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, getSession, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { resolvePublicCohort } from "@/lib/public-cohort";
import { createPublicSupabaseClient } from "@/lib/supabase/public";

// get_pricing_inputs returns the canonical rule document; the shared contract validates it.
const databaseRowSchema = z.object({
  quoted_at: z.string(),
  product_id: z.uuid(),
  product_name: z.string().min(1),
  amount_cents: z.number().int().nonnegative().refine(Number.isSafeInteger),
  promotion_id: z.uuid().nullable(),
  priority: z.number().int().nullable(),
  cumulative: z.boolean().nullable(),
  rule: managedPromotionRuleSchema.nullable(),
});

type DatabaseRow = z.infer<typeof databaseRowSchema>;

function promotionRules(rows: readonly DatabaseRow[]): CartPromotionRule[] {
  // A coupon arrives once per eligible product; the domain needs its whole product scope.
  const couponProducts = new Map<string, string[]>();
  for (const row of rows) {
    if (row.promotion_id && row.rule?.type === "CUPOM") {
      couponProducts.set(row.promotion_id, [...(couponProducts.get(row.promotion_id) ?? []), row.product_id]);
    }
  }
  return rows.flatMap((row) => promotionRule(row, couponProducts));
}

function promotionRule(row: DatabaseRow, couponProducts: ReadonlyMap<string, string[]>): CartPromotionRule[] {
  if (row.promotion_id === null && row.rule === null) return [];
  // Fail closed: checkout would still price this candidate, so the quote must not silently skip it.
  if (row.promotion_id === null || row.rule === null || row.priority === null) {
    throw new DomainError("PRICING_INVALID_RULE", "Promotion candidate is incomplete");
  }
  const common = { promotionId: row.promotion_id, productId: row.product_id, priority: row.priority };
  const rule = row.rule;
  switch (rule.type) {
    case "QUANTIDADE_PRECO":
      return [{ ...common, ...rule, groupPriceCents: moneyFromCents(rule.groupPriceCents) }];
    case "VALOR_FIXO_UNITARIO":
      return [{ ...common, ...rule, fixedUnitPriceCents: moneyFromCents(rule.fixedUnitPriceCents) }];
    case "COMBO_MIX":
      // One row per component product; the domain keeps a single combo per promotion ID.
      return [{ promotionId: common.promotionId, priority: common.priority, ...rule, comboPriceCents: moneyFromCents(rule.comboPriceCents) }];
    case "CUPOM":
      return [{ promotionId: common.promotionId, priority: common.priority, type: rule.type, code: rule.code,
        productIds: couponProducts.get(common.promotionId) ?? [row.product_id], cumulative: row.cumulative === true,
        discount: rule.discount.kind === "PERCENTUAL" ? rule.discount
          : { kind: "VALOR_FIXO", amountCents: moneyFromCents(rule.discount.amountCents) } }];
    default:
      return [{ ...common, ...rule }];
  }
}

function errorResponse(code: string, message: string, requestId: string, status: number, details?: unknown) {
  return NextResponse.json(createApiError(code, message, requestId, details), {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_BODY", "Corpo JSON inválido", requestId, 422);
  }
  const parsed = pricingQuoteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_QUOTE", "Solicitação de cotação inválida", requestId, 422, parsed.error.issues);
  }

  let supabase: SupabaseClient;
  try {
    if (parsed.data.channel === "PDV") {
      await requirePermission("sales.create");
      supabase = await createAuthenticatedSupabaseClient(request);
    } else {
      // ADR 0011: a signed-in person is quoted in the cohort in context (validated by the proxy), as the reservation
      // will be; a visitor in the public default cohort, or in the ACTIVE cohort named by its public slug (?turma=).
      const slug = new URL(request.url).searchParams.get("turma");
      if (await getSession()) {
        supabase = await createAuthenticatedSupabaseClient(request);
      } else if (slug !== null) {
        const cohort = await resolvePublicCohort(slug);
        if (!cohort) return errorResponse("COHORT_NOT_FOUND", "Turma não encontrada ou indisponível.", requestId, 404);
        supabase = createPublicSupabaseClient(cohort.id);
      } else {
        supabase = createPublicSupabaseClient();
      }
    }
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return errorResponse("PRICING_UNAVAILABLE", "Cotação temporariamente indisponível", requestId, 503);
  }

  const { data, error } = await supabase.rpc("get_pricing_inputs", {
    p_channel: parsed.data.channel,
    p_product_ids: parsed.data.items.map((item) => item.productId),
    p_coupon_code: parsed.data.couponCode ?? null,
  });
  if (error) return errorResponse("PRICING_UNAVAILABLE", "Cotação temporariamente indisponível", requestId, 503);
  const rows = z.array(databaseRowSchema).safeParse(data);
  if (!rows.success) return errorResponse("PRICING_INVALID_DATA", "Cotação temporariamente indisponível", requestId, 503);

  const products = new Map(rows.data.map((row) => [row.product_id, row]));
  if (products.size !== parsed.data.items.length) {
    return errorResponse("PRODUCT_UNAVAILABLE", "Um ou mais produtos não estão disponíveis", requestId, 422);
  }

  try {
    const quote = priceCartWithPromotions(
      parsed.data.items.map((item) => {
        const product = products.get(item.productId)!;
        return { productId: item.productId, quantity: item.quantity, unitPriceCents: moneyFromCents(product.amount_cents) };
      }),
      promotionRules(rows.data),
    );
    const response = pricingQuoteResponseSchema.parse({
      data: {
        channel: parsed.data.channel,
        quotedAt: rows.data[0].quoted_at,
        currency: "BRL",
        rounding: quote.rounding,
        coupon: parsed.data.couponCode ? { code: parsed.data.couponCode, applied: quote.lines.some((line) =>
          line.appliedCoupon || line.appliedPromotion?.type === "CUPOM") } : null,
        lines: quote.lines.map((line) => ({
          productId: line.productId,
          name: products.get(line.productId)!.product_name,
          unitPriceCents: line.unitPriceCents,
          quantity: line.quantity,
          originalSubtotalCents: line.originalSubtotalCents,
          discountCents: line.discountCents,
          totalCents: line.effectiveSubtotalCents,
          appliedPromotion: line.appliedPromotion,
          appliedCoupon: line.appliedCoupon ?? null,
        })),
        originalTotalCents: quote.originalTotalCents,
        discountTotalCents: quote.discountTotalCents,
        totalCents: quote.totalCents,
      },
      request_id: requestId,
    });
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    const code = error instanceof DomainError ? error.code : "PRICING_FAILED";
    return errorResponse(code, "Cotação temporariamente indisponível", requestId, 503);
  }
}
