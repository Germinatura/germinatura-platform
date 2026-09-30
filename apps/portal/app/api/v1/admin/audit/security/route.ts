import { createApiError, securityEventsQuerySchema, securityEventsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { toSecurityEvents } from "@/lib/audit";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

/** AUD-001: logins, failed logins and authorization denials, for administrators. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  const query = securityEventsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return fail("INVALID_AUDIT_FILTER", "Confira os filtros: período de até um ano.", 422);
  try {
    await requirePermission("audit.read");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("search_security_events", {
      p_from: query.data.from, p_to: query.data.to, p_kind: query.data.kind ?? null, p_actor: query.data.actor || null,
      p_cursor_created_at: query.data.cursorCreatedAt ?? null, p_cursor_id: query.data.cursorId ?? null, p_limit: 50,
    });
    if (error?.message.includes("INVALID_AUDIT_FILTER")) return fail("INVALID_AUDIT_FILTER", "Confira os filtros: período de até um ano.", 422);
    if (error?.message.includes("AUDIT_READ_REQUIRED")) return fail("FORBIDDEN", "Somente administradores consultam a auditoria.", 403);
    const page = error ? null : toSecurityEvents(data);
    if (!page) return fail("AUDIT_UNAVAILABLE", "Auditoria temporariamente indisponível.", 503);
    return NextResponse.json(securityEventsResponseSchema.parse({ data: page.rows, nextCursor: page.nextCursor, request_id: requestId }), { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("AUDIT_UNAVAILABLE", "Auditoria temporariamente indisponível.", 503);
  }
}
