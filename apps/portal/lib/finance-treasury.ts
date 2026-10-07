import {
  createApiError, financeBalanceCheckSchema, financeBalancesSchema, financeOpeningPositionSchema,
} from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

const n = z.number().int();
const unapplied = z.object({ count: n, net_cents: n });
const statementLines = z.object({ pending: unapplied, already_recorded: unapplied, linked: unapplied });
const toUnapplied = (value: z.infer<typeof statementLines>) => ({
  pending: { count: value.pending.count, netCents: value.pending.net_cents },
  alreadyRecorded: { count: value.already_recorded.count, netCents: value.already_recorded.net_cents },
  linked: { count: value.linked.count, netCents: value.linked.net_cents },
});

// Shapes returned by finance_balances, finance_opening_position_json and finance_balance_check_json.
export const databaseBalancesSchema = z.object({
  as_of: z.string(),
  opening: z.object({ id: z.uuid(), version: n, as_of: z.string(), operating_since: z.string() }).nullable(),
  accounts: z.array(z.object({
    account: z.string(), opening_cents: n, inflow_cents: n, outflow_cents: n, transfer_in_cents: n, transfer_out_cents: n, balance_cents: n,
  })),
  free_balance_cents: n, vault_balance_cents: n, available_balance_cents: n, receivables_balance_cents: n, cash_balance_cents: n,
  negative_accounts: z.array(z.string()),
  statement_lines: statementLines,
});

export function toBalances(value: z.infer<typeof databaseBalancesSchema>) {
  return financeBalancesSchema.parse({
    asOf: value.as_of,
    opening: value.opening ? { id: value.opening.id, version: value.opening.version, asOf: value.opening.as_of, operatingSince: value.opening.operating_since } : null,
    accounts: value.accounts.map((row) => ({
      account: row.account, openingCents: row.opening_cents, inflowCents: row.inflow_cents, outflowCents: row.outflow_cents,
      transferInCents: row.transfer_in_cents, transferOutCents: row.transfer_out_cents, balanceCents: row.balance_cents,
    })),
    freeBalanceCents: value.free_balance_cents, vaultBalanceCents: value.vault_balance_cents,
    availableBalanceCents: value.available_balance_cents, receivablesBalanceCents: value.receivables_balance_cents,
    cashBalanceCents: value.cash_balance_cents, negativeAccounts: value.negative_accounts,
    statementLines: toUnapplied(value.statement_lines),
  });
}

export const databaseOpeningPositionSchema = z.object({
  id: z.uuid(), version: n, as_of: z.string(), operating_since: z.string(), description: z.string(), reason: z.string().nullable(),
  supersedes_id: z.uuid().nullable(), accounts: z.record(z.string(), n), actor_name: z.string(), created_at: z.string(),
});

export function toOpeningPosition(value: z.infer<typeof databaseOpeningPositionSchema>) {
  return financeOpeningPositionSchema.parse({
    id: value.id, version: value.version, asOf: value.as_of, operatingSince: value.operating_since, description: value.description,
    reason: value.reason, supersedesId: value.supersedes_id,
    accounts: {
      PICPAY_EMPRESAS: value.accounts.PICPAY_EMPRESAS ?? 0, COFRINHO_PICPAY: value.accounts.COFRINHO_PICPAY ?? 0,
      RECEBIVEIS_PICPAY: value.accounts.RECEBIVEIS_PICPAY ?? 0, DINHEIRO_FISICO: value.accounts.DINHEIRO_FISICO ?? 0,
    },
    actorName: value.actor_name, createdAt: value.created_at,
  });
}

export const databaseBalanceCheckSchema = z.object({
  id: z.uuid(), number: n, as_of: z.string(), opening_position_id: z.uuid().nullable(),
  observed_free_cents: n, observed_vault_cents: n, observed_total_cents: n,
  computed_free_cents: n, computed_vault_cents: n, computed_total_cents: n, computed_receivables_cents: n, computed_cash_cents: n,
  free_difference_cents: n, vault_difference_cents: n, total_difference_cents: n, statement_lines: statementLines,
  status: z.string(), note: z.string().nullable(), actor_name: z.string(), created_at: z.string(),
});

export function toBalanceCheck(value: z.infer<typeof databaseBalanceCheckSchema>) {
  return financeBalanceCheckSchema.parse({
    id: value.id, number: value.number, asOf: value.as_of, openingPositionId: value.opening_position_id,
    observedFreeCents: value.observed_free_cents, observedVaultCents: value.observed_vault_cents, observedTotalCents: value.observed_total_cents,
    computedFreeCents: value.computed_free_cents, computedVaultCents: value.computed_vault_cents, computedTotalCents: value.computed_total_cents,
    computedReceivablesCents: value.computed_receivables_cents, computedCashCents: value.computed_cash_cents,
    freeDifferenceCents: value.free_difference_cents, vaultDifferenceCents: value.vault_difference_cents,
    totalDifferenceCents: value.total_difference_cents, statementLines: toUnapplied(value.statement_lines),
    status: value.status, note: value.note, actorName: value.actor_name, createdAt: value.created_at,
  });
}

export function treasuryErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}

/** Maps database errors of the balance, opening position and balance check commands to API responses. */
export function treasuryDatabaseError(message: string, requestId: string) {
  const conflicts: Record<string, string> = {
    OPENING_POSITION_ALREADY_RECORDED: "A posição de abertura já foi registrada. Para corrigir, registre uma nova versão com motivo.",
    OPENING_POSITION_STALE: "A posição de abertura mudou. Atualize a página antes de corrigir.",
    OPENING_POSITION_CONFLICTS_WITH_STATEMENT: "Esta abertura contradiz linhas do extrato já revisadas. Reabra essas linhas ou mantenha as datas.",
    IDEMPOTENCY_CONFLICT: "A chave já foi usada com outro conteúdo.",
    IDEMPOTENCY_IN_PROGRESS: "A operação já está em processamento.",
  };
  const code = Object.keys(conflicts).find((key) => message.includes(key));
  if (code) return treasuryErrorResponse(code, conflicts[code], requestId, 409);
  if (message.includes("INVALID_BALANCE_DATE")) return treasuryErrorResponse("INVALID_BALANCE_DATE", "Escolha um dia entre a abertura e hoje.", requestId, 422);
  if (message.includes("FINANCE_MANAGE_REQUIRED")) return treasuryErrorResponse("FORBIDDEN", "Operação não autorizada.", requestId, 403);
  if (message.includes("INVALID_")) return treasuryErrorResponse("INVALID_REQUEST", "Confira os dados enviados.", requestId, 422);
  return treasuryErrorResponse("FINANCE_UNAVAILABLE", "Saldo temporariamente indisponível.", requestId, 503);
}
