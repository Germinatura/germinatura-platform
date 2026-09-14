"use client";

import { stockReturnContextResponseSchema, stockReturnMutationResponseSchema, type StockReturnContextResponse } from "@germinatura/contracts";
import { Badge, Button, Card, Input } from "@germinatura/ui";
import { Check, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Context = StockReturnContextResponse["data"];
type ReturnRequest = Context["requests"][number];
const labels: Record<ReturnRequest["status"], string> = { REQUESTED: "Aguardando conferência", RECEIVED: "Recebida", REJECTED: "Recusada", CANCELLED: "Cancelada" };
const messageFrom = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir esta ação.";

export function StockReturnManagement() {
  const [context, setContext] = useState<Context | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async (cursor?: string) => {
    const response = await fetch(`/api/v1/admin/inventory/returns?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body && typeof body === "object" && "message" in body ? String(body.message) : "Não foi possível carregar as devoluções.");
    const parsed = stockReturnContextResponseSchema.safeParse(body); if (!parsed.success) throw new Error("A consulta de devoluções retornou dados inválidos."); return parsed.data.data;
  }, []);
  const refresh = useCallback(async () => { setLoading(true); setError(""); try { setContext(await load()); } catch (cause) { setError(messageFrom(cause)); } finally { setLoading(false); } }, [load]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);

  async function resolve(item: ReturnRequest, decision: "RECEIVE" | "REJECT") {
    const reason = reasons[item.id]?.trim() ?? ""; if (reason.length < 4 || action) return;
    const actionId = `${item.id}:${decision}`; const idempotencyKey = keys.current.get(actionId) ?? `stock-return-${decision.toLowerCase()}:${crypto.randomUUID()}`; keys.current.set(actionId, idempotencyKey);
    setAction(actionId); setError("");
    try {
      const response = await fetch(`/api/v1/admin/inventory/returns/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ action: decision, reason }) });
      const body: unknown = await response.json().catch(() => null); if (!response.ok) throw new Error(body && typeof body === "object" && "message" in body ? String(body.message) : "Não foi possível registrar a conferência.");
      if (!stockReturnMutationResponseSchema.safeParse(body).success) throw new Error("A confirmação da devolução retornou dados inválidos.");
      keys.current.delete(actionId); setReasons((current) => ({ ...current, [item.id]: "" })); await refresh();
    } catch (cause) { setError(messageFrom(cause)); } finally { setAction(null); }
  }
  async function older() { if (!context?.nextCursor || action) return; setAction("older"); try { const page = await load(context.nextCursor); setContext((current) => current ? { ...current, nextCursor: page.nextCursor, requests: [...current.requests, ...page.requests.filter((item) => !current.requests.some((known) => known.id === item.id))] } : page); } catch (cause) { setError(messageFrom(cause)); } finally { setAction(null); } }

  return <Card className="overflow-hidden"><div className="flex items-start justify-between gap-3 border-b border-[var(--g-border-subtle)] p-5"><div><h2 className="text-lg font-bold">Devoluções para a central</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Confirme somente depois de conferir produto e quantidade. A confirmação transfere o saldo em uma única transação.</p></div><Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading || Boolean(action)}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Atualizar</Button></div>
    {error && <p role="alert" className="m-5 rounded-lg bg-[var(--g-status-danger-soft)] p-3 text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
    {loading && !context ? <p role="status" className="flex items-center gap-2 p-5 text-sm"><Loader2 className="size-4 animate-spin" /> Carregando devoluções…</p> : !context?.requests.length ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhuma devolução registrada.</p> : <div className="divide-y divide-[var(--g-border-subtle)]">{context.requests.map((item) => <article key={item.id} className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold">{item.productName} · {item.quantity} un.</p><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{item.fromLocationName} → {item.toLocationName}</p></div><Badge tone={item.status === "RECEIVED" ? "success" : item.status === "REQUESTED" ? "warning" : "neutral"}>{labels[item.status]}</Badge></div><p className="mt-3 text-sm"><span className="text-[var(--g-text-muted)]">Solicitação:</span> {item.requestReason}</p>{item.decisionReason && <p className="mt-2 text-sm"><span className="text-[var(--g-text-muted)]">Decisão:</span> {item.decisionReason}</p>}{item.status === "REQUESTED" && <div className="mt-4 border-t border-[var(--g-border-subtle)] pt-4"><label htmlFor={`return-decision-${item.id}`} className="text-sm font-semibold">Resultado da conferência</label><Input id={`return-decision-${item.id}`} className="mt-2" minLength={4} maxLength={500} value={reasons[item.id] ?? ""} onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Ex.: quantidade e integridade conferidas" disabled={Boolean(action)} /><div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" onClick={() => void resolve(item, "RECEIVE")} loading={action === `${item.id}:RECEIVE`} disabled={(reasons[item.id]?.trim().length ?? 0) < 4 || Boolean(action)}><Check className="size-4" /> Confirmar recebimento</Button><Button type="button" size="sm" variant="secondary" onClick={() => void resolve(item, "REJECT")} loading={action === `${item.id}:REJECT`} disabled={(reasons[item.id]?.trim().length ?? 0) < 4 || Boolean(action)}><X className="size-4" /> Recusar</Button></div></div>}</article>)}</div>}
    {context?.nextCursor && <div className="border-t border-[var(--g-border-subtle)] p-4"><Button type="button" variant="secondary" className="w-full" onClick={() => void older()} loading={action === "older"} disabled={Boolean(action)}>Carregar anteriores</Button></div>}
  </Card>;
}
