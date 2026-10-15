import { hasPermission } from "@germinatura/auth";
import { Card } from "@germinatura/ui";
import { Boxes, PackageCheck, PackageSearch, Store } from "lucide-react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CatalogFilters } from "@/components/admin/CatalogFilters";
import { ProductsManager } from "@/components/admin/ProductsManager";
import { matchesCatalogFilters, readCatalogFilters } from "@/lib/catalog-filters";

export const dynamic = "force-dynamic";

const productRowsSchema = z.array(z.object({
  id: z.uuid(), category_id: z.uuid(), sku: z.string(), slug: z.string(), name: z.string(), description: z.string().nullable(), revision: z.number().int(), active: z.boolean(),
  published: z.boolean(), sellable_pdv: z.boolean(), reservable: z.boolean(), tracks_lots: z.boolean(),
  // Only the price in effect now (the validity ranges of a product never overlap): zero or one row.
  prices: z.array(z.object({ amount_cents: z.number().int().nonnegative() })).max(1),
}));
const categoryRowsSchema = z.array(z.object({ id: z.uuid(), name: z.string(), active: z.boolean() }));
const productImageRowsSchema = z.array(z.object({
  id: z.uuid(), product_id: z.uuid(), object_path: z.string(), alt_text: z.string(), sort_order: z.number().int(),
}));

export default async function CatalogAdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireSession();
  if (!hasPermission(user, "catalog.manage")) redirect("/");
  const params = await searchParams;
  const filters = readCatalogFilters(params);
  const now = new Date().toISOString();
  const client = await createSupabaseServerClient();
  const [productsResult, categoriesResult, imagesResult] = await Promise.all([
    client.from("products").select("id,category_id,sku,slug,name,description,revision,active,published,sellable_pdv,reservable,tracks_lots,prices:product_prices(amount_cents)")
      .lte("prices.valid_from", now).or(`valid_to.is.null,valid_to.gt."${now}"`, { referencedTable: "prices" }).order("name"),
    client.from("categories").select("id,name,active").order("sort_order"),
    client.from("product_images").select("id,product_id,object_path,alt_text,sort_order").eq("status", "ACTIVE").order("sort_order"),
  ]);
  const parsedProducts = productRowsSchema.safeParse(productsResult.data);
  const parsedCategories = categoryRowsSchema.safeParse(categoriesResult.data);
  const parsedImages = productImageRowsSchema.safeParse(imagesResult.data);
  const unavailable = Boolean(productsResult.error || categoriesResult.error || imagesResult.error || !parsedProducts.success || !parsedCategories.success || !parsedImages.success);
  const products = parsedProducts.success ? parsedProducts.data : [];
  const categoryById = new Map((parsedCategories.success ? parsedCategories.data : []).map((category) => [category.id, category]));
  const filtered = products.filter((product) => matchesCatalogFilters({
    name: product.name, sku: product.sku, categoryId: product.category_id, categoryName: categoryById.get(product.category_id)?.name ?? "",
    active: product.active, published: product.published, sellablePdv: product.sellable_pdv, reservable: product.reservable,
    currentPriceCents: product.prices[0]?.amount_cents ?? null,
  }, filters));
  const productEditorRows = filtered.map((product) => ({
    id: product.id, categoryId: product.category_id, sku: product.sku, slug: product.slug, name: product.name,
    description: product.description, revision: product.revision, active: product.active, published: product.published,
    sellablePdv: product.sellable_pdv, reservable: product.reservable, tracksLots: product.tracks_lots,
    currentPriceCents: product.prices[0]?.amount_cents ?? null,
    images: (parsedImages.success ? parsedImages.data : []).filter((image) => image.product_id === product.id).map((image) => ({
      id: image.id, productId: image.product_id, objectPath: image.object_path, altText: image.alt_text,
      sortOrder: image.sort_order, publicUrl: client.storage.from("product-images").getPublicUrl(image.object_path).data.publicUrl,
    })),
  }));
  const productCategories = parsedCategories.success ? parsedCategories.data : [];

  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header><p className="text-sm font-semibold text-[var(--g-brand-primary)]">Catálogo</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Produtos e publicação</h1><p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Consulte produtos, preços e disponibilidade nos canais. Use a gestão de categorias para organizar o catálogo.</p></header>
    {unavailable && <div role="alert" className="rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]">Não foi possível consultar o catálogo. Atualize a página antes de tomar uma decisão operacional.</div>}
    <Link href="/admin/catalogo/categorias" className="inline-flex min-h-11 items-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary)] px-4 font-semibold text-white">Gerenciar categorias</Link>
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumo do catálogo">
      <Summary icon={PackageSearch} label="Produtos" value={products.length} />
      <Summary icon={PackageCheck} label="Publicados" value={products.filter((product) => product.published && product.active).length} />
      <Summary icon={Store} label="Disponíveis no PDV" value={products.filter((product) => product.sellable_pdv && product.active).length} />
      <Summary icon={Boxes} label="Categorias ativas" value={(parsedCategories.success ? parsedCategories.data : []).filter((category) => category.active).length} />
    </section>
    <Card className="p-5"><CatalogFilters initial={filters} categories={productCategories.map(({ id, name }) => ({ id, name }))} shown={filtered.length} total={products.length} /></Card>
    {!unavailable && <ProductsManager products={productEditorRows} categories={productCategories} />}
  </div></div>;
}

function Summary({ icon: Icon, label, value }: { icon: typeof Boxes; label: string; value: number }) { return <Card className="p-5"><div className="flex items-start justify-between"><p className="text-sm font-semibold text-[var(--g-text-secondary)]">{label}</p><span className="flex size-10 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]"><Icon className="size-5" /></span></div><p className="mt-5 text-3xl font-bold">{value}</p></Card>; }
