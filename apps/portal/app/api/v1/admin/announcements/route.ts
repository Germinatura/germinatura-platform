import {
  announcementsResponseSchema, createApiError, idempotencyKeySchema, publishAnnouncementRequestSchema, publishAnnouncementResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const headers = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (code: string, message: string, requestId: string, status: number, details?: unknown) =>
  NextResponse.json(createApiError(code, message, requestId, details), { status, headers: headers(requestId) });
const databaseRowsSchema = z.array(z.object({
  id: z.uuid(), title: z.string(), body: z.string(), audience_all: z.boolean(), audience_roles: z.array(z.string()),
  audience_emails: z.array(z.string()), recipient_count: z.number().int(), created_at: z.string(), created_by_name: z.string(),
}));
const databaseResultSchema = z.object({ id: z.uuid(), title: z.string(), recipient_count: z.number().int(), correlation_id: z.uuid() });

/** NOTIF-003: announcements already published, newest first. */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("communications.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("list_announcements", { p_limit: 50 });
    const rows = databaseRowsSchema.safeParse(data);
    if (error || !rows.success) return fail("ANNOUNCEMENTS_UNAVAILABLE", "Avisos temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(announcementsResponseSchema.parse({
      data: rows.data.map((row) => ({
        id: row.id, title: row.title, body: row.body, audienceAll: row.audience_all, audienceRoles: row.audience_roles,
        audienceEmails: row.audience_emails, recipientCount: row.recipient_count, createdAt: row.created_at, createdByName: row.created_by_name,
      })),
      request_id: requestId,
    }), { headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("ANNOUNCEMENTS_UNAVAILABLE", "Avisos temporariamente indisponíveis.", requestId, 503);
  }
}

/** NOTIF-003: publishes an announcement now to everyone, to roles or to listed e-mails. */
export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  const parsed = publishAnnouncementRequestSchema.safeParse(await request.json().catch(() => null));
  if (!key.success || !parsed.success) return fail("INVALID_ANNOUNCEMENT", "Confira o título, o texto e o público.", requestId, 422);
  try {
    await requirePermission("communications.manage");
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("publish_announcement", {
      p_title: parsed.data.title, p_body: parsed.data.body, p_all: parsed.data.all, p_roles: parsed.data.roles,
      p_emails: parsed.data.emails, p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.message.includes("ANNOUNCEMENT_UNKNOWN_RECIPIENTS")) {
        return fail("ANNOUNCEMENT_UNKNOWN_RECIPIENTS", `E-mails sem cadastro ativo: ${error.details ?? ""}`.trim(), requestId, 422);
      }
      if (error.message.includes("ANNOUNCEMENT_EMPTY_AUDIENCE")) return fail("ANNOUNCEMENT_EMPTY_AUDIENCE", "Ninguém com cadastro ativo neste público.", requestId, 422);
      if (error.message.includes("IDEMPOTENCY_CONFLICT")) return fail("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo.", requestId, 409);
      if (error.message.includes("COMMUNICATIONS_MANAGE_REQUIRED")) return fail("FORBIDDEN", "Operação não autorizada.", requestId, 403);
      if (error.message.includes("INVALID_")) return fail("INVALID_ANNOUNCEMENT", "Confira o título, o texto e o público.", requestId, 422);
      return fail("ANNOUNCEMENTS_UNAVAILABLE", "Avisos temporariamente indisponíveis.", requestId, 503);
    }
    const result = databaseResultSchema.safeParse(data);
    if (!result.success) return fail("ANNOUNCEMENTS_UNAVAILABLE", "Avisos temporariamente indisponíveis.", requestId, 503);
    return NextResponse.json(publishAnnouncementResponseSchema.parse({
      data: { id: result.data.id, title: result.data.title, recipientCount: result.data.recipient_count, correlationId: result.data.correlation_id },
      request_id: requestId,
    }), { status: 201, headers: headers(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, requestId, error.status);
    return fail("ANNOUNCEMENTS_UNAVAILABLE", "Avisos temporariamente indisponíveis.", requestId, 503);
  }
}
