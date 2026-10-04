import { describe, expect, it } from "vitest";
import { manualPaymentConfirmationRequestSchema, savePaymentTerminalRequestSchema } from "./index";

describe("card-present contracts", () => {
  it("requires the card method on the Maquininha only", () => {
    expect(manualPaymentConfirmationRequestSchema.safeParse({ integrationChannel: "MAQUININHA", proofReference: "NSU-0001" }).success).toBe(false);
    expect(manualPaymentConfirmationRequestSchema.safeParse({ integrationChannel: "MAQUININHA", proofReference: "NSU-0001", cardMethod: "DEBITO" }).success).toBe(true);
    expect(manualPaymentConfirmationRequestSchema.safeParse({ integrationChannel: "PIX_AREA", proofReference: "PIX-0001" }).success).toBe(true);
    expect(manualPaymentConfirmationRequestSchema.safeParse({ integrationChannel: "PIX_AREA", proofReference: "PIX-0001", cardMethod: "CREDITO" }).success).toBe(false);
  });

  it("never accepts card numbers as proof", () => {
    expect(manualPaymentConfirmationRequestSchema.safeParse({ integrationChannel: "MAQUININHA", proofReference: "4111111111111111", cardMethod: "CREDITO" }).success).toBe(false);
  });

  it("normalizes terminal codes", () => {
    expect(savePaymentTerminalRequestSchema.parse({ code: " maq-01 ", label: "Maquininha do caixa", active: true }).code).toBe("MAQ-01");
    expect(savePaymentTerminalRequestSchema.safeParse({ code: "MAQ 01", label: "Maquininha do caixa", active: true }).success).toBe(false);
  });
});
