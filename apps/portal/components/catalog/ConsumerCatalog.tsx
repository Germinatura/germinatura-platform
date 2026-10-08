"use client";

import {
  publicCatalogProductsResponseSchema,
  type PublicCatalogProduct,
} from "@germinatura/contracts";
import { Badge, Button, Card, Input, InputGroup } from "@germinatura/ui";
import { Bell, BellRing, PackageSearch, Plus, RefreshCw, Search, ShoppingBag } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReservationCart } from "@/components/catalog/ReservationCart";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
// The cart only lives in this tab; prices are always recalculated by the server.
const cartStorageKey = "germinatura.reservation-cart";
type StoredCart = Record<string, number>;
function readStoredCart(): StoredCart {
  try {
    const raw = window.sessionStorage.getItem(cartStorageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => Number.isInteger(entry[1]) && entry[1] > 0 && entry[1] < 100));
  } catch { return {}; }
}
function writeStoredCart(cart: StoredCart) {
  try { window.sessionStorage.setItem(cartStorageKey, JSON.stringify(cart)); } catch { /* storage unavailable: the cart stays in memory */ }
}

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

export function ConsumerCatalog({ canReserve = false }: { canReserve?: boolean }) {
  const [products, setProducts] = useState<PublicCatalogProduct[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<StoredCart>({});
  const [alerts, setAlerts] = useState<Set<string>>(new Set());
  const [alertBusy, setAlertBusy] = useState<string | null>(null);
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
    const initialLoad = window.setTimeout(() => {
      void loadInitial();
      if (canReserve) setCart(readStoredCart());
      void fetch("/api/v1/catalog/stock-alerts", { cache: "no-store" }).then(async (response) => {
        const body = await response.json().catch(() => null) as { data?: unknown } | null;
        if (response.ok && Array.isArray(body?.data)) setAlerts(new Set(body.data.filter((id): id is string => typeof id === "string")));
      }, () => undefined);
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadInitial, canReserve]);

  async function toggleAlert(productId: string) {
    const enabled = !alerts.has(productId);
    setAlertBusy(productId); setError("");
    try {
      const response = await fetch(`/api/v1/catalog/products/${productId}/stock-alert`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? "Não foi possível salvar o aviso.");
      }
      setAlerts((current) => { const next = new Set(current); if (enabled) next.add(productId); else next.delete(productId); return next; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o aviso."); }
    finally { setAlertBusy(null); }
  }

  function setQuantity(productId: string, quantity: number) {
    setCart((current) => {
      const next = { ...current };
      if (quantity <= 0) delete next[productId]; else next[productId] = Math.min(quantity, 99);
      writeStoredCart(next);
      return next;
    });
  }
  const cartLines = products.filter((product) => product.reservable && cart[product.id]).map((product) => ({ product, quantity: cart[product.id] }));
  const categories = useMemo(() => [...new Map(products.map((product) => [product.category.id, product.category.name])).entries()], [products]);

  const filteredProducts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    const inCategory = category ? products.filter((product) => product.category.id === category) : products;
    if (!normalized) return inCategory;
    return inCategory.filter((product) => [product.name, product.sku, product.category.name]
      .some((value) => value.toLocaleLowerCase("pt-BR").includes(normalized)));
  }, [products, query, category]);

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
          <p className="mt-2 max-w-2xl text-base leading-6 text-[var(--g-text-secondary)]">Consulte preços e monte sua reserva. O total, com as promoções, é calculado pelo sistema e fica congelado quando você reserva.</p>
        </header>

        <label className="block max-w-xl">
          <span className="sr-only">Buscar no catálogo</span>
          <InputGroup icon={<Search />}><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por produto, SKU ou categoria" /></InputGroup>
        </label>
        {categories.length > 1 && <div role="group" aria-label="Categorias" className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant={category === null ? "brand" : "secondary"} aria-pressed={category === null} onClick={() => setCategory(null)}>Todas</Button>
          {categories.map(([id, name]) => <Button key={id} type="button" size="sm" variant={category === id ? "brand" : "secondary"} aria-pressed={category === id} onClick={() => setCategory(id)}>{name}</Button>)}
        </div>}

        {error && <div role="alert" className="flex flex-col gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)] sm:flex-row sm:items-center sm:justify-between"><span>{error}</span><button type="button" onClick={() => void loadInitial()} className="inline-flex min-h-11 items-center gap-2 font-semibold"><RefreshCw className="size-4" /> Tentar novamente</button></div>}

        {loading ? (
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Carregando catálogo">{Array.from({ length: 6 }, (_, index) => <Card key={index} className="animate-pulse p-5"><div className="h-40 rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)]" /><div className="mt-5 h-4 w-24 rounded bg-[var(--g-surface-subtle)]" /><div className="mt-3 h-6 w-3/4 rounded bg-[var(--g-surface-subtle)]" /><div className="mt-5 h-8 w-28 rounded bg-[var(--g-surface-subtle)]" /></Card>)}</section>
        ) : filteredProducts.length === 0 ? (
          <Card className="p-10 text-center"><PackageSearch className="mx-auto size-11 text-[var(--g-text-muted)]" /><h2 className="mt-4 text-lg font-semibold">{products.length === 0 ? "Catálogo em preparação" : "Nenhum produto encontrado"}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--g-text-secondary)]">{products.length === 0 ? "Ainda não há produtos publicados. Volte mais tarde para conferir as novidades." : "Revise a busca ou tente pelo nome da categoria."}</p></Card>
        ) : (
          <div className={canReserve ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start" : undefined}><div className="space-y-6">
            <section className={`grid gap-4 sm:grid-cols-2 ${canReserve ? "xl:grid-cols-2" : "xl:grid-cols-3"}`} aria-label="Produtos do catálogo">
              {filteredProducts.map((product) => <Card key={product.id} className="group overflow-hidden">{product.images[0] ? <div role="img" aria-label={product.images[0].altText} className="h-40 bg-cover bg-center transition-transform group-hover:scale-[1.02]" style={{ backgroundImage: `url(${JSON.stringify(product.images[0].publicUrl)})` }} /> : <div className="flex h-40 items-center justify-center bg-[var(--g-surface-subtle)]"><ShoppingBag className="size-12 text-[var(--g-brand-primary)] transition-transform group-hover:scale-105" /></div>}<div className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">{product.category.name}</p><h2 className="mt-1 text-lg font-semibold">{product.name}</h2></div><div className="flex flex-col items-end gap-1">{product.reservable && <Badge tone="info">Reservável</Badge>}{product.portalAvailable !== undefined && <Badge tone={product.portalAvailable ? "success" : "neutral"}>{product.portalAvailable ? "Disponível" : "Indisponível"}</Badge>}</div></div><p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-[var(--g-text-secondary)]">{product.description ?? "Produto disponível no catálogo Germinatura."}</p><div className="mt-5 flex items-end justify-between gap-3"><div><p className="text-xs text-[var(--g-text-muted)]">Preço atual</p><p className="g-money mt-1 text-2xl font-bold">{money.format(product.price.amountCents / 100)}</p></div><p className="text-xs text-[var(--g-text-muted)]">{product.sku}</p></div>{product.portalAvailable === false && <Button type="button" variant="secondary" className="mt-4 w-full" loading={alertBusy === product.id} disabled={alertBusy !== null} aria-pressed={alerts.has(product.id)} onClick={() => void toggleAlert(product.id)}>{alerts.has(product.id) ? <><BellRing className="size-4" />Aviso ativado</> : <><Bell className="size-4" />Avise-me quando voltar</>}</Button>}{canReserve && product.reservable && product.portalAvailable !== false && <Button type="button" variant={cart[product.id] ? "secondary" : "brand"} className="mt-4 w-full" aria-label={`Adicionar ${product.name} à reserva`} onClick={() => setQuantity(product.id, (cart[product.id] ?? 0) + 1)}><Plus className="size-4" />{cart[product.id] ? `Na reserva (${cart[product.id]})` : "Adicionar à reserva"}</Button>}</div></Card>)}
            </section>
            {nextCursor && <div className="flex justify-center"><Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>Carregar mais produtos</Button></div>}
          </div>{canReserve && <aside className="lg:sticky lg:top-6"><ReservationCart lines={cartLines} onQuantity={setQuantity} onClear={() => { setCart({}); writeStoredCart({}); }} /></aside>}</div>
        )}
      </div>
    </div>
  );
}
