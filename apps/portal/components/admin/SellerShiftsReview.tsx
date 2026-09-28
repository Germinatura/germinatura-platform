"use client";

import { adminSellerShiftsResponseSchema, type AdminSellerShift } from "@germinatura/contracts";
import { Badge, Button, Card } from "@germinatura/ui";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
        </li>)}
      </ul>}
  </Card>;
}
