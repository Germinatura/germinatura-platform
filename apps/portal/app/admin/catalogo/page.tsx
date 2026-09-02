import { hasPermission } from "@germinatura/auth";
import { Badge, Card, Input } from "@germinatura/ui";
import { Boxes, PackageCheck, PackageSearch, Store } from "lucide-react";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const productRowsSchema = z.array(z.object({
  id: z.uuid(), category_id: z.uuid(), sku: z.string(), name: z.string(), active: z.boolean(),
  published: z.boolean(), sellable_pdv: z.boolean(), reservable: z.boolean(), tracks_lots: z.boolean(),
}));
const categoryRowsSchema = z.array(z.object({ id: z.uuid(), name: z.string(), active: z.boolean() }));
const priceRowsSchema = z.array(z.object({ product_id: z.uuid(), amount_cents: z.number().int(), valid_to: z.string().nullable() }));
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export default async function CatalogAdminPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireSession();
  if (!hasPermission(user, "catalog.manage")) redirect("/");
  const params = await searchParams;
  const query = params.q?.trim().toLocaleLowerCase("pt-BR") ?? "";
  const client = await createSupabaseServerClient();
  const [productsResult, categoriesResult, pricesResult] = await Promise.all([
    client.from("products").select("id,category_id,sku,name,active,published,sellable_pdv,reservable,tracks_lots").order("name"),
    client.from("categories").select("id,name,active").order("sort_order"),
    client.from("product_prices").select("product_id,amount_cents,valid_to").is("valid_to", null).order("valid_from", { ascending: false }),
  ]);
  const parsedProducts = productRowsSchema.safeParse(productsResult.data);
  const parsedCategories = categoryRowsSchema.safeParse(categoriesResult.data);
  const parsedPrices = priceRowsSchema.safeParse(pricesResult.data);
  const unavailable = Boolean(productsResult.error || categoriesResult.error || pricesResult.error || !parsedProducts.success || !parsedCategories.success || !parsedPrices.success);
  const products = parsedProducts.success ? parsedProducts.data : [];
  const categoryById = new Map((parsedCategories.success ? parsedCategories.data : []).map((category) => [category.id, category]));
  const priceByProduct = new Map((parsedPrices.success ? parsedPrices.data : []).map((price) => [price.product_id, price.amount_cents]));
  const filtered = products.filter((product) => !query || `${product.name} ${product.sku} ${categoryById.get(product.category_id)?.name ?? ""}`.toLocaleLowerCase("pt-BR").includes(query));

  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header><p className="text-sm font-semibold text-[var(--g-brand-primary)]">Catálogo</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Produtos e publicação</h1><p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Consulte preços, categorias e disponibilidade nos canais. Alterações permanecem bloqueadas até a escrita transacional ser homologada.</p></header>
    {unavailable && <div role="alert" className="rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]">Não foi possível consultar o catálogo. Atualize a página antes de tomar uma decisão operacional.</div>}
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumo do catálogo">
      <Summary icon={PackageSearch} label="Produtos" value={products.length} />
      <Summary icon={PackageCheck} label="Publicados" value={products.filter((product) => product.published && product.active).length} />
      <Summary icon={Store} label="Disponíveis no PDV" value={products.filter((product) => product.sellable_pdv && product.active).length} />
      <Summary icon={Boxes} label="Categorias ativas" value={(parsedCategories.success ? parsedCategories.data : []).filter((category) => category.active).length} />
    </section>
    <Card className="overflow-hidden"><div className="flex flex-col gap-4 border-b border-[var(--g-border-subtle)] p-5 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-lg font-bold">Produtos cadastrados</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{filtered.length} de {products.length} produtos</p></div><form className="flex w-full gap-2 sm:max-w-md"><label className="flex-1"><span className="sr-only">Buscar produto</span><Input name="q" defaultValue={params.q ?? ""} placeholder="Nome, SKU ou categoria" /></label><button className="min-h-11 rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary)] px-4 text-sm font-semibold text-white">Buscar</button></form></div>
      {!unavailable && filtered.length === 0 ? <Empty text="Nenhum produto corresponde à busca." /> : !unavailable && <><div className="hidden overflow-x-auto md:block"><table className="w-full text-left text-sm"><thead className="bg-[var(--g-surface-subtle)] text-xs uppercase tracking-wide text-[var(--g-text-muted)]"><tr><th className="px-6 py-3">Produto</th><th className="px-6 py-3">Categoria</th><th className="px-6 py-3">Canais</th><th className="px-6 py-3">Estado</th><th className="px-6 py-3 text-right">Preço atual</th></tr></thead><tbody className="divide-y divide-[var(--g-border-subtle)]">{filtered.map((product) => <tr key={product.id} className="hover:bg-[var(--g-surface-hover)]"><td className="px-6 py-4"><p className="font-semibold">{product.name}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">{product.sku}</p></td><td className="px-6 py-4 text-[var(--g-text-secondary)]">{categoryById.get(product.category_id)?.name ?? "Sem categoria"}</td><td className="px-6 py-4"><div className="flex flex-wrap gap-1">{product.sellable_pdv && <Badge tone="info">PDV</Badge>}{product.reservable && <Badge tone="neutral">Reservável</Badge>}</div></td><td className="px-6 py-4"><Badge tone={product.active && product.published ? "success" : product.active ? "warning" : "danger"}>{product.active && product.published ? "Publicado" : product.active ? "Não publicado" : "Inativo"}</Badge></td><td className="g-money px-6 py-4 text-right font-semibold">{priceByProduct.has(product.id) ? money.format((priceByProduct.get(product.id) ?? 0) / 100) : "Sem preço"}</td></tr>)}</tbody></table></div><div className="divide-y divide-[var(--g-border-subtle)] md:hidden">{filtered.map((product) => <article key={product.id} className="space-y-3 p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{product.name}</h3><p className="mt-1 text-xs text-[var(--g-text-muted)]">{product.sku} · {categoryById.get(product.category_id)?.name ?? "Sem categoria"}</p></div><Badge tone={product.active && product.published ? "success" : product.active ? "warning" : "danger"}>{product.active && product.published ? "Publicado" : product.active ? "Não publicado" : "Inativo"}</Badge></div><p className="g-money text-xl font-bold">{priceByProduct.has(product.id) ? money.format((priceByProduct.get(product.id) ?? 0) / 100) : "Sem preço"}</p><div className="flex gap-1">{product.sellable_pdv && <Badge tone="info">PDV</Badge>}{product.reservable && <Badge tone="neutral">Reservável</Badge>}</div></article>)}</div></>}
    </Card>
  </div></div>;
}

function Summary({ icon: Icon, label, value }: { icon: typeof Boxes; label: string; value: number }) { return <Card className="p-5"><div className="flex items-start justify-between"><p className="text-sm font-semibold text-[var(--g-text-secondary)]">{label}</p><span className="flex size-10 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]"><Icon className="size-5" /></span></div><p className="mt-5 text-3xl font-bold">{value}</p></Card>; }
function Empty({ text }: { text: string }) { return <div className="p-10 text-center"><PackageSearch className="mx-auto size-10 text-[var(--g-text-muted)]" /><p className="mt-4 font-semibold">{text}</p><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Ajuste os termos e tente novamente.</p></div>; }
