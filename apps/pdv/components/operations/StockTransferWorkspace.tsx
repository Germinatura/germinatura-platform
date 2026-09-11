"use client";

import type { SellerStockTransferContextResponse } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { ArrowDownToLine, ArrowUpFromLine, Check, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadSellerStockTransfers, requestSellerStockTransfer, resolveSellerStockTransfer,
} from "@/lib/operations";
import { useToast } from "@/components/ui/Toast";

type Context = SellerStockTransferContextResponse["data"];
type Transfer = Context["requests"][number];
type ResolutionAction = "ACCEPT" | "REJECT" | "CANCEL";

const operationKey = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
const messageFrom = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir esta ação.";
const statusLabel: Record<Transfer["status"], string> = {
  REQUESTED: "Pendente", ACCEPTED: "Aceita", REJECTED: "Recusada", CANCELLED: "Cancelada",
};

export function StockTransferWorkspace({ online }: { online: boolean }) {
  const [context, setContext] = useState<Context | null>(null);
  const [selected, setSelected] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [decisionReasons, setDecisionReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const requestKey = useRef(operationKey("seller-transfer-request"));
  const resolutionKeys = useRef(new Map<string, string>());
  const { showToast } = useToast();

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const next = await loadSellerStockTransfers();
      setContext(next);
      setSelected((current) => current || (next.options[0] ? `${next.options[0].fromLocationId}:${next.options[0].productId}` : ""));
    } catch (loadError) { setError(messageFrom(loadError)); }
    finally { setLoading(false); }
  }, []);

  async function loadOlder() {
    if (!context?.nextCursor || action !== null) return;
    setAction("load-more"); setError("");
    try {
      const older = await loadSellerStockTransfers(context.nextCursor);
      setContext((current) => current ? {
        ...current,
        nextCursor: older.nextCursor,
        requests: [...current.requests, ...older.requests.filter((item) => !current.requests.some((existing) => existing.id === item.id))],
      } : older);
    } catch (loadError) { setError(messageFrom(loadError)); }
    finally { setAction(null); }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const option = useMemo(() => context?.options.find(
    (candidate) => `${candidate.fromLocationId}:${candidate.productId}` === selected,
  ) ?? null, [context, selected]);
  const received = context?.requests.filter((request) => request.toLocationId === context.ownLocationId) ?? [];
  const sent = context?.requests.filter((request) => request.fromLocationId === context.ownLocationId) ?? [];

  async function submitRequest(event: React.FormEvent) {
    event.preventDefault();
    if (!online || !option) return;
    const parsedQuantity = Number(quantity);
    if (!Number.isSafeInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > option.availableQuantity || reason.trim().length < 4) return;
    setAction("request"); setError("");
    try {
      await requestSellerStockTransfer({
        fromLocationId: option.fromLocationId, productId: option.productId,
        quantity: parsedQuantity, reason: reason.trim(),
      }, requestKey.current);
      requestKey.current = operationKey("seller-transfer-request");
      setQuantity("1"); setReason("");
      showToast("Solicitação enviada ao vendedor responsável pelo estoque.", "success");
      await refresh();
    } catch (requestError) {
      const message = messageFrom(requestError); setError(message); showToast(message, "error");
    } finally { setAction(null); }
  }

  async function resolve(transfer: Transfer, resolution: ResolutionAction) {
    const decisionReason = decisionReasons[transfer.id]?.trim() ?? "";
    if (!online || decisionReason.length < 4) return;
    const actionId = `${transfer.id}:${resolution}`;
    const key = resolutionKeys.current.get(actionId) ?? operationKey(`seller-transfer-${resolution.toLowerCase()}`);
    resolutionKeys.current.set(actionId, key);
    setAction(actionId); setError("");
    try {
      await resolveSellerStockTransfer(transfer.id, resolution, decisionReason, key);
      resolutionKeys.current.delete(actionId);
      setDecisionReasons((current) => ({ ...current, [transfer.id]: "" }));
      showToast(resolution === "ACCEPT" ? "Transferência aceita e estoque movimentado." : resolution === "REJECT" ? "Solicitação recusada." : "Solicitação cancelada.", "success");
      await refresh();
    } catch (resolutionError) {
      const message = messageFrom(resolutionError); setError(message); showToast(message, "error");
    } finally { setAction(null); }
  }

  if (loading && !context) return <Card className="grid min-h-64 place-items-center p-8"><p role="status" className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-5 animate-spin" /> Carregando transferências…</p></Card>;

  return <div className="grid gap-6 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.2fr)]">
    <Card className="h-fit p-5">
      <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">Solicitar estoque</h2><p className="mt-1 text-sm leading-6 text-[var(--g-text-secondary)]">O saldo só muda depois que o vendedor de origem aceitar.</p></div><ArrowDownToLine className="size-5 text-[var(--g-focus-ring)]" /></div>
      <form aria-label="Solicitar transferência de estoque" className="mt-5 space-y-4" onSubmit={submitRequest}>
        <Field id="transfer-option" label="Produto e origem">
          <select id="transfer-option" value={selected} onChange={(event) => { setSelected(event.target.value); requestKey.current = operationKey("seller-transfer-request"); }} className="min-h-11 w-full rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] bg-[var(--g-surface-default)] px-3" disabled={!online || action !== null}>
            {context?.options.map((item) => <option key={`${item.fromLocationId}:${item.productId}`} value={`${item.fromLocationId}:${item.productId}`}>{item.productName} · {item.fromLocationName} · {item.availableQuantity} disponíveis</option>)}
          </select>
        </Field>
        <Field id="transfer-quantity" label="Quantidade">
          <Input id="transfer-quantity" type="number" inputMode="numeric" min={1} max={option?.availableQuantity ?? 1} value={quantity} onChange={(event) => { setQuantity(event.target.value); requestKey.current = operationKey("seller-transfer-request"); }} disabled={!online || !option || action !== null} />
        </Field>
        <Field id="transfer-reason" label="Motivo" description="Explique por que este estoque é necessário.">
          <textarea id="transfer-reason" rows={3} minLength={4} maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); requestKey.current = operationKey("seller-transfer-request"); }} className="w-full rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] bg-[var(--g-surface-default)] p-3 text-sm" disabled={!online || action !== null} />
        </Field>
        <Button type="submit" variant="operation" className="w-full" loading={action === "request"} disabled={!online || !option || reason.trim().length < 4 || action !== null}>Enviar solicitação</Button>
      </form>
      {!context?.options.length && <p className="mt-4 rounded-lg bg-[var(--g-surface-subtle)] p-3 text-sm text-[var(--g-text-secondary)]">Nenhum outro vendedor possui saldo disponível agora.</p>}
      {!online && <p role="status" className="mt-4 text-sm font-semibold text-[var(--g-status-warning-foreground)]">Conecte-se para solicitar ou decidir transferências.</p>}
      {error && <p role="alert" className="mt-4 text-sm text-[var(--g-status-danger)]">{error}</p>}
      <Button type="button" variant="ghost" className="mt-3 w-full" onClick={() => void refresh()} disabled={loading || action !== null}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Atualizar</Button>
    </Card>
    <div className="space-y-6">
      <TransferList title="Solicitações que você enviou" icon={ArrowDownToLine} transfers={received} ownLocationId={context?.ownLocationId ?? null} online={online} action={action} decisionReasons={decisionReasons} onReason={(id, value) => setDecisionReasons((current) => ({ ...current, [id]: value }))} onResolve={resolve} />
      <TransferList title="Solicitações para o seu estoque" icon={ArrowUpFromLine} transfers={sent} ownLocationId={context?.ownLocationId ?? null} online={online} action={action} decisionReasons={decisionReasons} onReason={(id, value) => setDecisionReasons((current) => ({ ...current, [id]: value }))} onResolve={resolve} />
      {context?.nextCursor && <Button type="button" variant="secondary" className="w-full" onClick={() => void loadOlder()} loading={action === "load-more"} disabled={action !== null}>Carregar solicitações anteriores</Button>}
    </div>
  </div>;
}

function TransferList({ title, icon: Icon, transfers, ownLocationId, online, action, decisionReasons, onReason, onResolve }: {
  title: string; icon: typeof ArrowDownToLine; transfers: Transfer[]; ownLocationId: string | null;
  online: boolean; action: string | null; decisionReasons: Record<string, string>;
  onReason: (id: string, value: string) => void; onResolve: (transfer: Transfer, action: ResolutionAction) => void;
}) {
  return <section aria-label={title}><h2 className="mb-3 flex items-center gap-2 font-semibold"><Icon className="size-5 text-[var(--g-focus-ring)]" /> {title}</h2>
    {transfers.length === 0 ? <Card className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhuma solicitação nesta lista.</Card>
      : <div className="space-y-3">{transfers.map((transfer) => {
        const pending = transfer.status === "REQUESTED";
        const sourceOwner = transfer.fromLocationId === ownLocationId;
        const reason = decisionReasons[transfer.id] ?? "";
        return <Card key={transfer.id} className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold">{transfer.productName} <span className="text-sm font-normal text-[var(--g-text-muted)]">· {transfer.quantity} un.</span></p><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{transfer.fromLocationName} → {transfer.toLocationName}</p></div><Badge tone={transfer.status === "ACCEPTED" ? "success" : transfer.status === "REQUESTED" ? "warning" : "neutral"}>{statusLabel[transfer.status]}</Badge></div>
          <p className="mt-3 text-sm"><span className="text-[var(--g-text-muted)]">Motivo:</span> {transfer.requestReason}</p>
          {transfer.decisionReason && <p className="mt-2 text-sm"><span className="text-[var(--g-text-muted)]">Decisão:</span> {transfer.decisionReason}</p>}
          {pending && <div className="mt-4 border-t border-[var(--g-border-subtle)] pt-4"><label className="text-sm font-semibold" htmlFor={`decision-${transfer.id}`}>Motivo da decisão</label><Input id={`decision-${transfer.id}`} className="mt-2" minLength={4} maxLength={500} value={reason} onChange={(event) => onReason(transfer.id, event.target.value)} placeholder={sourceOwner ? "Ex.: saldo conferido" : "Ex.: solicitação não é mais necessária"} disabled={!online || action !== null} />
            <div className="mt-3 flex flex-wrap gap-2">{sourceOwner ? <><Button type="button" size="sm" variant="operation" onClick={() => onResolve(transfer, "ACCEPT")} loading={action === `${transfer.id}:ACCEPT`} disabled={!online || reason.trim().length < 4 || action !== null}><Check className="size-4" /> Aceitar</Button><Button type="button" size="sm" variant="secondary" onClick={() => onResolve(transfer, "REJECT")} loading={action === `${transfer.id}:REJECT`} disabled={!online || reason.trim().length < 4 || action !== null}><X className="size-4" /> Recusar</Button></> : <Button type="button" size="sm" variant="secondary" onClick={() => onResolve(transfer, "CANCEL")} loading={action === `${transfer.id}:CANCEL`} disabled={!online || reason.trim().length < 4 || action !== null}><X className="size-4" /> Cancelar solicitação</Button>}</div>
          </div>}
        </Card>;
      })}</div>}
  </section>;
}
