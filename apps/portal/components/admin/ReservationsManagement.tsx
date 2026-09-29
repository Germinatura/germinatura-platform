"use client";

import {
  adminReservationsResponseSchema, markReservationReadyRequestSchema, reservationSettingsResponseSchema, reservationSettingsSchema,
  type AdminReservation, type CommercialReservationStatus,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Loader2, PackageCheck, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const formatMoney = (cents: number) => money.format(cents / 100);
const formatDate = (value: string) => dateTime.format(new Date(value));
const statusPresentation: Record<CommercialReservationStatus, { label: string; tone: "info" | "success" | "warning" | "danger" | "neutral" }> = {
  ACTIVE: { label: "Reservada", tone: "info" }, READY: { label: "Pronta para retirada", tone: "success" },
  CONVERTED: { label: "Aguardando pagamento", tone: "warning" }, COMPLETED: { label: "Concluída", tone: "neutral" },
  CANCELLED: { label: "Cancelada", tone: "danger" }, EXPIRED: { label: "Expirada", tone: "neutral" },
};

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/** Spec 5.10: the commission filters reservations, prepares them for pickup, cancels them and sets deadlines. */
export function ReservationsManagement() {
  const { showToast } = useToast();
  const [filters, setFilters] = useState({ status: "" as CommercialReservationStatus | "", query: "", from: "", to: "" });
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState<{ id: string; instructions: string } | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [settings, setSettings] = useState({ holdHours: "", pickupHours: "" });
  const keys = useRef(new Map<string, string>());
  const keyFor = (scope: string, payload: unknown) => {
    const fingerprint = `${scope}:${JSON.stringify(payload)}`;
    const key = keys.current.get(fingerprint) ?? `admin-reservation-${scope}:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    return key;
  };

  const load = useCallback(async (cursor?: string) => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.query.trim()) params.set("query", filters.query.trim());
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/v1/admin/reservations?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar as reservas."));
      const parsed = adminReservationsResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setReservations((current) => cursor ? [...current, ...parsed.data.data] : parsed.data.data);
      setNextCursor(parsed.data.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar as reservas."); }
    finally { setLoading(false); }
  }, [filters]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    void fetch("/api/v1/admin/reservations/settings", { cache: "no-store" }).then(async (response) => {
      const parsed = reservationSettingsResponseSchema.safeParse(await response.json().catch(() => null));
      if (response.ok && parsed.success) setSettings({ holdHours: String(parsed.data.data.holdHours), pickupHours: String(parsed.data.data.pickupHours) });
    }, () => undefined);
  }, []);

  async function run(scope: string, url: string, method: string, body: unknown, success: string) {
    setBusy(scope); setError("");
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor(scope, body) }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível concluir a operação."));
      showToast(success, "success");
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação."); return false; }
    finally { setBusy(null); }
  }

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    const parsed = reservationSettingsSchema.safeParse({ holdHours: Number(settings.holdHours), pickupHours: Number(settings.pickupHours) });
    if (!parsed.success) { setError("Informe prazos inteiros entre 1 e 720 horas."); return; }
    await run("settings", "/api/v1/admin/reservations/settings", "PUT", parsed.data, "Prazos atualizados. Valem para as próximas reservas e preparos.");
  }

  async function markReady(id: string, instructions: string) {
    const body = markReservationReadyRequestSchema.safeParse({ pickupInstructions: instructions.trim() || null });
    if (!body.success) { setError("As instruções precisam de 3 a 500 caracteres."); return; }
    if (await run(`ready-${id}`, `/api/v1/admin/reservations/${id}/ready`, "POST", body.data, "Reserva pronta para retirada.")) { setPreparing(null); await load(); }
  }

  async function cancel(id: string) {
    if (await run(`cancel-${id}`, `/api/v1/reservations/${id}/cancel`, "POST", {}, "Reserva cancelada e estoque liberado.")) { setCancelling(null); await load(); }
  }

  return <div className="grid gap-6">
    <Card className="p-5">
      <h2 className="font-semibold">Prazos</h2>
      <form aria-label="Prazos das reservas" onSubmit={saveSettings} className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field id="reservation-hold" label="Validade da reserva (horas)"><Input id="reservation-hold" inputMode="numeric" value={settings.holdHours} onChange={(event) => setSettings({ ...settings, holdHours: event.target.value })} /></Field>
        <Field id="reservation-pickup" label="Prazo de retirada após pronta (horas)"><Input id="reservation-pickup" inputMode="numeric" value={settings.pickupHours} onChange={(event) => setSettings({ ...settings, pickupHours: event.target.value })} /></Field>
        <Button type="submit" variant="secondary" loading={busy === "settings"} disabled={busy !== null}>Salvar prazos</Button>
      </form>
    </Card>
    <Card className="p-5">
      <form aria-label="Filtrar reservas" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <Field id="reservations-status" label="Situação"><select id="reservations-status" className="g-input min-h-11 w-full" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as CommercialReservationStatus | "" })}><option value="">Todas</option>{(Object.keys(statusPresentation) as CommercialReservationStatus[]).map((status) => <option key={status} value={status}>{statusPresentation[status].label}</option>)}</select></Field>
        <Field id="reservations-query" label="Cliente (nome ou e-mail)"><Input id="reservations-query" maxLength={80} value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} /></Field>
        <Field id="reservations-from" label="Criadas de"><Input id="reservations-from" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></Field>
        <Field id="reservations-to" label="Até"><Input id="reservations-to" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></Field>
      </form>
    </Card>
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    <Card className="overflow-hidden">
      {loading && reservations.length === 0 ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando reservas…</p>
        : reservations.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhuma reserva com estes filtros.</p>
        : <ul aria-label="Reservas" className="divide-y divide-[var(--g-border-subtle)]">
          {reservations.map((reservation) => {
            const status = statusPresentation[reservation.status];
            const open = reservation.status === "ACTIVE" || reservation.status === "READY";
            return <li key={reservation.reservationId} aria-label={`Reserva de ${reservation.customerName}`} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{reservation.customerName}</p>
                  <p className="text-sm text-[var(--g-text-secondary)]">{reservation.items.map((item) => `${item.quantity}× ${item.productName}`).join(", ")}</p>
                  <p className="mt-1 text-xs text-[var(--g-text-muted)]">Criada em {formatDate(reservation.createdAt)} · {reservation.locationName}
                    {reservation.status === "ACTIVE" && ` · válida até ${formatDate(reservation.expiresAt)}`}
                    {reservation.status === "READY" && reservation.pickupDeadline && ` · retirada até ${formatDate(reservation.pickupDeadline)}`}</p>
                  {reservation.status === "READY" && reservation.pickupInstructions && <p className="mt-1 text-sm">{reservation.pickupInstructions}</p>}
                </div>
                <div className="flex items-center gap-2"><Badge tone={status.tone}>{status.label}</Badge><span className="g-money font-bold">{formatMoney(reservation.totalCents)}</span></div>
              </div>
              {open && <div className="mt-3 flex flex-wrap items-end gap-2">
                {reservation.status === "ACTIVE" && (preparing?.id === reservation.reservationId
                  ? <><Field id={`ready-${reservation.reservationId}`} label="Instruções de retirada (opcional)" className="min-w-64 flex-1"><Input id={`ready-${reservation.reservationId}`} maxLength={500} value={preparing.instructions} onChange={(event) => setPreparing({ id: reservation.reservationId, instructions: event.target.value })} /></Field>
                    <Button type="button" size="sm" loading={busy === `ready-${reservation.reservationId}`} disabled={busy !== null} onClick={() => void markReady(reservation.reservationId, preparing.instructions)}>Confirmar pronta</Button>
                    <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setPreparing(null)}>Voltar</Button></>
                  : <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => setPreparing({ id: reservation.reservationId, instructions: "" })}><PackageCheck className="size-4" />Marcar pronta</Button>)}
                {cancelling === reservation.reservationId
                  ? <><Button type="button" size="sm" variant="danger" loading={busy === `cancel-${reservation.reservationId}`} disabled={busy !== null} onClick={() => void cancel(reservation.reservationId)}>Confirmar cancelamento</Button>
                    <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setCancelling(null)}>Manter</Button></>
                  : <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setCancelling(reservation.reservationId)}><XCircle className="size-4" />Cancelar</Button>}
              </div>}
            </li>;
          })}
        </ul>}
    </Card>
    {nextCursor && <Button type="button" variant="secondary" loading={loading} onClick={() => void load(nextCursor)}>Carregar mais</Button>}
  </div>;
}
