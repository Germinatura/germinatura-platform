"use client";

import { adminSellerShiftsResponseSchema, type AdminSellerShift } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input, ReasonField } from "@germinatura/ui";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseReais } from "@/lib/money-input";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const formatMoney = (cents: number) => money.format(cents / 100);
type StatusFilter = "OPEN" | "CLOSED" | "ALL";
const filters: Array<{ value: StatusFilter; label: string }> = [
  { value: "OPEN", label: "Abertos" }, { value: "CLOSED", label: "Fechados" }, { value: "ALL", label: "Todos" },
];

/** PAY-009a: finance review of seller drawers; expected = float + receipts - physical refunds. */
export function SellerShiftsReview() {
  const [status, setStatus] = useState<StatusFilter>("OPEN");
  const [items, setItems] = useState<AdminSellerShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const params = status === "ALL" ? "" : `?status=${status}`;
      const response = await fetch(`/api/v1/admin/finance/shifts${params}`, { cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : null;
        throw new Error(message ?? "Não foi possível carregar os turnos.");
      }
      const parsed = adminSellerShiftsResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setItems(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar os turnos."); }
    finally { setLoading(false); }
  }, [status]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  return <Card className="overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--g-border-subtle)] p-5">
      <div role="group" aria-label="Situação do turno" className="flex flex-wrap gap-2">
        {filters.map((filter) => <Button key={filter.value} type="button" size="sm" variant={status === filter.value ? "brand" : "secondary"}
          aria-pressed={status === filter.value} onClick={() => setStatus(filter.value)}>{filter.label}</Button>)}
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={() => void load()} disabled={loading}><RefreshCw className="size-4" />Atualizar</Button>
    </div>
    {error && <div role="alert" className="m-5 flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    {loading ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando turnos…</p>
      : !error && items.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhum turno nesta situação.</p>
      : <ul className="divide-y divide-[var(--g-border-subtle)]" aria-label="Turnos">
        {items.map((shift) => <li key={shift.shiftId} className="p-5" aria-label={`Turno de ${shift.sellerName}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold">{shift.sellerName}</p>
              <p className="text-sm text-[var(--g-text-secondary)]">{shift.locationName} · aberto em {dateTime.format(new Date(shift.openedAt))}{shift.closedAt ? ` · fechado em ${dateTime.format(new Date(shift.closedAt))}` : ""}</p>
              <p className="mt-1 break-all font-mono text-xs text-[var(--g-text-muted)]">Turno {shift.shiftId}</p>
            </div>
            {shift.status === "OPEN" ? <Badge tone="success">Aberto</Badge>
              : shift.differenceCents === 0 ? <Badge tone="neutral">Fechado sem diferença</Badge>
              : <Badge tone="warning">Fechado com diferença</Badge>}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
            <div><dt className="text-[var(--g-text-muted)]">Fundo de troco</dt><dd className="g-money font-semibold">{formatMoney(shift.openingCashCents)}</dd></div>
            <div><dt className="text-[var(--g-text-muted)]">Recebido em dinheiro</dt><dd className="font-semibold">{shift.cashSalesCount} · <span className="g-money">{formatMoney(shift.cashSalesTotalCents)}</span></dd></div>
            <div><dt className="text-[var(--g-text-muted)]">Devolvido em dinheiro</dt><dd className="font-semibold">{shift.cashRefundsCount} · <span className="g-money">{formatMoney(shift.cashRefundsTotalCents)}</span></dd></div>
            <div><dt className="text-[var(--g-text-muted)]">Esperado</dt><dd className="g-money font-bold">{formatMoney(shift.expectedCashCents)}</dd></div>
            <div><dt className="text-[var(--g-text-muted)]">Contado</dt><dd className="g-money font-semibold">{shift.countedCashCents === null ? "—" : formatMoney(shift.countedCashCents)}</dd></div>
            <div><dt className="text-[var(--g-text-muted)]">Diferença</dt><dd className="g-money font-semibold">{shift.differenceCents === null ? "—" : formatMoney(shift.differenceCents)}</dd></div>
          </dl>
          {shift.justification && <p className="mt-3 text-sm"><span className="text-[var(--g-text-muted)]">Justificativa: </span>{shift.justification}</p>}
          {shift.status === "OPEN" && <CloseOnBehalf shift={shift} onClosed={() => void load()} />}
        </li>)}
      </ul>}
  </Card>;
}

/**
 * ADR 0011 (PR 5): finance takes over the open drawer of another person (for example, one whose access was revoked).
 * The counted cash and a justification are mandatory; the audit names the seller and who closed it.
 */
function CloseOnBehalf({ shift, onClosed }: { shift: AdminSellerShift; onClosed: () => void }) {
  const [open, setOpen] = useState(false);
  const [counted, setCounted] = useState("");
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(`shift-close-on-behalf:${crypto.randomUUID()}`);
  const cents = parseReais(counted);
  const valid = cents !== null && justification.trim().length >= 8;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/finance/shifts/${shift.shiftId}/close`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current },
        body: JSON.stringify({ countedCashCents: cents, justification: justification.trim() }),
      });
      const body = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "Não foi possível encerrar o turno.");
      onClosed();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível encerrar o turno."); }
    finally { setBusy(false); }
  }
  if (!open) return <Button type="button" size="sm" variant="secondary" className="mt-4" onClick={() => setOpen(true)}>Encerrar pelo vendedor</Button>;
  return <form aria-label={`Encerrar o turno de ${shift.sellerName}`} onSubmit={(event) => void submit(event)} className="mt-4 grid gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-border-default)] p-4 sm:grid-cols-2">
    <p className="text-sm text-[var(--g-text-secondary)] sm:col-span-2">Use quando a pessoa não pode encerrar (por exemplo, acesso revogado). O dinheiro contado é conferido com o esperado ({formatMoney(shift.expectedCashCents)}).</p>
    <Field id={`counted-${shift.shiftId}`} label="Dinheiro contado (R$)"><Input id={`counted-${shift.shiftId}`} inputMode="decimal" value={counted} onChange={(event) => setCounted(event.target.value)} /></Field>
    <ReasonField id={`close-reason-${shift.shiftId}`} label="Justificativa" minLength={8} maxLength={500} value={justification} onChange={setJustification} />
    {error && <p role="alert" className="text-sm text-[var(--g-status-danger)] sm:col-span-2">{error}</p>}
    <div className="flex gap-2 sm:col-span-2"><Button type="submit" size="sm" loading={busy} disabled={!valid || busy}>Encerrar turno</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancelar</Button></div>
  </form>;
}
