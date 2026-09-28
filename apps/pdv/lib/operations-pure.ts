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

/** Parses a typed BRL amount ("50", "50,5", "1.234,56") into integer cents, or null. */
export function parseMoneyInput(value: string): number | null {
  const normalized = value.trim().replace(/^R\$\s*/i, "").replace(/\.(?=\d{3}(\D|$))/g, "");
  const match = normalized.match(/^(\d{1,13})(?:[,.](\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Change for a cash payment, or null while the tendered amount does not cover the total. */
export function cashChange(totalCents: number, tenderedCents: number | null): number | null {
  return tenderedCents === null || tenderedCents < totalCents ? null : tenderedCents - totalCents;
}
