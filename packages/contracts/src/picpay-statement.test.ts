import { describe, expect, it } from "vitest";
import { picpayStatementImportQuerySchema, resolvePicpayStatementLineRequestSchema } from "./picpay-statement";

describe("PicPay statement review contract", () => {
  it("never classifies an imported line as sale revenue", () => {
    expect(resolvePicpayStatementLineRequestSchema.safeParse({ action: "CLASSIFICAR", category: "VENDA_PDV" }).success).toBe(false);
    expect(resolvePicpayStatementLineRequestSchema.safeParse({ action: "CLASSIFICAR", category: "MATERIAIS" }).success).toBe(true);
  });

  it("requires a reason to mark as already recorded or to reopen", () => {
    expect(resolvePicpayStatementLineRequestSchema.safeParse({ action: "JA_REGISTRADO", reason: "curto" }).success).toBe(false);
    expect(resolvePicpayStatementLineRequestSchema.safeParse({ action: "REABRIR", reason: "Categoria errada" }).success).toBe(true);
  });

  it("reconciles only with an identified sale or refund", () => {
    expect(resolvePicpayStatementLineRequestSchema.safeParse({ action: "CONCILIAR_VENDA" }).success).toBe(false);
    expect(resolvePicpayStatementLineRequestSchema.safeParse({ action: "CONCILIAR_ESTORNO", refundEntryId: crypto.randomUUID() }).success).toBe(true);
  });

  it("needs the file name to import", () => {
    expect(picpayStatementImportQuerySchema.safeParse({ acceptOverlap: "true" }).success).toBe(false);
    expect(picpayStatementImportQuerySchema.safeParse({ fileName: "extrato.csv" }).success).toBe(true);
  });
});
