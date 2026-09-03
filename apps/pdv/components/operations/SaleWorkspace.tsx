"use client";

import { Badge, BrandMark, Button, Card, Field, Input } from "@germinatura/ui";
import type {
  ManualPaymentConfirmationResponse,
  PaymentIntegrationChannel,
  PricingQuoteResponse,
  PublicCatalogProduct,
  SalesCheckoutResponse,
} from "@germinatura/contracts";
import {
  AlertTriangle, ArrowLeft, Banknote, Check, ChevronDown, CircleCheck, CreditCard,
  Loader2, LogOut, Minus, PackageSearch, Plus, RotateCcw, Search, ShoppingBag,
  Store, Undo2, WifiOff, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PdvSessionUser } from "@/app/page";
import { CloseoutWorkspace } from "@/components/operations/CloseoutWorkspace";
import { useToast } from "@/components/ui/Toast";
import {
  cancelPendingSale, checkoutCart, confirmManualPayment, formatMoney, loadCatalog,
  loadInventoryContext, quoteCart, type CartItem, type InventoryContext,
} from "@/lib/operations";
import { getSupabaseBrowserClient } from "@/lib/supabase";

type Step = "catalog" | "review" | "payment" | "success";
type CheckoutData = SalesCheckoutResponse["data"];
type ConfirmationData = ManualPaymentConfirmationResponse["data"];
type QuoteData = PricingQuoteResponse["data"];
type ManualChannel = Extract<PaymentIntegrationChannel, "MAQUININHA" | "PIX_AREA">;

const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000";
const operationKey = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
const messageFrom = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir esta ação.";
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

export function SaleWorkspace({ user }: { user: PdvSessionUser }) {
  const [view, setView] = useState<"sale" | "closeout">("sale");
  const [catalog, setCatalog] = useState<PublicCatalogProduct[]>([]);
  const [inventory, setInventory] = useState<InventoryContext | null>(null);
  const [locationId, setLocationId] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step>("catalog");
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [checkout, setCheckout] = useState<CheckoutData | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationData | null>(null);
  const [channel, setChannel] = useState<ManualChannel>("MAQUININHA");
  const [proofReference, setProofReference] = useState("");
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"quote" | "checkout" | "confirm" | "cancel" | null>(null);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [accountOpen, setAccountOpen] = useState(false);
  const checkoutKey = useRef(operationKey("pdv-checkout"));
  const confirmationKey = useRef(operationKey("pdv-confirm"));
  const cancellationKey = useRef(operationKey("pdv-cancel"));
  const { showToast } = useToast();

  const refreshData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [products, context] = await Promise.all([loadCatalog(), loadInventoryContext()]);
      setCatalog(products);
      setInventory(context);
      setLocationId((current) => current || context.locations[0]?.id || "");
    } catch (loadError) {
      setError(messageFrom(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refreshData(), 0);
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, [refreshData]);

  const selectedLocation = inventory?.locations.find((location) => location.id === locationId) ?? null;
  const canCloseout = user.roles.includes("VENDEDOR");
  const filteredCatalog = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return normalized ? catalog.filter((product) => [product.name, product.sku, product.category.name]
      .some((value) => value.toLocaleLowerCase("pt-BR").includes(normalized))) : catalog;
  }, [catalog, query]);
  const itemCount = cart.reduce((total, item) => total + item.quantity, 0);
  const previewTotal = cart.reduce((total, item) => total + item.product.price.amountCents * item.quantity, 0);
  const available = (productId: string) => inventory?.availableByLocationAndProduct[`${locationId}:${productId}`] ?? 0;

  function changeQuantity(product: PublicCatalogProduct, delta: number) {
    setCart((current) => {
      const existing = current.find((item) => item.product.id === product.id);
      const next = Math.max(0, Math.min(available(product.id), (existing?.quantity ?? 0) + delta));
      if (next === 0) return current.filter((item) => item.product.id !== product.id);
      return existing
        ? current.map((item) => item.product.id === product.id ? { ...item, quantity: next } : item)
        : [...current, { product, quantity: next }];
    });
    setQuote(null);
    checkoutKey.current = operationKey("pdv-checkout");
  }

  function resetSale() {
    setCart([]); setQuote(null); setCheckout(null); setConfirmation(null); setProofReference("");
    setChannel("MAQUININHA"); setError(""); setStep("catalog");
    checkoutKey.current = operationKey("pdv-checkout");
    confirmationKey.current = operationKey("pdv-confirm");
    cancellationKey.current = operationKey("pdv-cancel");
    void refreshData();
  }

  async function perform(kind: NonNullable<typeof action>, operation: () => Promise<void>) {
    setAction(kind); setError("");
    try { await operation(); }
    catch (operationError) {
      const nextMessage = messageFrom(operationError);
      setError(nextMessage); showToast(nextMessage, "error");
    } finally { setAction(null); }
  }

  const reviewSale = () => perform("quote", async () => {
    if (!online || cart.length === 0) return;
    setQuote(await quoteCart(cart)); setStep("review"); window.scrollTo({ top: 0, behavior: "smooth" });
  });
  const startCheckout = () => perform("checkout", async () => {
    if (!online || !locationId || cart.length === 0) return;
    const result = await checkoutCart(locationId, cart, checkoutKey.current);
    setCheckout(result); setQuote(result.quote); setStep("payment"); window.scrollTo({ top: 0, behavior: "smooth" });
  });
  const confirmPayment = () => perform("confirm", async () => {
    if (!online || !checkout || proofReference.trim().length < 4) return;
    const result = await confirmManualPayment(checkout.saleId, channel, proofReference.trim(), confirmationKey.current);
    setConfirmation(result); setStep("success"); showToast("Venda confirmada e estoque atualizado.", "success");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  const cancelSale = () => perform("cancel", async () => {
    if (!online || !checkout) return;
    await cancelPendingSale(checkout.saleId, cancellationKey.current);
    showToast("Venda pendente cancelada e itens liberados.", "info"); resetSale();
  });
  const logout = async () => {
    await getSupabaseBrowserClient().auth.signOut();
    window.location.assign(user.perfil === "ADMIN" ? `${portalUrl}/login` : "/login");
  };

  if (loading) return <PdvLoading />;
  return (
    <main className="min-h-screen bg-[var(--g-surface-canvas)] text-[var(--g-text-primary)]">
      <header className="sticky top-0 z-40 border-b border-[var(--g-border-subtle)] bg-[var(--g-surface-canvas)]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[var(--g-content-wide)] items-center justify-between gap-3 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="size-10 shrink-0 text-white" title="Germinatura" tone="inverse" />
            <div className="min-w-0"><p className="truncate font-bold">Germinatura PDV</p><p className="truncate text-xs text-[var(--g-text-muted)]">{selectedLocation?.name ?? "Localização indisponível"}</p></div>
          </div>
          <div className="relative">
            <button type="button" onClick={() => setAccountOpen((open) => !open)} aria-expanded={accountOpen} aria-label="Abrir menu da conta" className="flex min-h-11 items-center gap-2 rounded-[var(--g-radius-control)] px-2 text-left hover:bg-[var(--g-surface-hover)] focus-visible:outline-3 focus-visible:outline-[var(--g-focus-ring)]">
              <span className="grid size-9 place-items-center rounded-full bg-[var(--g-surface-selected)] text-sm font-bold">{initials(user.nome)}</span>
              <span className="hidden max-w-36 truncate text-sm font-semibold sm:block">{user.nome}</span><ChevronDown className="size-4 text-[var(--g-text-muted)]" />
            </button>
            {accountOpen && <Card className="absolute right-0 mt-2 w-64 p-2 shadow-[var(--g-shadow-raised)]">
              <div className="border-b border-[var(--g-border-subtle)] px-3 py-3"><p className="truncate text-sm font-semibold">{user.nome}</p><p className="truncate text-xs text-[var(--g-text-muted)]">{user.email}</p></div>
              {user.perfil === "ADMIN" && <button type="button" title="Voltar ao Painel" onClick={() => window.location.assign(portalUrl)} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm hover:bg-[var(--g-surface-hover)]"><Undo2 className="size-4" /> Voltar ao Portal</button>}
              <button type="button" onClick={logout} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm text-[var(--g-status-danger)] hover:bg-[var(--g-surface-hover)]"><LogOut className="size-4" /> Sair do PDV</button>
            </Card>}
          </div>
        </div>
      </header>
      {!online && <div role="status" className="border-b border-[var(--g-status-warning)]/40 bg-[var(--g-status-warning-soft)] px-4 py-3 text-center text-sm font-semibold text-[var(--g-status-warning-foreground)]"><WifiOff className="mr-2 inline size-4" /> Sem internet. O catálogo permanece visível, mas ações de venda estão bloqueadas.</div>}

      {canCloseout && <nav aria-label="Operação do PDV" className="border-b border-[var(--g-border-subtle)] bg-[var(--g-surface-default)]"><div className="mx-auto flex max-w-[var(--g-content-wide)] gap-1 px-4 md:px-6"><button type="button" aria-current={view === "sale" ? "page" : undefined} onClick={() => setView("sale")} className={`min-h-12 border-b-2 px-4 text-sm font-semibold ${view === "sale" ? "border-[var(--g-operation-primary)] text-[var(--g-text-primary)]" : "border-transparent text-[var(--g-text-secondary)] hover:text-[var(--g-text-primary)]"}`}>Operação</button><button type="button" aria-current={view === "closeout" ? "page" : undefined} onClick={() => setView("closeout")} className={`min-h-12 border-b-2 px-4 text-sm font-semibold ${view === "closeout" ? "border-[var(--g-operation-primary)] text-[var(--g-text-primary)]" : "border-transparent text-[var(--g-text-secondary)] hover:text-[var(--g-text-primary)]"}`}>Fechamento</button></div></nav>}

      <div className="mx-auto max-w-[var(--g-content-wide)] px-4 py-6 md:px-6 md:py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div><Badge tone="success"><Check className="size-3.5" /> Acesso autorizado</Badge>
            <h1 className="mt-3 text-2xl font-bold tracking-tight md:text-3xl">{view === "closeout" ? "Fechamento" : { catalog: "Nova venda", review: "Revisar venda", payment: "Confirmar pagamento", success: "Venda concluída" }[step]}</h1>
            <p className="mt-1 text-sm text-[var(--g-text-secondary)]">{view === "closeout" ? "Confira o período, conte o estoque físico e registre divergências." : { catalog: "Selecione os produtos e quantidades para começar.", review: "Confira os valores recalculados pelo servidor antes de cobrar.", payment: "Registre somente depois de confirmar o recebimento fora do sistema.", success: "Pagamento, estoque e financeiro foram registrados juntos." }[step]}</p>
          </div>
          {view === "sale" && step === "review" && <Button variant="ghost" onClick={() => setStep("catalog")} disabled={action !== null}><ArrowLeft className="size-4" /> <span className="hidden sm:inline">Voltar</span></Button>}
        </div>
        {view === "sale" && error && <div role="alert" className="mb-6 flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 bg-[var(--g-surface-default)] p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><div><p className="font-semibold">Não foi possível continuar</p><p className="mt-1 text-[var(--g-text-secondary)]">{error}</p></div></div>}

        {view === "closeout" && inventory ? <CloseoutWorkspace catalog={catalog} inventory={inventory} online={online} />
          : inventory?.locations.length === 0 ? <EmptyState icon={Store} title="Nenhuma localização disponível" description="Peça a um administrador para ativar a localização deste PDV antes de iniciar vendas." onRetry={refreshData} />
          : step === "catalog" ? <CatalogStep catalog={filteredCatalog} cart={cart} query={query} locationId={locationId} locations={inventory?.locations ?? []} online={online} action={action} itemCount={itemCount} previewTotal={previewTotal} available={available} onQuery={setQuery} onLocation={(value) => { setLocationId(value); setCart([]); setQuote(null); }} onQuantity={changeQuantity} onReview={reviewSale} />
          : step === "review" && quote ? <ReviewStep quote={quote} online={online} loading={action === "checkout"} onCheckout={startCheckout} />
          : step === "payment" && checkout && quote ? <PaymentStep checkout={checkout} quote={quote} channel={channel} proofReference={proofReference} online={online} action={action} onChannel={setChannel} onReference={setProofReference} onConfirm={confirmPayment} onCancel={cancelSale} />
          : step === "success" && confirmation && quote ? <SuccessStep confirmation={confirmation} quote={quote} onNewSale={resetSale} /> : null}
      </div>
    </main>
  );
}

function PdvLoading() {
  return <main className="min-h-screen bg-[var(--g-surface-canvas)] p-4 md:p-8"><div className="mx-auto max-w-[var(--g-content-wide)] animate-pulse"><div className="h-16 rounded-[var(--g-radius-card)] bg-[var(--g-surface-default)]" /><div className="mt-8 h-24 max-w-xl rounded-[var(--g-radius-card)] bg-[var(--g-surface-default)]" /><div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><div className="h-48 rounded-[var(--g-radius-card)] bg-[var(--g-surface-default)]" /><div className="h-48 rounded-[var(--g-radius-card)] bg-[var(--g-surface-default)]" /><div className="h-48 rounded-[var(--g-radius-card)] bg-[var(--g-surface-default)]" /></div><span className="sr-only">Carregando operação</span></div></main>;
}

interface CatalogProps {
  catalog: PublicCatalogProduct[]; cart: CartItem[]; query: string; locationId: string;
  locations: InventoryContext["locations"]; online: boolean; action: string | null;
  itemCount: number; previewTotal: number; available: (productId: string) => number;
  onQuery: (value: string) => void; onLocation: (value: string) => void;
  onQuantity: (product: PublicCatalogProduct, delta: number) => void; onReview: () => void;
}

function CatalogStep(props: CatalogProps) {
  return <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <section aria-label="Catálogo">
      <div className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_16rem]">
        <label className="relative block"><span className="sr-only">Buscar produtos</span><Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-[var(--g-text-muted)]" /><Input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="Buscar produto, categoria ou SKU" className="g-input--with-icon" /></label>
        {props.locations.length > 1 && <label><span className="sr-only">Localização da venda</span><select value={props.locationId} onChange={(event) => props.onLocation(event.target.value)} className="min-h-11 w-full rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] bg-[var(--g-surface-default)] px-4 focus-visible:outline-3 focus-visible:outline-[var(--g-focus-ring)]">{props.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>}
      </div>
      {props.catalog.length === 0 ? <EmptyState icon={PackageSearch} title="Nenhum produto encontrado" description="Tente outro termo ou peça a um administrador para conferir o catálogo e o estoque deste local." />
        : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{props.catalog.map((product) => {
          const quantity = props.cart.find((item) => item.product.id === product.id)?.quantity ?? 0;
          const stock = props.available(product.id);
          return <Card key={product.id} className="flex min-h-52 flex-col p-5">
            <div className="flex items-start justify-between gap-3"><div className="grid size-11 place-items-center rounded-xl bg-[var(--g-surface-selected)] text-[var(--g-focus-ring)]"><ShoppingBag className="size-5" /></div><Badge tone={stock > 0 ? "neutral" : "warning"}>{stock > 0 ? `${stock} disponíveis` : "Sem estoque"}</Badge></div>
            <div className="mt-4 flex-1"><p className="text-xs font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">{product.category.name}</p><h3 className="mt-1 font-semibold leading-snug">{product.name}</h3><p className="mt-2 text-xs text-[var(--g-text-muted)]">SKU {product.sku}</p></div>
            <div className="mt-4 flex items-end justify-between gap-3 border-t border-[var(--g-border-subtle)] pt-4"><p className="g-money text-lg font-bold">{formatMoney(product.price.amountCents)}</p><div className="flex items-center rounded-[var(--g-radius-control)] border border-[var(--g-border-default)]"><button type="button" onClick={() => props.onQuantity(product, -1)} disabled={quantity === 0} aria-label={`Remover uma unidade de ${product.name}`} className="grid size-11 place-items-center disabled:opacity-35"><Minus className="size-4" /></button><span aria-label={`${quantity} unidades de ${product.name}`} className="g-money min-w-8 text-center text-sm font-bold">{quantity}</span><button type="button" onClick={() => props.onQuantity(product, 1)} disabled={stock === 0 || quantity >= stock} aria-label={`Adicionar uma unidade de ${product.name}`} className="grid size-11 place-items-center disabled:opacity-35"><Plus className="size-4" /></button></div></div>
          </Card>;
        })}</div>}
    </section>
    <aside className="lg:sticky lg:top-24 lg:self-start"><Card className="overflow-hidden"><div className="border-b border-[var(--g-border-subtle)] p-5"><h2 className="font-semibold">Resumo</h2><p className="mt-1 text-sm text-[var(--g-text-muted)]">{props.itemCount === 0 ? "Carrinho vazio" : `${props.itemCount} ${props.itemCount === 1 ? "item" : "itens"}`}</p></div><div className="space-y-3 p-5">
      {props.cart.length === 0 ? <p className="py-4 text-center text-sm text-[var(--g-text-muted)]">Adicione um produto para iniciar.</p> : props.cart.map((item) => <div key={item.product.id} className="flex justify-between gap-3 text-sm"><span className="min-w-0 truncate text-[var(--g-text-secondary)]">{item.quantity}× {item.product.name}</span><span className="g-money shrink-0 font-semibold">{formatMoney(item.product.price.amountCents * item.quantity)}</span></div>)}
      <div className="flex items-baseline justify-between border-t border-[var(--g-border-subtle)] pt-4"><span className="text-sm text-[var(--g-text-secondary)]">Prévia</span><span className="g-money text-xl font-bold">{formatMoney(props.previewTotal)}</span></div><p className="text-xs leading-5 text-[var(--g-text-muted)]">O servidor recalcula preços e promoções na próxima etapa.</p><Button variant="brand" size="lg" className="w-full" onClick={props.onReview} loading={props.action === "quote"} disabled={!props.online || props.cart.length === 0}>Revisar venda</Button>
    </div></Card></aside>
  </div>;
}

function QuoteSummary({ quote }: { quote: QuoteData }) {
  return <Card className="overflow-hidden"><div className="border-b border-[var(--g-border-subtle)] p-5"><h2 className="font-semibold">Itens da venda</h2><p className="mt-1 text-sm text-[var(--g-text-muted)]">Valores confirmados pelo servidor</p></div><div className="divide-y divide-[var(--g-border-subtle)]">{quote.lines.map((line) => <div key={line.productId} className="flex items-start justify-between gap-4 p-5"><div><p className="font-semibold">{line.name}</p><p className="mt-1 text-sm text-[var(--g-text-muted)]">{line.quantity} × {formatMoney(line.unitPriceCents)}</p>{line.discountCents > 0 && <Badge tone="success" className="mt-2">Economia de {formatMoney(line.discountCents)}</Badge>}</div><p className="g-money shrink-0 font-bold">{formatMoney(line.totalCents)}</p></div>)}</div><div className="space-y-2 bg-[var(--g-surface-subtle)] p-5 text-sm">{quote.discountTotalCents > 0 && <><div className="flex justify-between text-[var(--g-text-secondary)]"><span>Subtotal</span><span className="g-money">{formatMoney(quote.originalTotalCents)}</span></div><div className="flex justify-between text-[var(--g-status-success)]"><span>Descontos</span><span className="g-money">− {formatMoney(quote.discountTotalCents)}</span></div></>}<div className="flex items-baseline justify-between border-t border-[var(--g-border-default)] pt-3"><span className="font-semibold">Total</span><span className="g-money text-2xl font-bold">{formatMoney(quote.totalCents)}</span></div></div></Card>;
}

function ReviewStep({ quote, online, loading, onCheckout }: { quote: QuoteData; online: boolean; loading: boolean; onCheckout: () => void }) {
  return <div className="mx-auto grid max-w-3xl gap-5"><QuoteSummary quote={quote} /><Card className="p-5"><div className="flex items-start gap-3"><Banknote className="mt-0.5 size-5 text-[var(--g-focus-ring)]" /><div><h2 className="font-semibold">Pronto para cobrar?</h2><p className="mt-1 text-sm leading-6 text-[var(--g-text-secondary)]">Ao continuar, o sistema reserva o estoque por tempo limitado. O recebimento ainda precisará ser confirmado manualmente.</p></div></div><Button variant="operation" size="lg" className="mt-5 w-full" onClick={onCheckout} loading={loading} disabled={!online}>Cobrar {formatMoney(quote.totalCents)}</Button></Card></div>;
}

interface PaymentProps { checkout: CheckoutData; quote: QuoteData; channel: ManualChannel; proofReference: string; online: boolean; action: string | null; onChannel: (channel: ManualChannel) => void; onReference: (value: string) => void; onConfirm: () => void; onCancel: () => void }
function PaymentStep(props: PaymentProps) {
  return <div className="mx-auto grid max-w-4xl gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]"><div className="space-y-5"><Card className="p-5">
    <div className="flex items-center justify-between gap-4"><div><Badge tone="warning">Confirmação manual</Badge><h2 className="mt-3 text-xl font-semibold">Como o cliente pagou?</h2></div><p className="g-money text-2xl font-bold">{formatMoney(props.quote.totalCents)}</p></div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2"><ChannelButton icon={CreditCard} selected={props.channel === "MAQUININHA"} title="Maquininha" description="Pagamento presencial" onClick={() => props.onChannel("MAQUININHA")} /><ChannelButton icon={Banknote} selected={props.channel === "PIX_AREA"} title="Área Pix" description="Conferência no app PicPay" onClick={() => props.onChannel("PIX_AREA")} /></div>
    <Field id="proof-reference" label="Referência não sensível do comprovante" description="Use o identificador da operação. Nunca informe número do cartão, CVV, senha ou token." className="mt-5"><Input id="proof-reference" value={props.proofReference} onChange={(event) => props.onReference(event.target.value)} minLength={4} maxLength={128} autoComplete="off" placeholder="Ex.: COMPROVANTE-9F2A" /></Field>
    <div className="mt-5 rounded-[var(--g-radius-control)] border border-[var(--g-status-warning)]/40 bg-[var(--g-surface-subtle)] p-4 text-sm leading-6 text-[var(--g-text-secondary)]"><strong className="text-[var(--g-text-primary)]">Confirme fora do sistema antes de continuar.</strong> Esta tela não consulta automaticamente a Maquininha nem a Área Pix.</div>
    <Button variant="operation" size="lg" className="mt-5 w-full" onClick={props.onConfirm} loading={props.action === "confirm"} disabled={!props.online || props.proofReference.trim().length < 4 || props.action !== null}>Confirmar recebimento manualmente</Button>
  </Card><Button variant="ghost" className="w-full text-[var(--g-status-danger)]" onClick={props.onCancel} loading={props.action === "cancel"} disabled={!props.online || props.action !== null}><X className="size-4" /> Cancelar venda pendente</Button></div><div><QuoteSummary quote={props.quote} /><p className="mt-3 text-xs text-[var(--g-text-muted)]">Reserva válida até {new Date(props.checkout.reservation.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.</p></div></div>;
}

function ChannelButton({ icon: Icon, selected, title, description, onClick }: { icon: typeof CreditCard; selected: boolean; title: string; description: string; onClick: () => void }) {
  return <button type="button" aria-pressed={selected} onClick={onClick} className={`flex min-h-20 items-center gap-3 rounded-[var(--g-radius-card)] border p-4 text-left focus-visible:outline-3 focus-visible:outline-[var(--g-focus-ring)] ${selected ? "border-[var(--g-focus-ring)] bg-[var(--g-surface-selected)]" : "border-[var(--g-border-default)] bg-[var(--g-surface-default)] hover:bg-[var(--g-surface-hover)]"}`}><Icon className={`size-6 ${selected ? "text-[var(--g-focus-ring)]" : "text-[var(--g-text-muted)]"}`} /><span className="flex-1"><strong className="block text-sm">{title}</strong><span className="mt-0.5 block text-xs text-[var(--g-text-muted)]">{description}</span></span>{selected && <CircleCheck className="size-5 text-[var(--g-operation-primary)]" />}</button>;
}

function SuccessStep({ confirmation, quote, onNewSale }: { confirmation: ConfirmationData; quote: QuoteData; onNewSale: () => void }) {
  return <div className="mx-auto max-w-2xl"><Card className="overflow-hidden text-center"><div className="bg-[var(--g-status-success-soft)] p-8 text-[var(--g-status-success-foreground)]"><div className="mx-auto grid size-16 place-items-center rounded-full bg-[var(--g-operation-primary)] text-[var(--g-operation-on-primary)]"><CircleCheck className="size-9" /></div><h2 className="mt-4 text-2xl font-bold">Pagamento confirmado</h2><p className="mt-2 text-sm">Registro manual concluído com segurança.</p></div><div className="p-6 text-left"><div className="flex items-baseline justify-between border-b border-[var(--g-border-subtle)] pb-5"><span className="text-sm text-[var(--g-text-secondary)]">Total recebido</span><strong className="g-money text-2xl">{formatMoney(quote.totalCents)}</strong></div><dl className="grid gap-4 py-5 text-sm sm:grid-cols-2"><div><dt className="text-[var(--g-text-muted)]">Canal</dt><dd className="mt-1 font-semibold">{confirmation.paymentAttempt.integrationChannel === "MAQUININHA" ? "Maquininha" : "Área Pix"}</dd></div><div><dt className="text-[var(--g-text-muted)]">Confirmação</dt><dd className="mt-1 font-semibold">Manual</dd></div><div><dt className="text-[var(--g-text-muted)]">Referência</dt><dd className="mt-1 break-all font-semibold">{confirmation.paymentAttempt.proofReference}</dd></div><div><dt className="text-[var(--g-text-muted)]">Venda</dt><dd className="mt-1 font-mono text-xs">{confirmation.saleId}</dd></div></dl><Button variant="brand" size="lg" className="w-full" onClick={onNewSale}><RotateCcw className="size-4" /> Iniciar nova venda</Button></div></Card></div>;
}

function EmptyState({ icon: Icon, title, description, onRetry }: { icon: typeof Store; title: string; description: string; onRetry?: () => void }) {
  return <Card className="grid min-h-64 place-items-center p-8 text-center"><div><div className="mx-auto grid size-14 place-items-center rounded-full bg-[var(--g-surface-subtle)] text-[var(--g-text-muted)]"><Icon className="size-7" /></div><h2 className="mt-4 font-semibold">{title}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--g-text-secondary)]">{description}</p>{onRetry && <Button variant="secondary" className="mt-5" onClick={onRetry}><Loader2 className="size-4" /> Tentar novamente</Button>}</div></Card>;
}
