import { publicCatalogProductSchema, type PublicCatalogProduct } from "@germinatura/contracts";
import { describe, expect, it } from "vitest";
import { activeSaleFilterCount, availableBound, emptySaleCatalogFilters, filterSaleCatalog, salePriceBound } from "./catalog-filters";

const brownie = { id: "23f00000-0000-4000-8000-000000000001", slug: "brownie", name: "Brownie" };
const bolo = { id: "23f00000-0000-4000-8000-000000000002", slug: "bolo", name: "Bolo de pote" };
let sequence = 0;
const product = (name: string, sku: string, category: typeof brownie, amountCents: number): PublicCatalogProduct => publicCatalogProductSchema.parse({
  id: `33f00000-0000-4000-8000-00000000000${(sequence += 1)}`, sku, slug: sku.toLowerCase(), name, description: null, category,
  price: { amountCents, currency: "BRL" }, sellablePdv: true, reservable: false, images: [],
});

const ninho = product("Brownie Ninho", "BNI", brownie, 1200);
const pistache = product("Brownie Pistache", "BPI", brownie, 1800);
const ninhoSemEstoque = product("Brownie Ninho com Nutella", "BNN", brownie, 1400);
const boloNinho = product("Bolo de pote Ninho", "PNI", bolo, 1000);
const catalog = [ninho, pistache, ninhoSemEstoque, boloNinho];
const stock: Record<string, number> = { [ninho.id]: 6, [pistache.id]: 3, [ninhoSemEstoque.id]: 0, [boloNinho.id]: 9 };
const available = (id: string) => stock[id] ?? 0;
const names = (list: PublicCatalogProduct[]) => list.map((item) => item.name);

describe("sale catalog filters", () => {
  it("combines category, maximum price, availability and search", () => {
    const filters = { ...emptySaleCatalogFilters, category: brownie.id, max: "15", onlyAvailable: true };
    expect(names(filterSaleCatalog(catalog, "ninho", filters, available))).toEqual(["Brownie Ninho"]);
    expect(activeSaleFilterCount(filters)).toBe(3);
  });

  it("keeps the whole catalog without search or filters", () => {
    expect(filterSaleCatalog(catalog, " ", emptySaleCatalogFilters, available)).toHaveLength(4);
    expect(activeSaleFilterCount(emptySaleCatalogFilters)).toBe(0);
  });

  it("applies price bounds inclusively, in cents", () => {
    expect(names(filterSaleCatalog(catalog, "", { ...emptySaleCatalogFilters, min: "12", max: "14,00" }, available))).toEqual(["Brownie Ninho", "Brownie Ninho com Nutella"]);
  });

  it("filters by the quantity available at the sale's location", () => {
    expect(names(filterSaleCatalog(catalog, "", { ...emptySaleCatalogFilters, minAvailable: "5" }, available))).toEqual(["Brownie Ninho", "Bolo de pote Ninho"]);
    expect(names(filterSaleCatalog(catalog, "", { ...emptySaleCatalogFilters, onlyAvailable: true }, available))).not.toContain("Brownie Ninho com Nutella");
  });

  it("ignores an invalid bound instead of hiding everything, and does not count it", () => {
    const filters = { ...emptySaleCatalogFilters, max: "quinze", minAvailable: "0" };
    expect(filterSaleCatalog(catalog, "", filters, available)).toHaveLength(4);
    expect(activeSaleFilterCount(filters)).toBe(0);
    expect(salePriceBound("quinze")).toBeNull();
    expect(availableBound("2,5")).toBeNull();
    expect(availableBound("3")).toBe(3);
  });
});
