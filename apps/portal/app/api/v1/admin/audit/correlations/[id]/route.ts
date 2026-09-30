import { auditCorrelationResponseSchema, createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { toAuditCorrelation } from "@/lib/audit";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

/** AUD-001: every record sharing one correlation — audit, sale, payment, stock, finance and outbox. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return fail("INVALID_AUDIT_FILTER", "Correlação inválida.", 422);
  try {
    await requirePermission("audit.read");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("get_audit_correlation", { p_correlation_id: id.data });
    if (error?.message.includes("AUDIT_READ_REQUIRED")) return fail("FORBIDDEN", "Somente administradores consultam a auditoria.", 403);
    const correlation = error ? null : toAuditCorrelation(data);
    if (!correlation) return fail("AUDIT_UNAVAILABLE", "Auditoria temporariamente indisponível.", 503);
    return NextResponse.json(auditCorrelationResponseSchema.parse({ data: correlation, request_id: requestId }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("AUDIT_UNAVAILABLE", "Auditoria temporariamente indisponível.", 503);
  }
}
