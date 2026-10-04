import { createApiError, notificationsQuerySchema, notificationsResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try { await requireSession(); } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 503;
    return NextResponse.json(createApiError(status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", "Acesso não autorizado", requestId), { status });
  }
  const url = new URL(request.url);
  const parsed = notificationsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return NextResponse.json(createApiError("INVALID_QUERY", "Consulta de notificações inválida", requestId, parsed.error.issues), { status: 422 });
  const client = await createAuthenticatedSupabaseClient(request);
  let query = client.from("notifications")
    .select("id, kind, title, body, data, read_at, created_at")
    .order("id", { ascending: false }).limit(parsed.data.limit + 1);
  if (parsed.data.cursor) query = query.lt("id", parsed.data.cursor);
  if (parsed.data.unreadOnly) query = query.is("read_at", null);
  const { data, error } = await query;
  if (error) return NextResponse.json(createApiError("NOTIFICATIONS_UNAVAILABLE", "Notificações temporariamente indisponíveis", requestId), { status: 503 });
  const page = data.slice(0, parsed.data.limit);
  const payload = notificationsResponseSchema.parse({
    data: page.map((item) => ({
      id: item.id, kind: item.kind, title: item.title, body: item.body, data: item.data,
      readAt: item.read_at, createdAt: item.created_at,
    })),
    nextCursor: data.length > parsed.data.limit ? page.at(-1)?.id ?? null : null,
    request_id: requestId,
  });
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}
