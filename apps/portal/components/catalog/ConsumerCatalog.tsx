"use client";

import {
  publicCatalogProductsResponseSchema,
  type PublicCatalogProduct,
} from "@germinatura/contracts";
import { Badge, Button, Card, Input } from "@germinatura/ui";
import { PackageSearch, RefreshCw, Search, ShoppingBag } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

async function fetchProducts(cursor?: string) {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/v1/catalog/products?${params.toString()}`, { cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error("Não foi possível carregar o catálogo. Tente novamente em alguns instantes.");
  const parsed = publicCatalogProductsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("O catálogo retornou dados inválidos. Atualize a página e tente novamente.");
  return parsed.data;
}

export function ConsumerCatalog() {
  const [products, setProducts] = useState<PublicCatalogProduct[]>([]);
  const [query, setQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchProducts();
      setProducts(result.data);
      setNextCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar o catálogo.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadInitial(), 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadInitial]);

  const filteredProducts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    if (!normalized) return products;
    return products.filter((product) => [product.name, product.sku, product.category.name]
      .some((value) => value.toLocaleLowerCase("pt-BR").includes(normalized)));
  }, [products, query]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError("");
    try {
      const result = await fetchProducts(nextCursor);
      setProducts((current) => [...current, ...result.data.filter((product) => !current.some((existing) => existing.id === product.id))]);
      setNextCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar mais produtos.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
        <header>
          <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Catálogo</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Produtos disponíveis</h1>
          <p className="mt-2 max-w-2xl text-base leading-6 text-[var(--g-text-secondary)]">Consulte preços e disponibilidade de reserva. O valor final sempre será recalculado pelo sistema no momento da operação.</p>
        </header>

        <label className="relative block max-w-xl">
          <span className="sr-only">Buscar no catálogo</span>
          <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-[var(--g-text-muted)]" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por produto, SKU ou categoria" className="pl-12" />
        </label>

        {error && <div role="alert" className="flex flex-col gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)] sm:flex-row sm:items-center sm:justify-between"><span>{error}</span><button type="button" onClick={() => void loadInitial()} className="inline-flex min-h-11 items-center gap-2 font-semibold"><RefreshCw className="size-4" /> Tentar novamente</button></div>}

        {loading ? (
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Carregando catálogo">{Array.from({ length: 6 }, (_, index) => <Card key={index} className="animate-pulse p-5"><div className="h-40 rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)]" /><div className="mt-5 h-4 w-24 rounded bg-[var(--g-surface-subtle)]" /><div className="mt-3 h-6 w-3/4 rounded bg-[var(--g-surface-subtle)]" /><div className="mt-5 h-8 w-28 rounded bg-[var(--g-surface-subtle)]" /></Card>)}</section>
        ) : filteredProducts.length === 0 ? (
          <Card className="p-10 text-center"><PackageSearch className="mx-auto size-11 text-[var(--g-text-muted)]" /><h2 className="mt-4 text-lg font-semibold">{products.length === 0 ? "Catálogo em preparação" : "Nenhum produto encontrado"}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--g-text-secondary)]">{products.length === 0 ? "Ainda não há produtos publicados. Volte mais tarde para conferir as novidades." : "Revise a busca ou tente pelo nome da categoria."}</p></Card>
        ) : (
          <>
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Produtos do catálogo">
              {filteredProducts.map((product) => <Card key={product.id} className="group overflow-hidden"><div className="flex h-40 items-center justify-center bg-[var(--g-surface-subtle)]"><ShoppingBag className="size-12 text-[var(--g-brand-primary)] transition-transform group-hover:scale-105" /></div><div className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">{product.category.name}</p><h2 className="mt-1 text-lg font-semibold">{product.name}</h2></div>{product.reservable && <Badge tone="info">Reservável</Badge>}</div><p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-[var(--g-text-secondary)]">{product.description ?? "Produto disponível no catálogo Germinatura."}</p><div className="mt-5 flex items-end justify-between gap-3"><div><p className="text-xs text-[var(--g-text-muted)]">Preço atual</p><p className="g-money mt-1 text-2xl font-bold">{money.format(product.price.amountCents / 100)}</p></div><p className="text-xs text-[var(--g-text-muted)]">{product.sku}</p></div></div></Card>)}
            </section>
            {nextCursor && <div className="flex justify-center"><Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>Carregar mais produtos</Button></div>}
          </>
        )}
      </div>
    </div>
  );
}
