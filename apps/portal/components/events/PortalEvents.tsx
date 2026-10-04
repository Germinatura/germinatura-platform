"use client";

import { portalEventResponseSchema, portalEventsResponseSchema, type PortalEvent } from "@germinatura/contracts";
import { Badge, Button, Card } from "@germinatura/ui";
import { AlertTriangle, CalendarDays, Copy, ExternalLink, Loader2, MapPin, QrCode } from "lucide-react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { useToast } from "@/components/ui/Toast";

const dateTime = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const time = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });

/** "sáb., 10 de out., 19:00 – 23:00", with the end date only when it is another day. */
export function eventWhen(event: Pick<PortalEvent, "startsAt" | "endsAt">) {
  const start = new Date(event.startsAt);
  if (!event.endsAt) return dateTime.format(start);
  const end = new Date(event.endsAt);
  return `${dateTime.format(start)} – ${day.format(start) === day.format(end) ? time.format(end) : dateTime.format(end)}`;
}

export function eventBadge(event: PortalEvent) {
  if (event.status === "CANCELADO") return <Badge tone="danger">Cancelado</Badge>;
  if (event.status === "RASCUNHO") return <Badge tone="neutral">Rascunho</Badge>;
  if (event.over) return <Badge tone="neutral">Encerrado</Badge>;
  return <Badge tone="success">{event.kind === "CAMPANHA" ? "Campanha" : "Evento"}</Badge>;
}

function EventShare({ event }: { event: PortalEvent }) {
  const { showToast } = useToast();
  const [showQr, setShowQr] = useState(false);
  const link = typeof window === "undefined" ? `/eventos/${event.id}` : `${window.location.origin}/eventos/${event.id}`;
  async function copy() {
    try { await navigator.clipboard.writeText(`${event.title} — ${eventWhen(event)}${event.location ? ` · ${event.location}` : ""}\n${link}`); showToast("Convite copiado.", "success"); }
    catch { showToast("Não foi possível copiar.", "error"); }
  }
  return <div className="grid gap-3">
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}><Copy className="size-4" />Copiar convite</Button>
      <Button type="button" size="sm" variant="ghost" aria-expanded={showQr} onClick={() => setShowQr(!showQr)}><QrCode className="size-4" />QR Code</Button>
    </div>
    {showQr && <div className="justify-self-start rounded-[var(--g-radius-control)] bg-white p-3"><QRCodeSVG value={link} size={144} aria-label={`QR Code de ${event.title}`} /></div>}
  </div>;
}

export function EventDetails({ event, compact = false }: { event: PortalEvent; compact?: boolean }) {
  return <Card className="overflow-hidden">
    {event.coverUrl && !compact && <div role="img" aria-label={event.coverAlt ?? event.title} className="aspect-[3/1] w-full bg-cover bg-center" style={{ backgroundImage: `url(${JSON.stringify(event.coverUrl)})` }} />}
    <div className="grid gap-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-xl font-bold">{compact ? <Link href={`/eventos/${event.id}`} className="hover:underline">{event.title}</Link> : event.title}</h2>
        {eventBadge(event)}
      </div>
      <p className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><CalendarDays aria-hidden className="size-4 shrink-0" />{eventWhen(event)}</p>
      {event.location && <p className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><MapPin aria-hidden className="size-4 shrink-0" />{event.location}</p>}
      {event.status === "CANCELADO" && event.cancelReason && <p className="text-sm text-[var(--g-status-danger)]">Cancelado: {event.cancelReason}</p>}
      <p className={compact ? "line-clamp-3 text-sm" : "whitespace-pre-line text-sm leading-6"}>{event.description}</p>
      {!compact && event.products.length > 0 && <div><h3 className="text-sm font-semibold">Produtos</h3><ul className="mt-1 flex flex-wrap gap-2">{event.products.map((product) => <li key={product.id}><Link href="/catalogo" className="text-sm font-medium text-[var(--g-brand-primary)] hover:underline">{product.name}</Link></li>)}</ul></div>}
      {!compact && event.promotions.length > 0 && <div><h3 className="text-sm font-semibold">Promoções</h3><ul className="mt-1 grid gap-1 text-sm">{event.promotions.map((promotion) => <li key={promotion.id}>{promotion.name}{promotion.validTo ? ` · até ${dateTime.format(new Date(promotion.validTo))}` : ""}</li>)}</ul></div>}
      {!compact && event.sellers.length > 0 && <div><h3 className="text-sm font-semibold">Vendedores participantes</h3><p className="mt-1 text-sm">{event.sellers.map((seller) => seller.name).join(", ")}</p></div>}
      {event.status !== "CANCELADO" && !event.over && <div className="flex flex-wrap gap-2">
        {event.ctaLabel && event.ctaUrl && (event.ctaUrl.startsWith("/")
          ? <Link href={event.ctaUrl} className="g-button g-button--brand inline-flex min-h-11 items-center gap-2 px-4 text-sm font-semibold">{event.ctaLabel}</Link>
          : <a href={event.ctaUrl} target="_blank" rel="noopener noreferrer" className="g-button g-button--brand inline-flex min-h-11 items-center gap-2 px-4 text-sm font-semibold">{event.ctaLabel}<ExternalLink aria-hidden className="size-4" /></a>)}
        {event.externalUrl && <a href={event.externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--g-brand-primary)]">Mais informações<ExternalLink aria-hidden className="size-4" /></a>}
      </div>}
      {!compact && event.status === "PUBLICADO" && !event.over && <EventShare event={event} />}
    </div>
  </Card>;
}

/** Spec 4.5: upcoming events and campaigns, and the archive of past ones. */
export function PortalEventsBoard() {
  const [archive, setArchive] = useState(false);
  const [events, setEvents] = useState<PortalEvent[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      setEvents(null); setError("");
      try {
        const response = await fetch(`/api/v1/events?archive=${archive}`, { cache: "no-store" });
        const parsed = portalEventsResponseSchema.safeParse(await response.json().catch(() => null));
        if (!response.ok || !parsed.success) throw new Error("Não foi possível carregar os eventos.");
        if (active) setEvents(parsed.data.data);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Não foi possível carregar os eventos."); }
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [archive]);
  return <div className="grid gap-5">
    <div role="tablist" aria-label="Período" className="flex gap-2">
      <Button type="button" role="tab" aria-selected={!archive} size="sm" variant={archive ? "ghost" : "secondary"} onClick={() => setArchive(false)}>Próximos</Button>
      <Button type="button" role="tab" aria-selected={archive} size="sm" variant={archive ? "secondary" : "ghost"} onClick={() => setArchive(true)}>Arquivo</Button>
    </div>
    {error && <p role="alert" className="flex items-center gap-2 text-sm text-[var(--g-status-danger)]"><AlertTriangle className="size-4" />{error}</p>}
    {!events && !error && <p role="status" className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando eventos…</p>}
    {events && events.length === 0 && <p className="text-sm text-[var(--g-text-secondary)]">{archive ? "Nenhum evento encerrado." : "Nenhum evento ou campanha marcado por enquanto."}</p>}
    {events && events.length > 0 && <ul aria-label={archive ? "Eventos encerrados" : "Próximos eventos"} className="grid gap-4 md:grid-cols-2">
      {events.map((event) => <li key={event.id} aria-label={event.title}><EventDetails event={event} compact /></li>)}
    </ul>}
  </div>;
}

export function PortalEventPage({ eventId }: { eventId: string }) {
  const [event, setEvent] = useState<PortalEvent | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/v1/events/${eventId}`, { cache: "no-store" });
        const parsed = portalEventResponseSchema.safeParse(await response.json().catch(() => null));
        if (!response.ok || !parsed.success) throw new Error(response.status === 404 ? "Evento não encontrado." : "Não foi possível carregar o evento.");
        if (active) setEvent(parsed.data.data);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Não foi possível carregar o evento."); }
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [eventId]);
  if (error) return <p role="alert" className="text-sm text-[var(--g-status-danger)]">{error}</p>;
  if (!event) return <p role="status" className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando evento…</p>;
  return <EventDetails event={event} />;
}
