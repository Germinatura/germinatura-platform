"use client";

import type { SellerShift } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input, ReasonField } from "@germinatura/ui";
import { AlertTriangle, Banknote, CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { closeShift, formatMoney, loadMyShift, openShift, parseMoneyInput } from "@/lib/operations";

const operationKey = (kind: string) => `pdv-shift-${kind}:${crypto.randomUUID()}`;

/** PAY-009: opens the seller cash shift and closes it with a counted, justified total. */
export function ShiftWorkspace({ locationId, online, onShiftChange }: { locationId: string; online: boolean; onShiftChange?: (shift: SellerShift | null) => void }) {
  const { showToast } = useToast();
  const [shift, setShift] = useState<SellerShift | null>(null);
  const [closed, setClosed] = useState<SellerShift | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openingCash, setOpeningCash] = useState("0,00");
  const [countedCash, setCountedCash] = useState("");
  const [justification, setJustification] = useState("");
  const openKey = useRef(operationKey("open"));
  const closeKey = useRef(operationKey("close"));

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { const current = await loadMyShift(); setShift(current); onShiftChange?.(current); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar o turno."); }
    finally { setLoading(false); }
  }, [onShiftChange]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);

  const openingCents = parseMoneyInput(openingCash);
  const countedCents = parseMoneyInput(countedCash);
  const difference = shift && countedCents !== null ? countedCents - shift.expectedCashCents : null;
  const needsJustification = difference !== null && difference !== 0;

  async function submitOpen(event: React.FormEvent) {
    event.preventDefault();
    if (!online || openingCents === null || !locationId) return;
    setBusy(true); setError("");
    try {
      const opened = await openShift(locationId, openingCents, openKey.current);
      setShift(opened); setClosed(null); onShiftChange?.(opened); openKey.current = operationKey("open");
      showToast("Turno aberto.", "success");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível abrir o turno."); }
    finally { setBusy(false); }
  }

  async function submitClose(event: React.FormEvent) {
    event.preventDefault();
    if (!online || !shift || countedCents === null || (needsJustification && justification.trim().length < 8)) return;
    setBusy(true); setError("");
    try {
      const result = await closeShift(shift.shiftId, countedCents, needsJustification ? justification.trim() : null, closeKey.current);
      setClosed(result); setShift(null); onShiftChange?.(null); closeKey.current = operationKey("close");
      setCountedCash(""); setJustification("");
      showToast("Turno fechado.", "success");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível fechar o turno."); }
    finally { setBusy(false); }
  }

  if (loading) return <p role="status" className="p-6">Carregando turno…</p>;
  return <div className="mx-auto grid max-w-3xl gap-5">
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 bg-[var(--g-surface-default)] p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    {closed && <Card className="p-5"><div className="flex items-center gap-3"><CheckCircle2 className="size-6 text-[var(--g-operation-primary)]" /><h2 className="text-lg font-semibold">Turno fechado</h2></div><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-[var(--g-text-muted)]">Esperado</dt><dd className="g-money font-semibold">{formatMoney(closed.expectedCashCents)}</dd></div><div><dt className="text-[var(--g-text-muted)]">Contado</dt><dd className="g-money font-semibold">{formatMoney(closed.countedCashCents ?? 0)}</dd></div><div><dt className="text-[var(--g-text-muted)]">Diferença</dt><dd className="g-money font-semibold">{formatMoney(closed.differenceCents ?? 0)}</dd></div></dl></Card>}
    {!shift ? <Card className="p-5"><div className="flex items-start gap-3"><Banknote className="mt-0.5 size-5 text-[var(--g-focus-ring)]" /><div><h2 className="font-semibold">Abrir turno</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">O turno concentra o dinheiro recebido. Informe o fundo de troco que está no caixa agora.</p></div></div>
      <form aria-label="Abrir turno" onSubmit={submitOpen} className="mt-5 space-y-4"><Field id="shift-opening-cash" label="Fundo de troco (R$)"><Input id="shift-opening-cash" inputMode="decimal" value={openingCash} onChange={(event) => setOpeningCash(event.target.value)} /></Field>
        <Button type="submit" variant="operation" size="lg" className="w-full" loading={busy} disabled={!online || openingCents === null || !locationId}>Abrir turno</Button></form></Card>
      : <Card className="p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Turno aberto</h2><Badge tone="success">Aberto</Badge></div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><div><dt className="text-[var(--g-text-muted)]">Fundo de troco</dt><dd className="g-money font-semibold">{formatMoney(shift.openingCashCents)}</dd></div><div><dt className="text-[var(--g-text-muted)]">Vendas em dinheiro</dt><dd className="font-semibold">{shift.cashSalesCount} · <span className="g-money">{formatMoney(shift.cashSalesTotalCents)}</span></dd></div><div><dt className="text-[var(--g-text-muted)]">Devoluções em dinheiro</dt><dd className="font-semibold">{shift.cashRefundsCount} · <span className="g-money">{formatMoney(shift.cashRefundsTotalCents)}</span></dd></div><div><dt className="text-[var(--g-text-muted)]">Dinheiro esperado</dt><dd className="g-money text-lg font-bold">{formatMoney(shift.expectedCashCents)}</dd></div></dl>
        <form aria-label="Fechar turno" onSubmit={submitClose} className="mt-5 space-y-4 border-t border-[var(--g-border-subtle)] pt-5"><Field id="shift-counted-cash" label="Dinheiro contado no caixa (R$)"><Input id="shift-counted-cash" inputMode="decimal" required value={countedCash} onChange={(event) => setCountedCash(event.target.value)} /></Field>
          {difference !== null && <p role="status" className="text-sm">{difference === 0 ? "O contado confere com o esperado." : `Diferença de ${formatMoney(difference)}.`}</p>}
          {needsJustification && <ReasonField id="shift-justification" label="Justificativa da diferença" required minLength={8} maxLength={500} value={justification} onChange={(value) => setJustification(value)} />}
          <Button type="submit" variant="secondary" size="lg" className="w-full" loading={busy} disabled={!online || countedCents === null || (needsJustification && justification.trim().length < 8)}>Fechar turno</Button></form></Card>}
  </div>;
}
