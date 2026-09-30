"use client";

import { paymentLinkChargeResponseSchema, raffleNumberReservationResponseSchema } from "@germinatura/contracts";
import { Badge, Button, Card } from "@germinatura/ui";
import { CalendarClock, CircleAlert, CreditCard, Hash, Loader2, Ticket, Trophy, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface ConsumerRaffle {
  id: string;
  name: string;
  description: string | null;
  productName: string;
  numberCount: number;
  unitPriceCents: number | null;
  availableCount: number;
  status: "ACTIVE" | "PAUSED" | "CLOSED" | "DRAWN" | "CANCELLED";
  startsAt: string;
  endsAt: string;
  draw: { winnerNumber: number; auditHash: string; createdAt: string } | null;
}

export interface RaffleTicket {
  saleId: string;
  campaignId: string;
  campaignName: string;
  numbers: number[];
  saleStatus: "DRAFT" | "AWAITING_PAYMENT" | "CONFIRMED" | "CANCELLED";
  /** RAF-005: the paid purchase was refunded and its numbers left the draw. */
  refunded?: boolean;
  totalCents: number;
  expiresAt: string | null;
  openPaymentLinkId: string | null;
  confirmationSource: string | null;
  won: boolean;
}

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const time = new Intl.DateTimeFormat("pt-BR", { timeStyle: "short", timeZone: "America/Sao_Paulo" });
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const statusPresentation = {
  ACTIVE: { label: "Ativa", tone: "success" as const },
  PAUSED: { label: "Pausada", tone: "warning" as const },
  CLOSED: { label: "Encerrada", tone: "warning" as const },
  DRAWN: { label: "Sorteada", tone: "info" as const },
  CANCELLED: { label: "Cancelada", tone: "danger" as const },
};
const maxSelection = 100;

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/** Spec 4.4 (RAF-003): choose numbers, reserve, pay online and follow "Meus bilhetes". */
export function ConsumerRaffles({ raffles, tickets: initialTickets, enabled, onlinePayment, unavailable }: {
  raffles: ConsumerRaffle[]; tickets: RaffleTicket[]; enabled: boolean; onlinePayment: boolean; unavailable: boolean;
}) {
  const [tickets, setTickets] = useState(initialTickets);
  const [error, setError] = useState("");
  const [busySale, setBusySale] = useState<string | null>(null);
  const payKeys = useRef(new Map<string, string>());

  async function payOnline(saleId: string) {
    setBusySale(saleId); setError("");
    const key = payKeys.current.get(saleId) ?? `raffle-payment-link:${crypto.randomUUID()}`;
    payKeys.current.set(saleId, key);
    try {
      const response = await fetch(`/api/v1/raffles/sales/${saleId}/payment-link`, { method: "POST", headers: { "Idempotency-Key": key } });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível iniciar o pagamento online."));
      const parsed = paymentLinkChargeResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("O pagamento online retornou dados inválidos.");
      window.location.assign(`/pedidos/pagamento/${parsed.data.data.chargeId}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível iniciar o pagamento online."); setBusySale(null); }
  }

  async function cancelReservation(saleId: string) {
    setBusySale(saleId); setError("");
    try {
      const response = await fetch(`/api/v1/raffles/sales/${saleId}/cancel`, { method: "POST", headers: { "Idempotency-Key": `raffle-cancel:${saleId}` } });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível cancelar a reserva."));
      setTickets((current) => current.map((ticket) => ticket.saleId === saleId ? { ...ticket, saleStatus: "CANCELLED", openPaymentLinkId: null } : ticket));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível cancelar a reserva."); }
    finally { setBusySale(null); }
  }

  const reserved = useCallback((ticket: RaffleTicket) => setTickets((current) => [ticket, ...current]), []);
  const open = raffles.filter((raffle) => raffle.status === "ACTIVE");

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
        <header>
          <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Rifas</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Campanhas e meus números</h1>
          <p className="mt-2 max-w-2xl text-base leading-6 text-[var(--g-text-secondary)]">Escolha números disponíveis, reserve e pague online. Somente números pagos participam do sorteio.</p>
        </header>

        {!enabled && <div role="status" className="flex items-start gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-warning-soft)] p-4 text-sm text-[var(--g-status-warning-foreground)]"><CircleAlert className="mt-0.5 size-5 shrink-0" /><span>As rifas estão temporariamente indisponíveis.</span></div>}
        {unavailable && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]"><CircleAlert className="mt-0.5 size-5 shrink-0" /><span>Não foi possível consultar as rifas. Atualize a página antes de tomar uma decisão.</span></div>}
        {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]"><CircleAlert className="mt-0.5 size-5 shrink-0" /><span>{error}</span></div>}
        {enabled && !unavailable && !onlinePayment && open.length > 0 && <p role="status" className="rounded-[var(--g-radius-control)] border border-[var(--g-border-subtle)] bg-[var(--g-surface-default)] p-4 text-sm leading-6 text-[var(--g-text-secondary)]">A compra online de números ainda não está disponível. Compre seus números com um vendedor da comissão.</p>}

        {!unavailable && raffles.length === 0 ? (
          <Card className="p-10 text-center"><Ticket className="mx-auto size-11 text-[var(--g-text-muted)]" /><h2 className="mt-4 text-lg font-semibold">Nenhuma campanha disponível</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--g-text-secondary)]">Quando uma rifa for publicada, ela aparecerá aqui.</p></Card>
        ) : !unavailable && (
          <section className="grid gap-4" aria-label="Campanhas de rifa">
            {raffles.map((raffle) => <RaffleCard key={raffle.id} raffle={raffle} canBuy={enabled && onlinePayment && raffle.status === "ACTIVE"}
              won={tickets.some((ticket) => ticket.campaignId === raffle.id && ticket.won)} onReserved={reserved} />)}
          </section>
        )}

        {!unavailable && <section aria-label="Meus bilhetes" className="space-y-3">
          <h2 className="text-xl font-semibold">Meus bilhetes</h2>
          {tickets.length === 0 ? <p className="text-sm text-[var(--g-text-secondary)]">Você ainda não tem números.</p>
            : <ul className="grid gap-3">{tickets.map((ticket) => <li key={ticket.saleId} aria-label={`Bilhetes de ${ticket.campaignName}`}><Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><p className="font-semibold">{ticket.campaignName}</p>
                  {ticket.saleStatus === "CONFIRMED" && <Badge tone="success">Pago</Badge>}
                  {ticket.saleStatus === "AWAITING_PAYMENT" && <Badge tone="warning">Aguardando pagamento{ticket.expiresAt ? ` até ${time.format(new Date(ticket.expiresAt))}` : ""}</Badge>}
                  {ticket.saleStatus === "CANCELLED" && <Badge tone="neutral">{ticket.refunded ? "Estornado" : "Cancelado ou expirado"}</Badge>}
                  {ticket.won && <Badge tone="success">Premiado</Badge>}
                </div>
                <p className="mt-1 text-sm">Números: <span className="g-money font-semibold">{ticket.numbers.join(", ")}</span> · {money.format(ticket.totalCents / 100)}</p>
                {ticket.saleStatus === "CONFIRMED" && ticket.confirmationSource && <p className="text-xs text-[var(--g-text-muted)]">{ticket.confirmationSource === "MANUAL" ? "Pagamento registrado pela comissão" : "Pagamento confirmado pelo PicPay"}</p>}
              </div>
              {ticket.saleStatus === "AWAITING_PAYMENT" && <div className="flex flex-wrap gap-2">
                {ticket.openPaymentLinkId ? <a href={`/pedidos/pagamento/${ticket.openPaymentLinkId}`} className="g-button g-button--brand g-button--sm inline-flex items-center gap-2"><CreditCard className="size-4" /> Continuar pagamento</a>
                  : onlinePayment && <Button size="sm" variant="brand" loading={busySale === ticket.saleId} disabled={busySale !== null} onClick={() => void payOnline(ticket.saleId)}><CreditCard className="size-4" /> Pagar online</Button>}
                <Button size="sm" variant="ghost" disabled={busySale !== null} onClick={() => void cancelReservation(ticket.saleId)}><X className="size-4" /> Cancelar reserva</Button>
              </div>}
            </Card></li>)}</ul>}
        </section>}
      </div>
    </div>
  );
}

function RaffleCard({ raffle, canBuy, won, onReserved }: { raffle: ConsumerRaffle; canBuy: boolean; won: boolean; onReserved: (ticket: RaffleTicket) => void }) {
  const presentation = statusPresentation[raffle.status];
  const [board, setBoard] = useState<Array<{ number: number; state: "AVAILABLE" | "TAKEN" | "MINE" }> | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef("");

  const loadBoard = useCallback(async () => {
    const response = await fetch(`/api/v1/raffles/${raffle.id}/numbers`, { cache: "no-store" });
    if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar os números."));
    const body = await response.json() as { data: Array<{ number: number; state: "AVAILABLE" | "TAKEN" | "MINE" }> };
    setBoard(body.data);
  }, [raffle.id]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => { loadBoard().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Não foi possível carregar os números.")); }, 0);
    return () => window.clearTimeout(timer);
  }, [open, loadBoard]);

  function toggle(number: number) {
    setSelected((current) => current.includes(number) ? current.filter((item) => item !== number)
      : current.length >= maxSelection ? current : [...current, number].sort((a, b) => a - b));
    key.current = "";
  }

  async function reserve() {
    setBusy(true); setError("");
    // The same selection retried keeps its key, so a double click reserves once.
    key.current ||= `raffle-reserve:${crypto.randomUUID()}`;
    try {
      const response = await fetch(`/api/v1/raffles/${raffle.id}/numbers/reserve`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current }, body: JSON.stringify({ numbers: selected }),
      });
      if (!response.ok) {
        const message = await messageFrom(response, "Não foi possível reservar os números.");
        await loadBoard().catch(() => undefined);
        throw new Error(response.status === 409 ? `${message}. O quadro foi atualizado; escolha outros números.` : message);
      }
      const parsed = raffleNumberReservationResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A reserva retornou dados inválidos.");
      const value = parsed.data.data;
      onReserved({ saleId: value.saleId, campaignId: raffle.id, campaignName: raffle.name, numbers: value.numbers, saleStatus: "AWAITING_PAYMENT",
        totalCents: value.totalCents, expiresAt: value.expiresAt, openPaymentLinkId: null, confirmationSource: null, won: false });
      setSelected([]); key.current = "";
      await loadBoard().catch(() => undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível reservar os números."); }
    finally { setBusy(false); }
  }

  return <Card className="overflow-hidden"><div className="p-5 sm:p-6">
    <div className="flex flex-wrap items-center gap-2"><Badge tone={presentation.tone}>{presentation.label}</Badge>{won && <Badge tone="success">Você ganhou</Badge>}</div>
    <h2 className="mt-3 text-xl font-bold">{raffle.name}</h2>
    <p className="mt-1 text-sm text-[var(--g-text-secondary)]">{raffle.productName}{raffle.unitPriceCents !== null ? ` · ${money.format(raffle.unitPriceCents / 100)} por número` : ""}</p>
    {raffle.description && <p className="mt-2 text-sm">{raffle.description}</p>}
    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
      <div className="flex items-start gap-2"><Hash className="mt-0.5 size-4 shrink-0 text-[var(--g-brand-primary)]" /><div><dt className="text-[var(--g-text-muted)]">Numeração</dt><dd className="mt-0.5 font-semibold">1 a {raffle.numberCount}</dd></div></div>
      <div className="flex items-start gap-2"><Ticket className="mt-0.5 size-4 shrink-0 text-[var(--g-brand-primary)]" /><div><dt className="text-[var(--g-text-muted)]">Disponíveis</dt><dd className="mt-0.5 font-semibold">{raffle.availableCount}</dd></div></div>
      <div className="flex items-start gap-2"><CalendarClock className="mt-0.5 size-4 shrink-0 text-[var(--g-brand-primary)]" /><div><dt className="text-[var(--g-text-muted)]">Período</dt><dd className="mt-0.5 font-semibold">{dateTime.format(new Date(raffle.startsAt))} até {dateTime.format(new Date(raffle.endsAt))}</dd></div></div>
    </dl>
    {canBuy && <Button className="mt-4" variant="secondary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "Fechar números" : "Escolher números"}</Button>}
    {open && <div className="mt-4 space-y-3">
      {!board && !error && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Carregando números…</p>}
      {board && <div role="group" aria-label={`Números de ${raffle.name}`} className="grid max-h-80 grid-cols-6 gap-2 overflow-y-auto sm:grid-cols-10">
        {board.map((item) => {
          const chosen = selected.includes(item.number);
          return <button key={item.number} type="button" disabled={item.state !== "AVAILABLE"} aria-pressed={chosen}
            aria-label={`Número ${item.number}${item.state === "TAKEN" ? " indisponível" : item.state === "MINE" ? " seu" : ""}`}
            onClick={() => toggle(item.number)}
            className={`g-money min-h-10 rounded-[var(--g-radius-control)] border text-sm font-semibold ${chosen ? "border-[var(--g-focus-ring)] bg-[var(--g-surface-selected)]" : item.state === "MINE" ? "border-[var(--g-status-success)] bg-[var(--g-status-success-soft)]" : item.state === "TAKEN" ? "border-transparent bg-[var(--g-surface-subtle)] text-[var(--g-text-muted)] line-through" : "border-[var(--g-border-default)] bg-[var(--g-surface-default)] hover:bg-[var(--g-surface-hover)]"}`}>{item.number}</button>;
        })}
      </div>}
      {selected.length > 0 && <p className="text-sm">Selecionados: <strong className="g-money">{selected.join(", ")}</strong>{raffle.unitPriceCents !== null ? ` · prévia ${money.format((raffle.unitPriceCents * selected.length) / 100)} (o servidor confirma o total)` : ""}</p>}
      {error && <p role="alert" className="text-sm text-[var(--g-status-danger)]">{error}</p>}
      <Button variant="brand" loading={busy} disabled={busy || selected.length === 0} onClick={() => void reserve()}>Reservar números</Button>
      <p className="text-xs text-[var(--g-text-muted)]">A reserva segura os números por 10 minutos; ao pagar online, por 30 minutos.</p>
    </div>}
  </div>
  {raffle.draw && <div className="border-t border-[var(--g-border-subtle)] bg-[var(--g-brand-primary-soft)] px-5 py-4 sm:px-6"><div className="flex items-center gap-3"><Trophy className="size-5 text-[var(--g-brand-primary)]" /><p className="font-semibold">Número sorteado: {raffle.draw.winnerNumber}</p></div><p className="mt-1 break-all text-xs text-[var(--g-text-muted)]">Sorteio auditável em {dateTime.format(new Date(raffle.draw.createdAt))} · hash {raffle.draw.auditHash}</p></div>}
  </Card>;
}
