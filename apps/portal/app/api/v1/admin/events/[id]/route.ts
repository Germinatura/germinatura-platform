import { createRequestId } from "@germinatura/observability";
import { z } from "zod";
import { eventErrorResponse, saveEvent } from "@/lib/portal-events";

interface RouteContext { params: Promise<{ id: string }>; }

/** Edits an event that is not cancelled, at the expected revision. */
export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return eventErrorResponse("NOT_FOUND", "Evento não encontrado.", createRequestId(request.headers), 404);
  return saveEvent(request, id);
}
