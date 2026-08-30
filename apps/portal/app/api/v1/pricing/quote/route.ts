import {
  createApiError,
  pricingQuoteRequestSchema,
  pricingQuoteResponseSchema,
} from "@germinatura/contracts";
import {
  DomainError,
  moneyFromCents,
  priceCartWithQuantityPromotions,
} from "@germinatura/domain";
import { createRequestId } from "@germinatura/observability";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const databaseRowSchema = z.object({
  quoted_at: z.string(),
  product_id: z.uuid(),
  product_name: z.string().min(1),
  amount_cents: z.number().int().nonnegative().refine(Number.isSafeInteger),
  promotion_id: z.uuid().nullable(),
  priority: z.number().int().nullable(),
  rule_type: z.literal("QUANTIDADE_PRECO").nullable(),
  group_quantity: z.number().int().nullable(),
  group_price_cents: z.number().int().nonnegative().refine(Number.isSafeInteger).nullable(),
  max_groups_per_line: z.number().int().nullable(),
});

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

  const { data, error } = await supabase.rpc("get_pricing_quote_inputs", {
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
    const quote = priceCartWithQuantityPromotions(
      parsed.data.items.map((item) => {
        const product = products.get(item.productId)!;
        return { productId: item.productId, quantity: item.quantity, unitPriceCents: moneyFromCents(product.amount_cents) };
      }),
      rows.data.flatMap((row) => row.promotion_id && row.rule_type && row.priority !== null
        && row.group_quantity !== null && row.group_price_cents !== null
        ? [{
            promotionId: row.promotion_id,
            type: row.rule_type,
            productId: row.product_id,
            priority: row.priority,
            groupQuantity: row.group_quantity,
            groupPriceCents: moneyFromCents(row.group_price_cents),
            maxGroupsPerLine: row.max_groups_per_line,
          }]
        : []),
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
