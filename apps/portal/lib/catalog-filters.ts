import { parseReais } from "./money-input";

export type CatalogStatusFilter = "ALL" | "ACTIVE" | "INACTIVE";
export type CatalogChannelFilter = "ALL" | "PORTAL" | "PDV" | "RESERVABLE" | "UNPUBLISHED";

/** Filters of the admin catalog as they travel in the URL (strings, so a half-typed price survives a reload). */
export interface CatalogFilterValues {
  q: string;
  category: string;
  status: CatalogStatusFilter;
  channel: CatalogChannelFilter;
  min: string;
  max: string;
}

export const emptyCatalogFilters: CatalogFilterValues = { q: "", category: "", status: "ALL", channel: "ALL", min: "", max: "" };

const statuses: CatalogStatusFilter[] = ["ALL", "ACTIVE", "INACTIVE"];
const channels: CatalogChannelFilter[] = ["ALL", "PORTAL", "PDV", "RESERVABLE", "UNPUBLISHED"];

export const catalogStatusLabels: Record<Exclude<CatalogStatusFilter, "ALL">, string> = { ACTIVE: "Ativos", INACTIVE: "Inativos" };
export const catalogChannelLabels: Record<Exclude<CatalogChannelFilter, "ALL">, string> = {
  PORTAL: "Publicados no Portal", PDV: "Vendidos no PDV", RESERVABLE: "Reserváveis", UNPUBLISHED: "Não publicados",
};

type RawParams = Partial<Record<keyof CatalogFilterValues, string | string[] | undefined>>;

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** Reads the URL; unknown options fall back to "all", so an old or edited link never breaks the page. */
export function readCatalogFilters(params: RawParams): CatalogFilterValues {
  const status = first(params.status) as CatalogStatusFilter;
  const channel = first(params.channel) as CatalogChannelFilter;
  return {
    q: first(params.q).slice(0, 120),
    category: first(params.category),
    status: statuses.includes(status) ? status : "ALL",
    channel: channels.includes(channel) ? channel : "ALL",
    min: first(params.min).slice(0, 20),
    max: first(params.max).slice(0, 20),
  };
}

/** The URL query of the filters, without the empty ones. */
export function catalogFiltersQuery(filters: CatalogFilterValues) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters) as [keyof CatalogFilterValues, string][]) {
    const trimmed = value.trim();
    if (trimmed && trimmed !== emptyCatalogFilters[key]) params.set(key, trimmed);
  }
  return params.toString();
}

/** A price bound in cents; null when empty. A bound that is not a valid amount is reported and not applied. */
export function priceBound(value: string): { cents: number | null; invalid: boolean } {
  if (!value.trim()) return { cents: null, invalid: false };
  const cents = parseReais(value);
  return cents === null ? { cents: null, invalid: true } : { cents, invalid: false };
}

export interface CatalogFilterProduct {
  name: string;
  sku: string;
  categoryId: string;
  categoryName: string;
  active: boolean;
  published: boolean;
  sellablePdv: boolean;
  reservable: boolean;
  /** Price in effect now; null when the product has none. */
  currentPriceCents: number | null;
}

/** Every filter combines with the others (AND). A price bound excludes products without a price in effect. */
export function matchesCatalogFilters(product: CatalogFilterProduct, filters: CatalogFilterValues) {
  const query = filters.q.toLocaleLowerCase("pt-BR");
  if (query && !`${product.name} ${product.sku} ${product.categoryName}`.toLocaleLowerCase("pt-BR").includes(query)) return false;
  if (filters.category && product.categoryId !== filters.category) return false;
  if (filters.status === "ACTIVE" && !product.active) return false;
  if (filters.status === "INACTIVE" && product.active) return false;
  if (filters.channel === "PORTAL" && !product.published) return false;
  if (filters.channel === "PDV" && !product.sellablePdv) return false;
  if (filters.channel === "RESERVABLE" && !product.reservable) return false;
  if (filters.channel === "UNPUBLISHED" && product.published) return false;
  const min = priceBound(filters.min).cents;
  const max = priceBound(filters.max).cents;
  if (min !== null && (product.currentPriceCents === null || product.currentPriceCents < min)) return false;
  if (max !== null && (product.currentPriceCents === null || product.currentPriceCents > max)) return false;
  return true;
}
