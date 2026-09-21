"use client";

import {
  purchasePayableCommandResponseSchema,
  purchasePayablesResponseSchema,
  settlePurchasePayableSchema,
  type PurchasePayable,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Banknote, Loader2, RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const date = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "America/Sao_Paulo" });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const idempotency = (scope: string) => `${scope}:${crypto.randomUUID()}`;
const formatMoney = (cents: number) => money.format(cents / 100);
function parseMoneyCents(value: string): number | null {
  const match = value.trim().match(/^(\d{1,13})(?:[,.](\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

export function PurchasePayablesManagement() {
  const [items, setItems] = useState<PurchasePayable[]>([]);
  const [status, setStatus] = useState<"ALL" | "PENDING" | "SETTLED">("PENDING");
  const [query, setQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async (append = false, cursor?: string) => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ status });
      if (query.trim()) params.set("query", query.trim());
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/v1/admin/finance/payables?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar as contas a pagar."));
      const parsed = purchasePayablesResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setItems((current) => append ? [...current, ...parsed.data.data] : parsed.data.data);
      setNextCursor(parsed.data.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar as contas a pagar."); }
    finally { setLoading(false); }
  }, [query, status]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [load]);
  const totals = useMemo(() => items.reduce((sum, item) => ({ amount: sum.amount + item.amountCents, outstanding: sum.outstanding + item.outstandingCents }), { amount: 0, outstanding: 0 }), [items]);
  return <>
    <section className="grid gap-4 sm:grid-cols-2" aria-label="Resumo das obrigações">
      <Card className="p-5"><p className="text-sm font-semibold text-[var(--g-text-secondary)]">Valor exibido</p><p className="mt-3 text-3xl font-bold tabular-nums">{formatMoney(totals.amount)}</p></Card>
      <Card className="p-5"><p className="text-sm font-semibold text-[var(--g-text-secondary)]">Saldo pendente exibido</p><p className="mt-3 text-3xl font-bold tabular-nums text-[var(--g-status-warning-foreground)]">{formatMoney(totals.outstanding)}</p></Card>
    </section>
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-[var(--g-border-subtle)] p-5 md:flex-row md:items-end md:justify-between">
        <div><h2 className="text-xl font-semibold">Obrigações de fornecedores</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Cada obrigação nasce uma única vez no recebimento físico.</p></div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="relative"><span className="sr-only">Buscar fornecedor</span><Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-[var(--g-text-muted)]" /><Input className="pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar fornecedor" maxLength={160} /></label>
          <label><span className="sr-only">Filtrar estado</span><select className="g-input" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="PENDING">Pendentes</option><option value="SETTLED">Liquidadas</option><option value="ALL">Todas</option></select></label>
        </div>
      </div>
      {error && <p role="alert" className="m-5 flex gap-2 rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]"><AlertTriangle className="size-5 shrink-0" />{error}</p>}
      {loading && items.length === 0 ? <p role="status" className="flex items-center gap-2 p-6 text-sm"><Loader2 className="size-4 animate-spin" /> Carregando contas a pagar…</p>
        : items.length === 0 ? <div className="grid min-h-56 place-items-center p-8 text-center"><div><Banknote className="mx-auto size-10 text-[var(--g-text-muted)]" /><h3 className="mt-4 font-semibold">Nenhuma obrigação encontrada</h3><p className="mt-2 text-sm text-[var(--g-text-secondary)]">Recebimentos de compras criarão as obrigações automaticamente.</p></div></div>
          : <div className="divide-y divide-[var(--g-border-subtle)]">{items.map((item) => <PayableCard key={`${item.id}:${item.outstandingCents}:${item.settlements.length}`} item={item} onChanged={() => load()} />)}</div>}
      {nextCursor && <div className="border-t border-[var(--g-border-subtle)] p-5 text-center"><Button variant="secondary" loading={loading} onClick={() => void load(true, nextCursor)}>Carregar mais</Button></div>}
    </Card>
  </>;
}

function PayableCard({ item, onChanged }: { item: PurchasePayable; onChanged: () => Promise<void> }) {
  const [amount, setAmount] = useState((item.outstandingCents / 100).toFixed(2).replace(".", ","));
  const [effectiveOn, setEffectiveOn] = useState(today);
  const [paymentMethod, setPaymentMethod] = useState(item.expectedPaymentMethod);
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [reversalReasons, setReversalReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const key = useRef(idempotency("payable-settlement"));
  const reversalKeys = useRef(new Map<string, string>());
  const { showToast } = useToast();
  const reversed = new Set(item.settlements.filter((entry) => entry.entryType === "REVERSAL" && entry.reversalOf).map((entry) => entry.reversalOf));
  async function settle(event: React.FormEvent) {
    event.preventDefault();
    const amountCents = parseMoneyCents(amount);
    const parsed = settlePurchasePayableSchema.safeParse({ amountCents, effectiveOn, paymentMethod, reference, reason });
    if (!parsed.success) { showToast("Confira valor, data, método, referência e motivo.", "error"); return; }
    setBusy("settle");
    try {
      const response = await fetch(`/api/v1/admin/finance/payables/${item.id}/settlements`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current }, body: JSON.stringify(parsed.data) });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível registrar a liquidação."));
      if (!purchasePayableCommandResponseSchema.safeParse(await response.json()).success) throw new Error("A liquidação retornou dados inválidos.");
      showToast("Liquidação registrada e auditada.", "success");
      key.current = idempotency("payable-settlement"); setReference(""); setReason(""); await onChanged();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : "Não foi possível registrar a liquidação.", "error"); }
    finally { setBusy(null); }
  }
  async function reverse(settlementId: string) {
    const reversalReason = reversalReasons[settlementId]?.trim() ?? "";
    if (reversalReason.length < 4) return;
    const operation = `reverse:${settlementId}`;
    const operationKey = reversalKeys.current.get(settlementId) ?? idempotency("payable-reversal");
    reversalKeys.current.set(settlementId, operationKey); setBusy(operation);
    try {
      const response = await fetch(`/api/v1/admin/finance/payables/settlements/${settlementId}/reverse`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": operationKey }, body: JSON.stringify({ effectiveOn: today(), reason: reversalReason }) });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível reverter a liquidação."));
      if (!purchasePayableCommandResponseSchema.safeParse(await response.json()).success) throw new Error("A reversão retornou dados inválidos.");
      reversalKeys.current.delete(settlementId); showToast("Liquidação revertida sem apagar o histórico.", "success"); await onChanged();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : "Não foi possível reverter a liquidação.", "error"); }
    finally { setBusy(null); }
  }
  return <article className="space-y-5 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{item.supplierName}</h3><p className="mt-1 text-xs text-[var(--g-text-muted)]">Obrigação {item.id} · criada em {date.format(new Date(item.createdAt))}</p></div><Badge tone={item.status === "SETTLED" ? "success" : "warning"}>{item.status === "SETTLED" ? "Liquidada" : "Pendente"}</Badge></div>
    <dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-[var(--g-text-muted)]">Total</dt><dd className="font-semibold tabular-nums">{formatMoney(item.amountCents)}</dd></div><div><dt className="text-[var(--g-text-muted)]">Liquidado</dt><dd className="font-semibold tabular-nums">{formatMoney(item.settledCents)}</dd></div><div><dt className="text-[var(--g-text-muted)]">Pendente</dt><dd className="font-semibold tabular-nums">{formatMoney(item.outstandingCents)}</dd></div></dl>
    {item.outstandingCents > 0 && <form onSubmit={settle} className="rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-4"><h4 className="font-semibold">Registrar pagamento</h4><div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><Field id={`amount-${item.id}`} label="Valor em reais"><Input id={`amount-${item.id}`} inputMode="decimal" value={amount} onChange={(event) => { key.current = idempotency("payable-settlement"); setAmount(event.target.value); }} /></Field><Field id={`date-${item.id}`} label="Data efetiva"><Input id={`date-${item.id}`} type="date" max={today()} value={effectiveOn} onChange={(event) => { key.current = idempotency("payable-settlement"); setEffectiveOn(event.target.value); }} /></Field><Field id={`method-${item.id}`} label="Método"><Input id={`method-${item.id}`} value={paymentMethod} maxLength={100} onChange={(event) => { key.current = idempotency("payable-settlement"); setPaymentMethod(event.target.value); }} /></Field><Field id={`reference-${item.id}`} label="Referência ou comprovante"><Input id={`reference-${item.id}`} value={reference} maxLength={160} onChange={(event) => { key.current = idempotency("payable-settlement"); setReference(event.target.value); }} /></Field><Field id={`reason-${item.id}`} label="Motivo"><Input id={`reason-${item.id}`} value={reason} minLength={4} maxLength={500} onChange={(event) => { key.current = idempotency("payable-settlement"); setReason(event.target.value); }} /></Field></div><Button className="mt-4" type="submit" loading={busy === "settle"} disabled={Boolean(busy)}>Registrar liquidação</Button></form>}
    {item.settlements.length > 0 && <div><h4 className="text-sm font-semibold">Histórico imutável</h4><ul className="mt-2 divide-y divide-[var(--g-border-subtle)]">{item.settlements.map((entry) => <li key={entry.id} className="py-3 text-sm"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold">{entry.entryType === "SETTLEMENT" ? "Pagamento" : "Reversão"} · {formatMoney(entry.amountCents)}</p><p className="text-[var(--g-text-secondary)]">{entry.effectiveOn} · {entry.paymentMethod} · {entry.reference}</p><p className="text-[var(--g-text-muted)]">{entry.reason}</p></div>{entry.entryType === "SETTLEMENT" && !reversed.has(entry.id) && <div className="flex flex-wrap items-end gap-2"><Field id={`reverse-${entry.id}`} label="Motivo da reversão"><Input id={`reverse-${entry.id}`} minLength={4} maxLength={500} value={reversalReasons[entry.id] ?? ""} onChange={(event) => setReversalReasons((current) => ({ ...current, [entry.id]: event.target.value }))} /></Field><Button type="button" size="sm" variant="secondary" loading={busy === `reverse:${entry.id}`} disabled={Boolean(busy) || (reversalReasons[entry.id]?.trim().length ?? 0) < 4} onClick={() => void reverse(entry.id)}><RotateCcw className="size-4" /> Reverter</Button></div>}</div></li>)}</ul></div>}
  </article>;
}
