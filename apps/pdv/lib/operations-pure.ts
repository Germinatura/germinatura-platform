import type { PublicCatalogProduct } from "@germinatura/contracts";

export interface CartPayloadItem {
  product: PublicCatalogProduct;
  quantity: number;
}

export function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(amountCents / 100);
}

export function cartPayload(items: CartPayloadItem[]) {
  return items.map(({ product, quantity }) => ({ productId: product.id, quantity }));
}
