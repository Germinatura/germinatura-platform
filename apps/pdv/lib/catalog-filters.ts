import type { PublicCatalogProduct } from "@germinatura/contracts";
import { parseMoneyInput } from "./operations-pure";

/** Filters of the sale catalog. Prices stay as typed (reais) until they are read. */
export interface SaleCatalogFilters {
  category: string;
  min: string;
  max: string;
  onlyAvailable: boolean;
  /** Smallest quantity available at the sale's location, as typed. */
  minAvailable: string;
}

export const emptySaleCatalogFilters: SaleCatalogFilters = { category: "", min: "", max: "", onlyAvailable: false, minAvailable: "" };

/** A price bound in cents; null when empty or not a valid amount (an invalid bound is reported, never applied). */
export function salePriceBound(value: string) {
  return value.trim() ? parseMoneyInput(value) : null;
}

/** A whole quantity of at least 1; null when empty or invalid. */
export function availableBound(value: string) {
  const trimmed = value.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const quantity = Number(trimmed);
  return quantity >= 1 ? quantity : null;
}

/** How many filters are in effect (each one is a chip). */
export function activeSaleFilterCount(filters: SaleCatalogFilters) {
  return [
    filters.category !== "",
    salePriceBound(filters.min) !== null,
    salePriceBound(filters.max) !== null,
    filters.onlyAvailable,
    availableBound(filters.minAvailable) !== null,
  ].filter(Boolean).length;
}

/**
 * The sale catalog after the search and every filter, all combined (AND). `available` is the quantity available for
 * sale at the selected location, as the server reported it.
 */
export function filterSaleCatalog(catalog: PublicCatalogProduct[], query: string, filters: SaleCatalogFilters, available: (productId: string) => number) {
  const normalized = query.trim().toLocaleLowerCase("pt-BR");
  const min = salePriceBound(filters.min);
  const max = salePriceBound(filters.max);
  const minAvailable = Math.max(filters.onlyAvailable ? 1 : 0, availableBound(filters.minAvailable) ?? 0);
  return catalog.filter((product) => {
    if (normalized && ![product.name, product.sku, product.category.name].some((value) => value.toLocaleLowerCase("pt-BR").includes(normalized))) return false;
    if (filters.category && product.category.id !== filters.category) return false;
    if (min !== null && product.price.amountCents < min) return false;
    if (max !== null && product.price.amountCents > max) return false;
    if (minAvailable > 0 && available(product.id) < minAvailable) return false;
    return true;
  });
}
