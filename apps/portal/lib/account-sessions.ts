import { createApiError } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

export const databaseSessionsSchema = z.array(z.object({
  id: z.uuid(), created_at: z.string(), last_active_at: z.string(), user_agent: z.string().nullable(), current: z.boolean(),
}));

export function sessionError(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}

/** Maps the end_my_sessions errors shared by "end one" and "end the others". */
export function endSessionsError(message: string, requestId: string) {
  if (message.includes("CURRENT_SESSION_USE_LOGOUT")) return sessionError("CURRENT_SESSION", "Para encerrar esta sessão, use Sair.", requestId, 409);
  if (message.includes("SESSION_NOT_FOUND")) return sessionError("SESSION_NOT_FOUND", "Sessão não encontrada ou já encerrada.", requestId, 404);
  return sessionError("SESSIONS_UNAVAILABLE", "Sessões temporariamente indisponíveis.", requestId, 503);
}
