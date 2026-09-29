"use client";

import {
  commercialReservationCreateResponseSchema, pricingQuoteResponseSchema,
  type PricingQuoteResponse, type PublicCatalogProduct,
} from "@germinatura/contracts";
import { Button, Card, Field, Input } from "@germinatura/ui";
import { CalendarClock, Minus, Plus, ShoppingBag, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
export interface CartLine { product: PublicCatalogProduct; quantity: number }
type Quote = PricingQuoteResponse["data"];

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/** RES-004: the Portal cart previews server pricing and turns the cart into a reservation at the frozen price. */
export function ReservationCart({ lines, onQuantity, onClear }: { lines: CartLine[]; onQuantity: (productId: string, quantity: number) => void; onClear: () => void }) {
  const [coupon, setCoupon] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState("");
  const [reserving, setReserving] = useState(false);
  const [created, setCreated] = useState<{ expiresAt: string; totalCents: number } | null>(null);
  const keys = useRef(new Map<string, string>());
  const items = lines.map((line) => ({ productId: line.product.id, quantity: line.quantity }));
  const fingerprint = JSON.stringify({ items, couponCode: appliedCoupon || undefined });

  useEffect(() => {
    const payload = JSON.parse(fingerprint) as { items: Array<{ productId: string; quantity: number }>; couponCode?: string };
    if (payload.items.length === 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setQuoting(true);
      void fetch("/api/v1/pricing/quote", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ channel: "PORTAL", ...payload }),
      }).then(async (response) => {
        if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível calcular o total."));
        const parsed = pricingQuoteResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("O cálculo retornou dados inválidos.");
        setQuote(parsed.data.data); setError("");
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) { setQuote(null); setError(cause instanceof Error ? cause.message : "Não foi possível calcular o total."); }
      }).finally(() => { if (!controller.signal.aborted) setQuoting(false); });
    }, 350);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [fingerprint]);

  async function reserve() {
    if (items.length === 0 || reserving) return;
    const key = keys.current.get(fingerprint) ?? `portal-reservation:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    setReserving(true); setError("");
    try {
      const response = await fetch("/api/v1/reservations", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ items, ...(appliedCoupon ? { couponCode: appliedCoupon } : {}) }),
      });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível reservar."));
      const parsed = commercialReservationCreateResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A reserva retornou dados inválidos.");
      setCreated({ expiresAt: parsed.data.data.stockReservation.expiresAt, totalCents: parsed.data.data.quote.totalCents });
      setCoupon(""); setAppliedCoupon(""); setQuote(null);
      onClear();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível reservar."); }
    finally { setReserving(false); }
  }

  if (created && lines.length === 0) {
    return <Card className="p-5" aria-label="Reserva criada"><h2 className="text-lg font-semibold">Reserva criada</h2>
      <p className="mt-2 text-sm">Total congelado de <strong className="g-money">{money.format(created.totalCents / 100)}</strong>.</p>
      <p className="mt-1 flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><CalendarClock className="size-4" />Válida até {dateTime.format(new Date(created.expiresAt))}. A comissão avisa quando estiver pronta para retirada.</p>
      <Link href="/reservas" className="mt-4 inline-flex min-h-11 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary)] px-5 text-sm font-semibold text-white">Ver minhas reservas</Link></Card>;
  }
  if (lines.length === 0) {
    return <Card className="p-5 text-sm text-[var(--g-text-secondary)]" aria-label="Carrinho de reserva"><div className="flex items-center gap-2 font-semibold text-[var(--g-text-primary)]"><ShoppingBag className="size-4" />Carrinho de reserva</div><p className="mt-2">Adicione produtos reserváveis para ver o total com as promoções.</p></Card>;
  }
  return <Card className="p-5" aria-label="Carrinho de reserva">
    <h2 className="flex items-center gap-2 font-semibold"><ShoppingBag className="size-4" />Carrinho de reserva</h2>
    <ul className="mt-3 divide-y divide-[var(--g-border-subtle)]" aria-label="Itens do carrinho">{lines.map((line) => {
      const quoted = quote?.lines.find((item) => item.productId === line.product.id);
      return <li key={line.product.id} className="py-3" aria-label={`Item ${line.product.name}`}>
        <div className="flex items-start justify-between gap-2"><p className="text-sm font-semibold">{line.product.name}</p><p className="g-money text-sm font-semibold">{money.format((quoted?.totalCents ?? line.product.price.amountCents * line.quantity) / 100)}</p></div>
        <div className="mt-2 flex items-center gap-2">
          <Button type="button" size="sm" variant="secondary" aria-label={`Diminuir ${line.product.name}`} onClick={() => onQuantity(line.product.id, line.quantity - 1)}><Minus className="size-4" /></Button>
          <span className="min-w-8 text-center text-sm font-semibold" aria-label={`Quantidade de ${line.product.name}`}>{line.quantity}</span>
          <Button type="button" size="sm" variant="secondary" aria-label={`Aumentar ${line.product.name}`} disabled={line.quantity >= 99} onClick={() => onQuantity(line.product.id, line.quantity + 1)}><Plus className="size-4" /></Button>
          <Button type="button" size="sm" variant="ghost" aria-label={`Remover ${line.product.name}`} onClick={() => onQuantity(line.product.id, 0)}><Trash2 className="size-4" /></Button>
        </div>
        {quoted && quoted.discountCents > 0 && <p className="mt-1 text-xs text-[var(--g-status-success-foreground)]">Promoção: − {money.format(quoted.discountCents / 100)}</p>}
      </li>;
    })}</ul>
    <form className="mt-3 flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); setAppliedCoupon(coupon.trim().toUpperCase()); }}>
      <Field id="cart-coupon" label="Cupom (opcional)" className="flex-1"><Input id="cart-coupon" maxLength={40} value={coupon} onChange={(event) => setCoupon(event.target.value)} /></Field>
      <Button type="submit" variant="secondary">Aplicar</Button>
    </form>
    {quote?.coupon && <p role="status" className="mt-2 text-sm">{quote.coupon.applied ? `Cupom ${quote.coupon.code} aplicado.` : `O cupom ${quote.coupon.code} não se aplica a este carrinho.`}</p>}
    <dl className="mt-4 space-y-1 border-t border-[var(--g-border-subtle)] pt-4 text-sm" aria-live="polite">
      {quote && quote.discountTotalCents > 0 && <div className="flex justify-between"><dt>Economia</dt><dd className="g-money text-[var(--g-status-success-foreground)]">− {money.format(quote.discountTotalCents / 100)}</dd></div>}
      <div className="flex justify-between text-base font-bold"><dt>Total</dt><dd className="g-money">{quote ? money.format(quote.totalCents / 100) : quoting ? "Calculando…" : "—"}</dd></div>
    </dl>
    {error && <p role="alert" className="mt-2 text-sm text-[var(--g-status-danger)]">{error}</p>}
    <Button type="button" className="mt-4 w-full" loading={reserving} disabled={reserving || quoting || !quote} onClick={() => void reserve()}>Reservar</Button>
    <p className="mt-2 text-xs text-[var(--g-text-muted)]">O preço fica congelado na reserva. A retirada e o pagamento acontecem com a comissão.</p>
  </Card>;
}
