import { describe, expect, it } from "vitest";
import { financeOverviewSchema } from "./finance-history";

const historicalAdjustments = financeOverviewSchema.shape.result.shape.historicalAdjustments;

describe("finance overview historical adjustments", () => {
  it("accepts a period without adjustments and one with only some components", () => {
    expect(historicalAdjustments.parse({})).toEqual({});
    expect(historicalAdjustments.parse({ CMV: { resultEffectCents: -107_650, componentEffectCents: 107_650 } }))
      .toEqual({ CMV: { resultEffectCents: -107_650, componentEffectCents: 107_650 } });
  });

  it("refuses an unknown component", () => {
    expect(historicalAdjustments.safeParse({ VENDA: { resultEffectCents: 1, componentEffectCents: 1 } }).success).toBe(false);
  });
});
