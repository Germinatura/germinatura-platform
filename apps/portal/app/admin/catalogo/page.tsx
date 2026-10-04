import { hasPermission } from "@germinatura/auth";
import { Card, Input } from "@germinatura/ui";
import { Boxes, PackageCheck, PackageSearch, Store } from "lucide-react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ProductsManager } from "@/components/admin/ProductsManager";

export const dynamic = "force-dynamic";

const productRowsSchema = z.array(z.object({
  id: z.uuid(), category_id: z.uuid(), sku: z.string(), slug: z.string(), name: z.string(), description: z.string().nullable(), revision: z.number().int(), active: z.boolean(),
  published: z.boolean(), sellable_pdv: z.boolean(), reservable: z.boolean(), tracks_lots: z.boolean(),
}));
const categoryRowsSchema = z.array(z.object({ id: z.uuid(), name: z.string(), active: z.boolean() }));
const productImageRowsSchema = z.array(z.object({
  id: z.uuid(), product_id: z.uuid(), object_path: z.string(), alt_text: z.string(), sort_order: z.number().int(),
}));

export default async function CatalogAdminPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireSession();
  if (!hasPermission(user, "catalog.manage")) redirect("/");
  const params = await searchParams;
  const query = params.q?.trim().toLocaleLowerCase("pt-BR") ?? "";
  const client = await createSupabaseServerClient();
  const [productsResult, categoriesResult, imagesResult] = await Promise.all([
    client.from("products").select("id,category_id,sku,slug,name,description,revision,active,published,sellable_pdv,reservable,tracks_lots").order("name"),
    client.from("categories").select("id,name,active").order("sort_order"),
    client.from("product_images").select("id,product_id,object_path,alt_text,sort_order").eq("status", "ACTIVE").order("sort_order"),
  ]);
  const parsedProducts = productRowsSchema.safeParse(productsResult.data);
  const parsedCategories = categoryRowsSchema.safeParse(categoriesResult.data);
  const parsedImages = productImageRowsSchema.safeParse(imagesResult.data);
  const unavailable = Boolean(productsResult.error || categoriesResult.error || imagesResult.error || !parsedProducts.success || !parsedCategories.success || !parsedImages.success);
  const products = parsedProducts.success ? parsedProducts.data : [];
  const categoryById = new Map((parsedCategories.success ? parsedCategories.data : []).map((category) => [category.id, category]));
  const filtered = products.filter((product) => !query || `${product.name} ${product.sku} ${categoryById.get(product.category_id)?.name ?? ""}`.toLocaleLowerCase("pt-BR").includes(query));
  const productEditorRows = filtered.map((product) => ({
    id: product.id, categoryId: product.category_id, sku: product.sku, slug: product.slug, name: product.name,
    description: product.description, revision: product.revision, active: product.active, published: product.published,
    sellablePdv: product.sellable_pdv, reservable: product.reservable, tracksLots: product.tracks_lots,
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
    <Card className="p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-lg font-bold">Localizar produto</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{filtered.length} de {products.length} produtos</p></div><form className="flex w-full gap-2 sm:max-w-md"><label className="flex-1"><span className="sr-only">Buscar produto</span><Input name="q" defaultValue={params.q ?? ""} placeholder="Nome, SKU ou categoria" /></label><button className="min-h-11 rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary)] px-4 text-sm font-semibold text-white">Buscar</button></form></div></Card>
    {!unavailable && <ProductsManager products={productEditorRows} categories={productCategories} />}
  </div></div>;
}

function Summary({ icon: Icon, label, value }: { icon: typeof Boxes; label: string; value: number }) { return <Card className="p-5"><div className="flex items-start justify-between"><p className="text-sm font-semibold text-[var(--g-text-secondary)]">{label}</p><span className="flex size-10 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]"><Icon className="size-5" /></span></div><p className="mt-5 text-3xl font-bold">{value}</p></Card>; }
