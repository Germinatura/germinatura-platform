import { publicCatalogProductSchema } from "@germinatura/contracts";
import { describe, expect, it } from "vitest";
import { cartPayload, cashChange, formatMoney, mySaleStatus, parseMoneyInput, paymentMethodLabel } from "./operations-pure";

const product = publicCatalogProductSchema.parse({
  id: "33f00000-0000-4000-8000-000000000001",
  sku: "PUBLIC-ITEM-A",
  slug: "public-item-a",
  name: "Item público A",
  description: null,
  category: {
    id: "23f00000-0000-4000-8000-000000000001",
    slug: "catalogo-publico-local",
    name: "Catálogo público local",
  },
  price: { amountCents: 2590, currency: "BRL" },
  sellablePdv: true,
  reservable: true,
  images: [],
});

describe("PDV operation helpers", () => {
  it("formats integer cents as Brazilian reais", () => {
    expect(formatMoney(2590).replace(/\u00a0/g, " ")).toBe("R$ 25,90");
  });

  it("sends only product identity and quantity to authoritative pricing", () => {
    const payload = cartPayload([{ product, quantity: 2 }]);
    expect(payload).toEqual([{ productId: product.id, quantity: 2 }]);
    expect(payload[0]).not.toHaveProperty("totalCents");
    expect(payload[0]).not.toHaveProperty("unitPriceCents");
  });
});

describe("cash input", () => {
  it("parses typed reais into integer cents", () => {
    expect(parseMoneyInput("50")).toBe(5_000);
    expect(parseMoneyInput("50,5")).toBe(5_050);
    expect(parseMoneyInput("R$ 1.234,56")).toBe(123_456);
    expect(parseMoneyInput("25.90")).toBe(2_590);
    expect(parseMoneyInput("abc")).toBeNull();
    expect(parseMoneyInput("1,234")).toBeNull();
  });

  it("computes change only when the tendered cash covers the total", () => {
    expect(cashChange(2_590, 5_000)).toBe(2_410);
    expect(cashChange(2_590, 2_590)).toBe(0);
    expect(cashChange(2_590, 2_000)).toBeNull();
    expect(cashChange(2_590, null)).toBeNull();
  });
});

describe("my sales labels", () => {
  it("highlights pending sales before their stored status", () => {
    expect(mySaleStatus({ status: "AWAITING_PAYMENT", pendingReason: "AWAITING_PAYMENT", payment: { status: "CREATED" } }).label).toBe("Aguardando pagamento");
    expect(mySaleStatus({ status: "CONFIRMED", pendingReason: "RECONCILIATION_PENDING", payment: { status: "RECONCILIATION_PENDING" } }).label).toBe("Pendente de conciliação");
    expect(mySaleStatus({ status: "CONFIRMED", pendingReason: null, payment: { status: "APPROVED" } }).label).toBe("Concluída");
  });

  it("tells a refunded sale from an unpaid cancellation", () => {
    expect(mySaleStatus({ status: "CANCELLED", pendingReason: null, payment: { status: "REFUNDED" } }).label).toBe("Estornada");
    expect(mySaleStatus({ status: "CANCELLED", pendingReason: null, payment: { status: "CANCELLED" } }).label).toBe("Cancelada");
  });

  it("names the payment method", () => {
    expect(paymentMethodLabel("DINHEIRO")).toBe("Dinheiro");
    expect(paymentMethodLabel("PIX_AREA")).toBe("Pix (Área Pix)");
    expect(paymentMethodLabel(null)).toBe("Sem pagamento");
  });
});
