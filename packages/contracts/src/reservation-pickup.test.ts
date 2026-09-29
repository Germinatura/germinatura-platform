import { describe, expect, it } from "vitest";
import { completePickupRequestSchema } from "./index";

const none = { tenderedCents: null, proofReference: null, cardMethod: null, terminalId: null };

describe("reservation pickup contracts", () => {
  it("charges cash with the tendered amount only", () => {
    expect(completePickupRequestSchema.safeParse({ ...none, integrationChannel: "DINHEIRO", tenderedCents: 3_000 }).success).toBe(true);
    expect(completePickupRequestSchema.safeParse({ ...none, integrationChannel: "DINHEIRO" }).success).toBe(false);
    expect(completePickupRequestSchema.safeParse({ ...none, integrationChannel: "DINHEIRO", tenderedCents: 3_000, proofReference: "NSU-0001" }).success).toBe(false);
  });

  it("requires a proof and, on the Maquininha, the card method", () => {
    expect(completePickupRequestSchema.safeParse({ ...none, integrationChannel: "MAQUININHA", proofReference: "NSU-0001", cardMethod: "DEBITO" }).success).toBe(true);
    expect(completePickupRequestSchema.safeParse({ ...none, integrationChannel: "MAQUININHA", proofReference: "NSU-0001" }).success).toBe(false);
    expect(completePickupRequestSchema.safeParse({ ...none, integrationChannel: "PIX_AREA", proofReference: "PIX-0001" }).success).toBe(true);
    expect(completePickupRequestSchema.safeParse({ ...none, integrationChannel: "PIX_AREA", proofReference: "4111111111111111" }).success).toBe(false);
  });
});
