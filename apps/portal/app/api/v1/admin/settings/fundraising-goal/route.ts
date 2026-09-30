import { createApiError, fundraisingGoalRequestSchema, fundraisingGoalResponseSchema, idempotencyKeySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { toFundraisingGoal } from "@/lib/fundraising-goal";

function responder(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  return {
    requestId, headers,
    fail: (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers }),
  };
}

/** ADMIN-002: the goal with every amount, for finance. */
export async function GET(request: Request) {
  const { requestId, headers, fail } = responder(request);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("get_fundraising_goal_admin");
    if (error) return fail("FUNDRAISING_GOAL_UNAVAILABLE", "Meta temporariamente indisponível.", 503);
    return NextResponse.json(fundraisingGoalResponseSchema.parse({ data: toFundraisingGoal(data), request_id: requestId }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("FUNDRAISING_GOAL_UNAVAILABLE", "Meta temporariamente indisponível.", 503);
  }
}

/** ADMIN-002 (spec 5.17): sets the target, the dates and what the class sees; audited with before and after. */
export async function PUT(request: Request) {
  const { requestId, headers, fail } = responder(request);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = fundraisingGoalRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return fail("INVALID_FUNDRAISING_GOAL", "Confira o valor da meta e as datas.", 422);
  try {
    await requirePermission("finance.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("configure_fundraising_goal", {
      p_target_cents: parsed.data.targetCents, p_counting_from: parsed.data.countingFrom, p_target_date: parsed.data.targetDate,
      p_public_visible: parsed.data.publicVisible, p_show_amounts: parsed.data.showAmounts,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.message.includes("INVALID_FUNDRAISING_GOAL")) return fail("INVALID_FUNDRAISING_GOAL", "Confira o valor da meta e as datas.", 422);
      if (error.message.includes("IDEMPOTENCY_CONFLICT")) return fail("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo.", 409);
      if (error.message.includes("FORBIDDEN") || error.message.includes("FINANCE_MANAGE_REQUIRED")) return fail("FORBIDDEN", "Operação não autorizada.", 403);
      return fail("FUNDRAISING_GOAL_UNAVAILABLE", "Meta temporariamente indisponível.", 503);
    }
    return NextResponse.json(fundraisingGoalResponseSchema.parse({ data: toFundraisingGoal(data), request_id: requestId }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("FUNDRAISING_GOAL_UNAVAILABLE", "Meta temporariamente indisponível.", 503);
  }
}
