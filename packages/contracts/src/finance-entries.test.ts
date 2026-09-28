import { describe, expect, it } from "vitest";
import { financeEntriesQuerySchema, recordFinanceEntryRequestSchema } from "./finance-entries";

const expense = {
  kind: "EXPENSE", category: "TRANSPORTE", account: "PICPAY_EMPRESAS", counterAccount: null,
  amountCents: 5_000, occurredOn: "2026-09-15", description: "Frete do evento", reference: "NF-2026-0915",
};

describe("finance entry contracts", () => {
  it("accepts expenses, incomes and transfers in cents", () => {
    expect(recordFinanceEntryRequestSchema.safeParse(expense).success).toBe(true);
    expect(recordFinanceEntryRequestSchema.safeParse({ ...expense, kind: "TRANSFER", category: null, counterAccount: "DINHEIRO_FISICO" }).success).toBe(true);
    expect(recordFinanceEntryRequestSchema.safeParse({ ...expense, amountCents: 50.5 }).success).toBe(false);
    expect(recordFinanceEntryRequestSchema.safeParse({ ...expense, amountCents: 0 }).success).toBe(false);
  });

  it("keeps sale revenue out of manual entries", () => {
    expect(recordFinanceEntryRequestSchema.safeParse({ ...expense, kind: "INCOME", category: "VENDA_PDV" }).success).toBe(false);
  });

  it("requires coherent transfers and non-sensitive references", () => {
    expect(recordFinanceEntryRequestSchema.safeParse({ ...expense, kind: "TRANSFER", category: null, counterAccount: "PICPAY_EMPRESAS" }).success).toBe(false);
    expect(recordFinanceEntryRequestSchema.safeParse({ ...expense, counterAccount: "DINHEIRO_FISICO" }).success).toBe(false);
    expect(recordFinanceEntryRequestSchema.safeParse({ ...expense, reference: "4111111111111111" }).success).toBe(false);
  });

  it("needs an ordered period", () => {
    expect(financeEntriesQuerySchema.safeParse({ from: "2026-09-01", to: "2026-09-30" }).success).toBe(true);
    expect(financeEntriesQuerySchema.safeParse({ from: "2026-09-30", to: "2026-09-01" }).success).toBe(false);
  });
});
