"use client";

import { commercialReservationCancelResponseSchema } from "@germinatura/contracts";
import { Badge, Button, Card } from "@germinatura/ui";
import { CalendarClock, CircleAlert, PackageCheck, ShoppingBag, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export interface ConsumerReservation {
  id: string;
  status: "ACTIVE" | "CONVERTED" | "CANCELLED" | "EXPIRED";
  lines: Array<{ productId: string; name: string; quantity: number; totalCents: number }>;
  originalTotalCents: number;
  discountTotalCents: number;
  totalCents: number;
  expiresAt: string;
  createdAt: string;
}

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const statusPresentation = {
  ACTIVE: { label: "Ativa", tone: "info" as const },
  CONVERTED: { label: "Convertida", tone: "success" as const },
  CANCELLED: { label: "Cancelada", tone: "danger" as const },
  EXPIRED: { label: "Expirada", tone: "warning" as const },
};

export function ConsumerReservations({ initialReservations, unavailable }: { initialReservations: ConsumerReservation[]; unavailable: boolean }) {
  const [reservations, setReservations] = useState(initialReservations);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function cancelReservation(id: string) {
    setBusyId(id);
    setError("");
    try {
      const response = await fetch(`/api/v1/reservations/${id}/cancel`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error("Não foi possível cancelar a reserva. Atualize a página para conferir o estado e tente novamente.");
      const parsed = commercialReservationCancelResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("O cancelamento foi processado com uma resposta inesperada. Atualize a página antes de tentar outra ação.");
      setReservations((current) => current.map((reservation) => reservation.id === id
        ? { ...reservation, status: parsed.data.data.status }
        : reservation));
      setConfirmingId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível cancelar a reserva.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
        <header>
          <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Reservas</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Minhas reservas</h1>
          <p className="mt-2 max-w-2xl text-base leading-6 text-[var(--g-text-secondary)]">Acompanhe produtos separados temporariamente para você. Reservas ativas expiram automaticamente no horário informado.</p>
        </header>

        {unavailable && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]"><CircleAlert className="mt-0.5 size-5 shrink-0" /><span>Não foi possível consultar suas reservas. Atualize a página antes de tomar uma decisão.</span></div>}
        {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]"><CircleAlert className="mt-0.5 size-5 shrink-0" /><span>{error}</span></div>}

        {!unavailable && reservations.length === 0 ? (
          <Card className="p-10 text-center">
            <CalendarClock className="mx-auto size-11 text-[var(--g-text-muted)]" />
            <h2 className="mt-4 text-lg font-semibold">Você ainda não tem reservas</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--g-text-secondary)]">Explore o catálogo para conhecer os produtos disponíveis. A opção de reservar aparecerá quando a jornada estiver disponível.</p>
            <Link href="/catalogo" className="mt-5 inline-flex min-h-11 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary)] px-5 text-sm font-semibold text-white">Ver catálogo</Link>
          </Card>
        ) : !unavailable && (
          <section className="grid gap-4" aria-label="Reservas do consumidor">
            {reservations.map((reservation) => {
              const presentation = statusPresentation[reservation.status];
              const active = reservation.status === "ACTIVE";
              return <Card key={reservation.id} className="p-5 sm:p-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><Badge tone={presentation.tone}>{presentation.label}</Badge><span className="text-xs text-[var(--g-text-muted)]">Criada em {dateTime.format(new Date(reservation.createdAt))}</span></div>
                    <div className="mt-5 space-y-3">{reservation.lines.map((line) => <div key={line.productId} className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]"><ShoppingBag className="size-5" /></span><div className="min-w-0 flex-1"><p className="font-semibold">{line.name}</p><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{line.quantity} {line.quantity === 1 ? "unidade" : "unidades"}</p></div><p className="g-money shrink-0 font-semibold">{money.format(line.totalCents / 100)}</p></div>)}</div>
                  </div>
                  <div className="w-full rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-4 lg:w-72">
                    <div className="flex items-end justify-between gap-3"><span className="text-sm text-[var(--g-text-secondary)]">Total reservado</span><strong className="g-money text-xl">{money.format(reservation.totalCents / 100)}</strong></div>
                    {reservation.discountTotalCents > 0 && <p className="mt-1 text-right text-xs text-[var(--g-status-success-foreground)]">Economia de {money.format(reservation.discountTotalCents / 100)}</p>}
                    {active && <div className="mt-4 flex items-start gap-2 border-t border-[var(--g-border-subtle)] pt-4 text-sm"><CalendarClock className="mt-0.5 size-4 shrink-0 text-[var(--g-brand-primary)]" /><span>Válida até <strong>{dateTime.format(new Date(reservation.expiresAt))}</strong></span></div>}
                    {active && confirmingId !== reservation.id && <Button variant="danger" className="mt-4 w-full" onClick={() => setConfirmingId(reservation.id)}><XCircle className="size-4" /> Cancelar reserva</Button>}
                    {active && confirmingId === reservation.id && <div className="mt-4 border-t border-[var(--g-border-subtle)] pt-4"><p className="text-sm font-semibold">Liberar estes produtos?</p><p className="mt-1 text-xs leading-5 text-[var(--g-text-secondary)]">Esta ação não pode ser desfeita.</p><div className="mt-3 grid grid-cols-2 gap-2"><Button variant="secondary" size="sm" disabled={busyId === reservation.id} onClick={() => setConfirmingId(null)}>Voltar</Button><Button variant="danger" size="sm" loading={busyId === reservation.id} onClick={() => void cancelReservation(reservation.id)}>Confirmar</Button></div></div>}
                    {reservation.status === "CONVERTED" && <p className="mt-4 flex items-start gap-2 text-sm text-[var(--g-status-success-foreground)]"><PackageCheck className="mt-0.5 size-4 shrink-0" /> Reserva convertida em cobrança.</p>}
                  </div>
                </div>
              </Card>;
            })}
          </section>
        )}
      </div>
    </div>
  );
}
