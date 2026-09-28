"use client";

import type { MySale, MySalesFilter } from "@germinatura/contracts";
import { Badge, Button, Card } from "@germinatura/ui";
import { AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { cancelPendingSale, formatMoney, loadMySales, mySaleStatus, paymentMethodLabel } from "@/lib/operations";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const time = new Intl.DateTimeFormat("pt-BR", { timeStyle: "short", timeZone: "America/Sao_Paulo" });
const filters: Array<{ value: MySalesFilter | null; label: string }> = [
  { value: null, label: "Todas" }, { value: "PENDING", label: "Pendentes" },
  { value: "CONFIRMED", label: "Concluídas" }, { value: "CANCELLED", label: "Canceladas" },
];

/** Spec 6.10: the seller's own sales with status and method; pending ones are highlighted and can be cancelled. */
export function MySalesWorkspace({ online }: { online: boolean }) {
  const { showToast } = useToast();
  const [filter, setFilter] = useState<MySalesFilter | null>(null);
  const [sales, setSales] = useState<MySale[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const cancelKeys = useRef(new Map<string, string>());

  const load = useCallback(async (cursor?: string) => {
    setLoading(true); setError("");
    try {
      const page = await loadMySales(filter, cursor);
      setSales((current) => cursor ? [...current, ...page.data] : page.data);
      setNextCursor(page.nextCursor); setPendingCount(page.pendingCount);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar suas vendas."); }
    finally { setLoading(false); }
  }, [filter]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function cancel(saleId: string) {
    if (!online) return;
    const key = cancelKeys.current.get(saleId) ?? `pdv-my-sale-cancel:${crypto.randomUUID()}`;
    cancelKeys.current.set(saleId, key);
    setCancelling(saleId); setError("");
    try {
      await cancelPendingSale(saleId, key);
      cancelKeys.current.delete(saleId); setConfirming(null);
      showToast("Venda cancelada e reserva liberada.", "success");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível cancelar a venda."); }
    finally { setCancelling(null); }
  }

  return <div className="mx-auto grid max-w-3xl gap-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div role="group" aria-label="Filtrar vendas" className="flex flex-wrap gap-2">
        {filters.map((option) => <Button key={option.label} type="button" size="sm" variant={filter === option.value ? "operation" : "secondary"}
          aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>
          {option.label}{option.value === "PENDING" && pendingCount > 0 ? ` (${pendingCount})` : ""}
        </Button>)}
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={() => void load()} disabled={loading}><RefreshCw className="size-4" />Atualizar</Button>
    </div>
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 bg-[var(--g-surface-default)] p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    {loading && sales.length === 0 ? <p role="status" className="p-2">Carregando vendas…</p>
      : sales.length === 0 ? <Card className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhuma venda nesta lista.</Card>
      : <ul aria-label="Minhas vendas" className="grid gap-3">
        {sales.map((sale) => {
          const status = mySaleStatus(sale);
          const pending = sale.pendingReason !== null;
          return <li key={sale.saleId} aria-label={`Venda de ${dateTime.format(new Date(sale.createdAt))}`}>
            <Card className={`p-4 ${pending ? "border-[var(--g-status-warning)] bg-[var(--g-status-warning-soft)]" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="g-money text-lg font-bold">{formatMoney(sale.totalCents)}</p>
                  <p className="text-sm text-[var(--g-text-secondary)]">{dateTime.format(new Date(sale.createdAt))} · {paymentMethodLabel(sale.payment?.integrationChannel)}</p>
                </div>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
              <p className="mt-2 text-sm">{sale.items.map((item) => `${item.quantity}× ${item.productName}`).join(", ")}</p>
              {sale.discountTotalCents > 0 && <p className="mt-1 text-xs text-[var(--g-text-muted)]">Desconto de <span className="g-money">{formatMoney(sale.discountTotalCents)}</span></p>}
              {sale.pendingReason === "AWAITING_PAYMENT" && <div className="mt-3 border-t border-[var(--g-border-subtle)] pt-3">
                {sale.reservationExpiresAt && <p className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Clock className="size-4" />Reserva até {time.format(new Date(sale.reservationExpiresAt))}</p>}
                {confirming === sale.saleId
                  ? <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" variant="danger" loading={cancelling === sale.saleId} disabled={!online || cancelling !== null} onClick={() => void cancel(sale.saleId)}>Confirmar cancelamento</Button><Button type="button" size="sm" variant="ghost" disabled={cancelling !== null} onClick={() => setConfirming(null)}>Manter venda</Button></div>
                  : <Button type="button" size="sm" variant="secondary" className="mt-3" disabled={!online || cancelling !== null} onClick={() => setConfirming(sale.saleId)}>Cancelar venda</Button>}
              </div>}
              {sale.pendingReason === "RECONCILIATION_PENDING" && <p className="mt-3 border-t border-[var(--g-border-subtle)] pt-3 text-sm text-[var(--g-text-secondary)]">O financeiro está conciliando este pagamento; nenhuma ação é necessária no PDV.</p>}
              {sale.status === "CONFIRMED" && !pending && <p className="mt-2 text-xs text-[var(--g-text-muted)]">Estorno de venda concluída somente pelo financeiro.</p>}
            </Card>
          </li>;
        })}
      </ul>}
    {nextCursor && <Button type="button" variant="secondary" loading={loading} onClick={() => void load(nextCursor)}>Carregar mais</Button>}
  </div>;
}
