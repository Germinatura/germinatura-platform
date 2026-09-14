"use client";

import type { StockReturnContextResponse } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { Loader2, PackageCheck, RefreshCw, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cancelStockReturn, loadStockReturns, requestStockReturn } from "@/lib/operations";
import { useToast } from "@/components/ui/Toast";

type Context = StockReturnContextResponse["data"];
type ReturnRequest = Context["requests"][number];
const key = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
const messageFrom = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir esta ação.";
const labels: Record<ReturnRequest["status"], string> = { REQUESTED: "Aguardando recebimento", RECEIVED: "Recebida", REJECTED: "Recusada", CANCELLED: "Cancelada" };

export function StockReturnWorkspace({ online }: { online: boolean }) {
  const [context, setContext] = useState<Context | null>(null);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [decisionReasons, setDecisionReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const requestKey = useRef(key("stock-return-request"));
  const cancelKeys = useRef(new Map<string, string>());
  const { showToast } = useToast();

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const next = await loadStockReturns(); setContext(next);
      setProductId((current) => current || next.options[0]?.productId || "");
    } catch (cause) { setError(messageFrom(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);
  const option = context?.options.find((item) => item.productId === productId);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); const amount = Number(quantity);
    if (!online || !option || !Number.isSafeInteger(amount) || amount < 1 || amount > option.availableQuantity || reason.trim().length < 4) return;
    setAction("request"); setError("");
    try {
      await requestStockReturn({ productId, quantity: amount, reason: reason.trim() }, requestKey.current);
      requestKey.current = key("stock-return-request"); setQuantity("1"); setReason("");
      showToast("Devolução solicitada. O estoque mudará após a conferência da central.", "success"); await refresh();
    } catch (cause) { const message = messageFrom(cause); setError(message); showToast(message, "error"); }
    finally { setAction(null); }
  }

  async function cancel(item: ReturnRequest) {
    const decisionReason = decisionReasons[item.id]?.trim() ?? ""; if (!online || decisionReason.length < 4) return;
    const operation = `cancel:${item.id}`; const operationKey = cancelKeys.current.get(item.id) ?? key("stock-return-cancel"); cancelKeys.current.set(item.id, operationKey);
    setAction(operation); setError("");
    try {
      await cancelStockReturn(item.id, decisionReason, operationKey); cancelKeys.current.delete(item.id);
      setDecisionReasons((current) => ({ ...current, [item.id]: "" })); showToast("Solicitação cancelada.", "success"); await refresh();
    } catch (cause) { const message = messageFrom(cause); setError(message); showToast(message, "error"); }
    finally { setAction(null); }
  }

  async function loadOlder() {
    if (!context?.nextCursor || action) return; setAction("older");
    try { const older = await loadStockReturns(context.nextCursor); setContext((current) => current ? { ...current, nextCursor: older.nextCursor, requests: [...current.requests, ...older.requests.filter((item) => !current.requests.some((known) => known.id === item.id))] } : older); }
    catch (cause) { setError(messageFrom(cause)); } finally { setAction(null); }
  }

  if (loading && !context) return <Card className="grid min-h-64 place-items-center p-8"><p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-5 animate-spin" /> Carregando devoluções…</p></Card>;
  return <div className="grid gap-6 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.2fr)]">
    <Card className="h-fit p-5"><div className="flex justify-between gap-3"><div><h2 className="font-semibold">Devolver para a central</h2><p className="mt-1 text-sm leading-6 text-[var(--g-text-secondary)]">A solicitação aguarda conferência física. O saldo só muda quando a central confirmar o recebimento.</p></div><RotateCcw className="size-5 text-[var(--g-focus-ring)]" /></div>
      <form className="mt-5 space-y-4" onSubmit={submit} aria-label="Solicitar devolução à central">
        <Field id="return-product" label="Produto"><select id="return-product" className="g-input" value={productId} onChange={(event) => { setProductId(event.target.value); requestKey.current = key("stock-return-request"); }} disabled={!online || Boolean(action)}>{context?.options.map((item) => <option key={item.productId} value={item.productId}>{item.productName} · {item.productSku} · {item.availableQuantity} disponíveis</option>)}</select></Field>
        <Field id="return-quantity" label="Quantidade" description={option ? `Até ${option.availableQuantity} unidade(s) disponíveis agora.` : undefined}><Input id="return-quantity" type="number" inputMode="numeric" min={1} max={option?.availableQuantity ?? 1} value={quantity} onChange={(event) => { setQuantity(event.target.value); requestKey.current = key("stock-return-request"); }} disabled={!online || !option || Boolean(action)} /></Field>
        <Field id="return-reason" label="Motivo"><textarea id="return-reason" className="g-input min-h-24 py-3" minLength={4} maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); requestKey.current = key("stock-return-request"); }} disabled={!online || Boolean(action)} /></Field>
        <Button type="submit" variant="operation" className="w-full" loading={action === "request"} disabled={!online || !option || reason.trim().length < 4 || Boolean(action)}>Solicitar devolução</Button>
      </form>
      {!context?.options.length && <p className="mt-4 rounded-lg bg-[var(--g-surface-subtle)] p-3 text-sm text-[var(--g-text-secondary)]">Seu estoque não possui saldo disponível para devolução.</p>}
      {!online && <p role="status" className="mt-4 text-sm font-semibold text-[var(--g-status-warning-foreground)]">Conecte-se para registrar ou cancelar devoluções.</p>}
      {error && <p role="alert" className="mt-4 text-sm text-[var(--g-status-danger)]">{error}</p>}
      <Button type="button" variant="ghost" className="mt-3 w-full" onClick={() => void refresh()} disabled={loading || Boolean(action)}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Atualizar</Button>
    </Card>
    <section aria-label="Minhas devoluções"><h2 className="mb-3 flex items-center gap-2 font-semibold"><PackageCheck className="size-5 text-[var(--g-focus-ring)]" /> Minhas devoluções</h2><div className="space-y-3">
      {!context?.requests.length ? <Card className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhuma devolução registrada.</Card> : context.requests.map((item) => <Card key={item.id} className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold">{item.productName} · {item.quantity} un.</p><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{item.fromLocationName} → {item.toLocationName}</p></div><Badge tone={item.status === "RECEIVED" ? "success" : item.status === "REQUESTED" ? "warning" : "neutral"}>{labels[item.status]}</Badge></div><p className="mt-3 text-sm"><span className="text-[var(--g-text-muted)]">Motivo:</span> {item.requestReason}</p>{item.decisionReason && <p className="mt-2 text-sm"><span className="text-[var(--g-text-muted)]">Decisão:</span> {item.decisionReason}</p>}{item.status === "REQUESTED" && <div className="mt-4 border-t border-[var(--g-border-subtle)] pt-4"><label htmlFor={`return-cancel-${item.id}`} className="text-sm font-semibold">Motivo do cancelamento</label><Input id={`return-cancel-${item.id}`} className="mt-2" minLength={4} maxLength={500} value={decisionReasons[item.id] ?? ""} onChange={(event) => setDecisionReasons((current) => ({ ...current, [item.id]: event.target.value }))} disabled={!online || Boolean(action)} /><Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => void cancel(item)} loading={action === `cancel:${item.id}`} disabled={!online || (decisionReasons[item.id]?.trim().length ?? 0) < 4 || Boolean(action)}><X className="size-4" /> Cancelar solicitação</Button></div>}</Card>)}
      {context?.nextCursor && <Button type="button" variant="secondary" className="w-full" onClick={() => void loadOlder()} loading={action === "older"} disabled={Boolean(action)}>Carregar anteriores</Button>}
    </div></section>
  </div>;
}
