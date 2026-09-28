import { describe, expect, it } from "vitest";
import { adminSalesQuerySchema } from "./index";

describe("finance sales contracts", () => {
  it("accepts São Paulo calendar days in order", () => {
    expect(adminSalesQuerySchema.safeParse({ from: "2026-09-01", to: "2026-09-30", status: "CONFIRMED", channel: "RESERVA" }).success).toBe(true);
    expect(adminSalesQuerySchema.safeParse({ from: "2026-09-30", to: "2026-09-01" }).success).toBe(false);
    expect(adminSalesQuerySchema.safeParse({ from: "30/09/2026" }).success).toBe(false);
  });

  it("never lists drafts", () => {
    expect(adminSalesQuerySchema.safeParse({ status: "DRAFT" }).success).toBe(false);
    expect(adminSalesQuerySchema.safeParse({ pending: "sim" }).success).toBe(false);
  });
});
