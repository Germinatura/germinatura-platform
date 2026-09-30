import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const boardSchema = z.array(z.tuple([z.number().int().positive(), z.enum(["AVAILABLE", "TAKEN", "MINE"])]));

/** Spec 4.4 / 15.5: the number board — available, taken or mine — without who holds the other numbers. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const fail = (code: string, message: string, status: number) => NextResponse.json(createApiError(code, message, requestId), { status, headers });
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return fail("RAFFLE_NOT_FOUND", "Rifa não encontrada", 404);
  try {
    await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("get_raffle_number_board", { p_campaign_id: id.data });
    if (error?.message.includes("RAFFLE_CAMPAIGN_NOT_FOUND")) return fail("RAFFLE_NOT_FOUND", "Rifa não encontrada", 404);
    if (error?.message.includes("FORBIDDEN")) return fail("FORBIDDEN", "Acesso não autorizado", 403);
    const board = boardSchema.safeParse(data);
    if (error || !board.success) return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", 503);
    return NextResponse.json({ data: board.data.map(([number, state]) => ({ number, state })), request_id: requestId }, { headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail("RAFFLE_UNAVAILABLE", "Rifa temporariamente indisponível", 503);
  }
}
