import { describe, expect, it } from "vitest";
import {
  closePicpayPeriodRequestSchema, linkPicpayTransactionRequestSchema, picpayExceptionsQuerySchema, picpayFilePreviewSchema,
  picpayPeriodQuerySchema, resolvePicpayExceptionRequestSchema,
} from "./picpay-reconciliation";

const preview = {
  sourceType: "PICPAY_SALES", sha256: "a".repeat(64), sizeBytes: 10, rowCount: 3, errorCount: 0, errors: [], periodFrom: "2026-09-01",
  periodTo: "2026-09-07", newCount: 1, knownCount: 1, updatedCount: 1, ambiguousCount: 0, alreadyImported: null, totals: { gross_cents: 1000 },
};

describe("PicPay reconciliation contract", () => {
  it("accepts an unrecognized file in the preview, without a type", () => {
    expect(picpayFilePreviewSchema.safeParse(preview).success).toBe(true);
    expect(picpayFilePreviewSchema.safeParse({ ...preview, sourceType: null, errorCount: 1, errors: [{ line: 1, code: "UNKNOWN_FILE" }] }).success).toBe(true);
    expect(picpayFilePreviewSchema.safeParse({ ...preview, sourceType: "OUTRO" }).success).toBe(false);
  });

  it("keeps money in integer cents", () => {
    expect(picpayFilePreviewSchema.safeParse({ ...preview, totals: { gross_cents: 10.5 } }).success).toBe(false);
  });

  it("refuses inverted periods", () => {
    expect(picpayPeriodQuerySchema.safeParse({ from: "2026-09-02", to: "2026-09-01" }).success).toBe(false);
    expect(picpayExceptionsQuerySchema.safeParse({ from: "2026-09-01", to: "2026-09-01", type: "DUPLICIDADE" }).success).toBe(true);
    expect(closePicpayPeriodRequestSchema.safeParse({ from: "2026-09-02", to: "2026-09-01", note: null }).success).toBe(false);
  });

  it("requires a reason to resolve, reopen, link or unlink", () => {
    expect(resolvePicpayExceptionRequestSchema.safeParse({ key: "PICPAY_SEM_PDV:x", action: "RESOLVIDA", reason: "curto" }).success).toBe(false);
    expect(resolvePicpayExceptionRequestSchema.safeParse({ key: "PICPAY_SEM_PDV:x", action: "REABERTA", reason: "Nova evidência" }).success).toBe(true);
    expect(linkPicpayTransactionRequestSchema.safeParse({ paymentAttemptId: crypto.randomUUID() }).success).toBe(false);
    expect(linkPicpayTransactionRequestSchema.safeParse({ paymentAttemptId: null, reason: "Vínculo feito por engano" }).success).toBe(true);
  });
});
