import { describe, expect, it } from "vitest";
import { recordFinanceBalanceCheckRequestSchema, recordFinanceOpeningPositionRequestSchema } from "./finance-treasury";
import { picpayStatementBulkResolveRequestSchema, picpayStatementLinkRequestSchema } from "./picpay-statement";

const opening = {
  asOf: "2026-08-27", operatingSince: "2026-10-06", freeCents: 0, vaultCents: 11_178, receivablesCents: 0, cashCents: 0,
  description: "Posição de abertura do cutover PicPay", reason: null, supersedesId: null,
};

describe("treasury contracts", () => {
  it("accepts a first opening position without reason and a correction with one", () => {
    expect(recordFinanceOpeningPositionRequestSchema.safeParse(opening).success).toBe(true);
    expect(recordFinanceOpeningPositionRequestSchema.safeParse({
      ...opening, reason: "Cofrinho conferido de novo", supersedesId: "8f1d5c52-0a39-4b6c-9a59-3a3b3a3b3a3b",
    }).success).toBe(true);
  });

  it("refuses an opening after the operation start, negative amounts and a correction without reason", () => {
    expect(recordFinanceOpeningPositionRequestSchema.safeParse({ ...opening, operatingSince: "2026-08-27" }).success).toBe(false);
    expect(recordFinanceOpeningPositionRequestSchema.safeParse({ ...opening, vaultCents: -1 }).success).toBe(false);
    expect(recordFinanceOpeningPositionRequestSchema.safeParse({ ...opening, supersedesId: "8f1d5c52-0a39-4b6c-9a59-3a3b3a3b3a3b" }).success).toBe(false);
  });

  it("checks observed balances in non-negative cents", () => {
    expect(recordFinanceBalanceCheckRequestSchema.safeParse({ asOf: "2026-10-05", observedFreeCents: 39, observedVaultCents: 1_927_765, note: null }).success).toBe(true);
    expect(recordFinanceBalanceCheckRequestSchema.safeParse({ asOf: "2026-10-05", observedFreeCents: 0.39, observedVaultCents: 0, note: null }).success).toBe(false);
  });

  it("requires the previewed count, total and selection to confirm a bulk, and never a sale category", () => {
    const bulk = { movement: "PIX_RECEBIDO", from: null, to: null, lineIds: null, category: "RECEITA_HISTORICA", reason: "Cutover: Pix históricos",
      expectedCount: 784, expectedTotalCents: 2_791_457, expectedSelectionSha256: "a".repeat(64) };
    expect(picpayStatementBulkResolveRequestSchema.safeParse(bulk).success).toBe(true);
    expect(picpayStatementBulkResolveRequestSchema.safeParse({ ...bulk, expectedCount: 1001 }).success).toBe(false);
    expect(picpayStatementBulkResolveRequestSchema.safeParse({ ...bulk, category: "VENDA_PDV" }).success).toBe(false);
    expect(picpayStatementBulkResolveRequestSchema.safeParse({ ...bulk, movement: null }).success).toBe(false);
  });

  it("links a line to exactly one record", () => {
    const id = "8f1d5c52-0a39-4b6c-9a59-3a3b3a3b3a3b";
    expect(picpayStatementLinkRequestSchema.safeParse({ payableSettlementId: id, manualEntryId: null, reason: null }).success).toBe(true);
    expect(picpayStatementLinkRequestSchema.safeParse({ payableSettlementId: id, manualEntryId: id, reason: null }).success).toBe(false);
    expect(picpayStatementLinkRequestSchema.safeParse({ payableSettlementId: null, manualEntryId: null, reason: null }).success).toBe(false);
  });
});
