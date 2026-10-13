import { describe, expect, it } from "vitest";
import { catalogFiltersQuery, emptyCatalogFilters, matchesCatalogFilters, priceBound, readCatalogFilters, type CatalogFilterProduct } from "./catalog-filters";

const brownie = "11111111-1111-4111-8111-111111111111";
const bolo = "22222222-2222-4222-8222-222222222222";
const product = (overrides: Partial<CatalogFilterProduct>): CatalogFilterProduct => ({
  name: "Brownie Ninho", sku: "BNI", categoryId: brownie, categoryName: "Brownie", active: true, published: true,
  sellablePdv: true, reservable: false, currentPriceCents: 1200, ...overrides,
});

describe("admin catalog filters", () => {
  it("reads the URL defensively and writes back only the filters in use", () => {
    expect(readCatalogFilters({})).toEqual(emptyCatalogFilters);
    expect(readCatalogFilters({ status: "DELETED", channel: ["PDV", "PORTAL"], q: "  ninho " })).toEqual({ ...emptyCatalogFilters, channel: "PDV", q: "ninho" });
    expect(catalogFiltersQuery({ ...emptyCatalogFilters, category: brownie, max: "15" })).toBe(`category=${brownie}&max=15`);
    expect(catalogFiltersQuery(emptyCatalogFilters)).toBe("");
  });

  it("reads price bounds in reais without floating point and reports an invalid one", () => {
    expect(priceBound("15")).toEqual({ cents: 1500, invalid: false });
    expect(priceBound("15,50")).toEqual({ cents: 1550, invalid: false });
    expect(priceBound("")).toEqual({ cents: null, invalid: false });
    expect(priceBound("quinze")).toEqual({ cents: null, invalid: true });
  });

  it("combines every filter: category, price, channel and search together", () => {
    const filters = { ...emptyCatalogFilters, category: brownie, max: "15", channel: "PDV" as const, q: "ninho" };
    expect(matchesCatalogFilters(product({}), filters)).toBe(true);
    expect(matchesCatalogFilters(product({ categoryId: bolo, categoryName: "Bolo" }), filters)).toBe(false);
    expect(matchesCatalogFilters(product({ currentPriceCents: 1501 }), filters)).toBe(false);
    expect(matchesCatalogFilters(product({ sellablePdv: false }), filters)).toBe(false);
    expect(matchesCatalogFilters(product({ name: "Brownie Pistache", sku: "BPI" }), filters)).toBe(false);
  });

  it("keeps a product without a price in effect out of any price range, and ignores an invalid bound", () => {
    expect(matchesCatalogFilters(product({ currentPriceCents: null }), { ...emptyCatalogFilters, min: "0" })).toBe(false);
    expect(matchesCatalogFilters(product({ currentPriceCents: null }), emptyCatalogFilters)).toBe(true);
    expect(matchesCatalogFilters(product({ currentPriceCents: 1200 }), { ...emptyCatalogFilters, min: "12", max: "12,00" })).toBe(true);
    expect(matchesCatalogFilters(product({}), { ...emptyCatalogFilters, max: "dez" })).toBe(true);
  });

  it("filters by situation and by the unpublished channel", () => {
    expect(matchesCatalogFilters(product({ active: false }), { ...emptyCatalogFilters, status: "ACTIVE" })).toBe(false);
    expect(matchesCatalogFilters(product({ active: false }), { ...emptyCatalogFilters, status: "INACTIVE" })).toBe(true);
    expect(matchesCatalogFilters(product({ published: false }), { ...emptyCatalogFilters, channel: "UNPUBLISHED" })).toBe(true);
    expect(matchesCatalogFilters(product({}), { ...emptyCatalogFilters, channel: "UNPUBLISHED" })).toBe(false);
  });
});
