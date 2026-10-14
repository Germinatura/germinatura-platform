import {
  picpayAssignmentPreviewSchema, picpayAttributionStatusSchema, picpayUnassignedItemSchema, type PicpayAssignmentSelection,
} from "@germinatura/contracts";
import { z } from "zod";

// E0 (ADR 0011): shapes returned by the attribution functions (snake_case from the database).
const n = z.number().int();

const databaseStatusSchema = z.object({
  enforced: z.boolean(), updated_at: z.string().nullable(), reason: z.string().nullable(),
  unassigned: z.object({
    statement_lines: n, statement_net_cents: n, statement_pending: n, transactions: n, transactions_gross_cents: n, historical_transactions: n,
  }),
  by_cohort: z.array(z.object({ cohort_id: z.uuid(), name: z.string(), statement_lines: n, transactions: n })),
  files: z.array(z.object({
    id: z.uuid(), source_type: z.string(), number: n, file_name: z.string(), period_from: z.string(), period_to: z.string(),
    created_at: z.string(), scope: z.string(), declared_cohort_id: z.uuid().nullable(), declared_cohort_name: z.string().nullable(),
    unassigned: n, unassigned_cents: n,
  })),
});

export function toAttributionStatus(data: unknown) {
  const value = databaseStatusSchema.parse(data);
  return picpayAttributionStatusSchema.parse({
    enforced: value.enforced, updatedAt: value.updated_at, reason: value.reason,
    unassigned: {
      statementLines: value.unassigned.statement_lines, statementNetCents: value.unassigned.statement_net_cents,
      statementPending: value.unassigned.statement_pending, transactions: value.unassigned.transactions,
      transactionsGrossCents: value.unassigned.transactions_gross_cents, historicalTransactions: value.unassigned.historical_transactions,
    },
    byCohort: value.by_cohort.map((row) => ({ cohortId: row.cohort_id, name: row.name, statementLines: row.statement_lines, transactions: row.transactions })),
    files: value.files.map((file) => ({
      id: file.id, sourceType: file.source_type, number: file.number, fileName: file.file_name, periodFrom: file.period_from,
      periodTo: file.period_to, createdAt: file.created_at, scope: file.scope, declaredCohortId: file.declared_cohort_id,
      declaredCohortName: file.declared_cohort_name, unassigned: file.unassigned, unassignedCents: file.unassigned_cents,
    })),
  });
}

const databaseItemSchema = z.object({ kind: z.string(), id: z.uuid(), occurred_on: z.string(), amount_cents: n, label: z.string().nullable() });

export function toUnassignedItems(data: unknown) {
  return z.array(databaseItemSchema).parse(data).map((item) => picpayUnassignedItemSchema.parse({
    kind: item.kind, id: item.id, occurredOn: item.occurred_on, amountCents: item.amount_cents, label: item.label ?? "",
  }));
}

const databasePreviewSchema = z.object({
  cohort_id: z.uuid(), count: n, total_cents: n, statement_lines: n, transactions: n, first_on: z.string().nullable(),
  last_on: z.string().nullable(), already_in_cohort: n, other_cohort: n,
});

export function toAssignmentPreview(data: unknown) {
  const value = databasePreviewSchema.parse(data);
  return picpayAssignmentPreviewSchema.parse({
    cohortId: value.cohort_id, count: value.count, totalCents: value.total_cents, statementLines: value.statement_lines,
    transactions: value.transactions, firstOn: value.first_on, lastOn: value.last_on, alreadyInCohort: value.already_in_cohort,
    otherCohort: value.other_cohort,
  });
}

/** The selection as the database functions take it: a whole file, or listed items. */
export function selectionArgs(selection: PicpayAssignmentSelection) {
  return selection.importId
    ? { p_import_id: selection.importId, p_statement_line_ids: null, p_transaction_ids: null }
    : {
      p_import_id: null,
      p_statement_line_ids: selection.statementLineIds.length > 0 ? selection.statementLineIds : null,
      p_transaction_ids: selection.transactionIds.length > 0 ? selection.transactionIds : null,
    };
}
