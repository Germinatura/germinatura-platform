import { publicCatalogProductSchema } from "@germinatura/contracts";
import { describe, expect, it } from "vitest";
import { cartPayload, formatMoney } from "./operations-pure";

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
