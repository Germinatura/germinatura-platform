import { createApiError, paymentTerminalSchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

// Rows returned by public.list_payment_terminals and public.save_payment_terminal.
export const databaseTerminalSchema = z.object({
  id: z.uuid(), code: z.string(), label: z.string(), active: z.boolean(), updated_at: z.string(),
});

export function toPaymentTerminal(value: z.infer<typeof databaseTerminalSchema>) {
  return paymentTerminalSchema.parse({ id: value.id, code: value.code, label: value.label, active: value.active, updatedAt: value.updated_at });
}

export function terminalErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

/** Maps database errors of the terminal registry to API responses. */
export function terminalDatabaseError(message: string, requestId: string) {
  if (message.includes("PAYMENT_TERMINAL_CODE_TAKEN")) return terminalErrorResponse("PAYMENT_TERMINAL_CODE_TAKEN", "Já existe uma maquininha com esse código.", requestId, 409);
  if (message.includes("PAYMENT_TERMINAL_NOT_FOUND")) return terminalErrorResponse("NOT_FOUND", "Maquininha não encontrada.", requestId, 404);
  if (message.includes("IDEMPOTENCY_CONFLICT")) return terminalErrorResponse("IDEMPOTENCY_CONFLICT", "A chave já foi usada com outro conteúdo.", requestId, 409);
  if (message.includes("IDEMPOTENCY_IN_PROGRESS")) return terminalErrorResponse("IDEMPOTENCY_IN_PROGRESS", "A operação já está em processamento.", requestId, 409);
  if (message.includes("FINANCE_MANAGE_REQUIRED") || message.includes("FORBIDDEN")) return terminalErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
  if (message.includes("INVALID_")) return terminalErrorResponse("INVALID_REQUEST", "Confira o código e o nome da maquininha.", requestId, 422);
  return terminalErrorResponse("TERMINALS_UNAVAILABLE", "Maquininhas temporariamente indisponíveis.", requestId, 503);
}

