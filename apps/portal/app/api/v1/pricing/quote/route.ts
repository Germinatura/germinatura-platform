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
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// get_pricing_quote_inputs_v4 returns the canonical rule document; the shared contract validates it.
const databaseRowSchema = z.object({
  quoted_at: z.string(),
  product_id: z.uuid(),
  product_name: z.string().min(1),
  amount_cents: z.number().int().nonnegative().refine(Number.isSafeInteger),
  promotion_id: z.uuid().nullable(),
  priority: z.number().int().nullable(),
  rule: managedPromotionRuleSchema.nullable(),
});

type DatabaseRow = z.infer<typeof databaseRowSchema>;

function promotionRule(row: DatabaseRow): CartPromotionRule[] {
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

async function authenticatedClient(request: Request): Promise<SupabaseClient> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return createSupabaseServerClient();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase public environment is not configured");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { Authorization: authorization } },
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
      supabase = await authenticatedClient(request);
    } else {
      // Public pricing deliberately ignores any privileged browser session.
      supabase = createPublicSupabaseClient();
    }
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorResponse(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    }
    return errorResponse("PRICING_UNAVAILABLE", "Cotação temporariamente indisponível", requestId, 503);
  }

  const { data, error } = await supabase.rpc("get_pricing_quote_inputs_v4", {
    p_channel: parsed.data.channel,
    p_product_ids: parsed.data.items.map((item) => item.productId),
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
      rows.data.flatMap(promotionRule),
    );
    const response = pricingQuoteResponseSchema.parse({
      data: {
        channel: parsed.data.channel,
        quotedAt: rows.data[0].quoted_at,
        currency: "BRL",
        rounding: quote.rounding,
        lines: quote.lines.map((line) => ({
          productId: line.productId,
          name: products.get(line.productId)!.product_name,
          unitPriceCents: line.unitPriceCents,
          quantity: line.quantity,
          originalSubtotalCents: line.originalSubtotalCents,
          discountCents: line.discountCents,
          totalCents: line.effectiveSubtotalCents,
          appliedPromotion: line.appliedPromotion,
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
