import { auditSearchQuerySchema, auditSearchResponseSchema, createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { toAuditSearch } from "@/lib/audit";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

/** AUD-001 (spec 5.16): searches the audit trail; nothing here edits history. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  const query = auditSearchQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return fail("INVALID_AUDIT_FILTER", "Confira os filtros: período de até um ano e identificadores válidos.", 422);
  const filter = query.data;
  try {
    await requirePermission("audit.read");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("search_audit_logs", {
      p_from: filter.from, p_to: filter.to, p_actor: filter.actor || null, p_action: filter.action || null,
      p_entity_type: filter.entityType || null, p_entity_id: filter.entityId || null, p_correlation_id: filter.correlationId ?? null,
      p_severity: filter.severity ?? null, p_cursor_created_at: filter.cursorCreatedAt ?? null, p_cursor_id: filter.cursorId ?? null, p_limit: 50,
    });
    if (error?.message.includes("INVALID_AUDIT_FILTER")) return fail("INVALID_AUDIT_FILTER", "Confira os filtros: período de até um ano e identificadores válidos.", 422);
    if (error?.message.includes("AUDIT_READ_REQUIRED")) return fail("FORBIDDEN", "Somente administradores consultam a auditoria.", 403);
    const page = error ? null : toAuditSearch(data);
    if (!page) return fail("AUDIT_UNAVAILABLE", "Auditoria temporariamente indisponível.", 503);
    return NextResponse.json(auditSearchResponseSchema.parse({ data: page.rows, nextCursor: page.nextCursor, request_id: requestId }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("AUDIT_UNAVAILABLE", "Auditoria temporariamente indisponível.", 503);
  }
}
