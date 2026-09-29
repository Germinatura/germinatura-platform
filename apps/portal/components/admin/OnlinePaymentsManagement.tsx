"use client";

import {
  onlinePaymentsAdminResponseSchema,
  type AdminPaymentLink, type AdminPaymentLinkRefund, type PaymentRecoveryItem, type PaymentRecoveryKind,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const cents = (value: number | null) => value === null ? "—" : money.format(value / 100);

const kindLabels: Record<PaymentRecoveryKind, string> = {
  UNKNOWN_LINK: "Link desconhecido", AMOUNT_MISMATCH: "Valor divergente", LATE_PAYMENT: "Pagamento tardio",
  DUPLICATE_PAYMENT: "Pagamento em duplicidade", UNCERTAIN_CREATION: "Criação incerta", REFUND_CONFIRMED: "Estorno confirmado",
  UNMATCHED_REFUND: "Estorno sem link", UNSUPPORTED_EVENT: "Formato desconhecido", APPLY_FAILED: "Falha ao aplicar",
  INACTIVATION_FAILED: "Inativação falhou", REFUND_UNCERTAIN: "Estorno incerto",
};
const linkLabels: Record<AdminPaymentLink["status"], string> = {
  REQUESTED: "Gerando", ACTIVE: "Aguardando pagamento", FAILED: "Recusado", UNCERTAIN: "Incerto", PAID: "Pago", INACTIVE: "Inativado",
};
const refundLabels: Record<AdminPaymentLinkRefund["status"], string> = {
  REQUESTED: "Na fila", ACCEPTED: "Aceito, aguardando PicPay", CONFIRMED: "Confirmado", FAILED: "Recusado", UNCERTAIN: "Incerto",
};
const refundable = new Set<PaymentRecoveryKind>(["DUPLICATE_PAYMENT", "LATE_PAYMENT", "AMOUNT_MISMATCH", "UNKNOWN_LINK"]);
const replayable = new Set<PaymentRecoveryKind>(["UNKNOWN_LINK", "APPLY_FAILED", "UNMATCHED_REFUND", "AMOUNT_MISMATCH", "LATE_PAYMENT"]);

type Action =
  | { kind: "resolve"; item: PaymentRecoveryItem }
  | { kind: "refund"; transactionId: string; amountCents: number; recoveryItemId: string | null; label: string }
  | { kind: "reconcile-link"; chargeId: string; label: string }
  | { kind: "reconcile-refund"; refund: AdminPaymentLinkRefund };

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/** ADR 0010 (PAY-004, PAY-007): everything online payments leave for finance to decide, with audited actions. */
export function OnlinePaymentsManagement() {
  const { showToast } = useToast();
  const [recoveryStatus, setRecoveryStatus] = useState<"OPEN" | "RESOLVED">("OPEN");
  const [recovery, setRecovery] = useState<PaymentRecoveryItem[]>([]);
  const [links, setLinks] = useState<AdminPaymentLink[]>([]);
  const [refunds, setRefunds] = useState<AdminPaymentLinkRefund[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/admin/finance/online-payments?recovery=${recoveryStatus}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar os pagamentos online."));
      const parsed = onlinePaymentsAdminResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setRecovery(parsed.data.data.recovery); setLinks(parsed.data.data.links); setRefunds(parsed.data.data.refunds); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar os pagamentos online."); }
    finally { setLoading(false); }
  }, [recoveryStatus]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  // A fingerprint reuses the key for retries of the same action; null always sends a new one (replays).
  async function submit(path: string, body: unknown, fingerprint: string | null, success: string) {
    const key = (fingerprint && keys.current.get(fingerprint)) || `online-payment:${crypto.randomUUID()}`;
    if (fingerprint) keys.current.set(fingerprint, key);
    setBusy(true); setError("");
    try {
      const response = await fetch(path, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: body === null ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível concluir a ação."));
      showToast(success, "success"); setAction(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível concluir a ação."); }
    finally { setBusy(false); }
  }

  const replay = (item: PaymentRecoveryItem) => item.receiptId && void submit(
    `/api/v1/admin/finance/online-payments/receipts/${item.receiptId}/replay`, null, null, "Evento reprocessado.");

  return <div className="grid gap-6">
    {error && <div role="alert" className="flex items-start gap-2 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    {action && <ActionPanel action={action} busy={busy} onCancel={() => setAction(null)} onSubmit={submit} />}

    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--g-border-subtle)] p-5">
        <div><h2 className="font-semibold">Recuperação</h2><p className="text-sm text-[var(--g-text-secondary)]">Eventos que não viraram receita automaticamente e aguardam decisão.</p></div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant={recoveryStatus === "OPEN" ? "secondary" : "ghost"} aria-pressed={recoveryStatus === "OPEN"} onClick={() => setRecoveryStatus("OPEN")}>Abertos</Button>
          <Button type="button" size="sm" variant={recoveryStatus === "RESOLVED" ? "secondary" : "ghost"} aria-pressed={recoveryStatus === "RESOLVED"} onClick={() => setRecoveryStatus("RESOLVED")}>Resolvidos</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void load()} aria-label="Atualizar"><RefreshCw className="size-4" /></Button>
        </div>
      </div>
      {loading ? <p role="status" className="flex items-center gap-2 p-5 text-sm"><Loader2 className="size-4 animate-spin" />Carregando…</p>
        : recovery.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">{recoveryStatus === "OPEN" ? "Nada pendente." : "Nenhum item resolvido ainda."}</p>
        : <ul aria-label="Itens de recuperação" className="divide-y divide-[var(--g-border-subtle)]">{recovery.map((item) => <li key={item.id} aria-label={`Recuperação ${kindLabels[item.kind]}`} className="grid gap-2 p-5 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={item.status === "OPEN" ? "warning" : "success"}>{kindLabels[item.kind]}</Badge><span className="font-semibold">{cents(item.amountCents)}</span><span className="text-xs text-[var(--g-text-muted)]">{dateTime.format(new Date(item.openedAt))}</span></div>
          <p>{item.detail}</p>
          {item.transactionId && <p className="text-xs text-[var(--g-text-muted)]">Transação PicPay: <code>{item.transactionId}</code></p>}
          {item.status === "RESOLVED" ? <p className="text-xs text-[var(--g-text-muted)]">Resolvido{item.resolvedByName ? ` por ${item.resolvedByName}` : ""}: {item.resolutionNote}</p>
            : <div className="flex flex-wrap gap-2">
              {item.receiptId && replayable.has(item.kind) && <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => replay(item)}>Reprocessar evento</Button>}
              {item.transactionId && item.amountCents && refundable.has(item.kind) && <Button type="button" size="sm" variant="secondary" disabled={busy}
                onClick={() => setAction({ kind: "refund", transactionId: item.transactionId ?? "", amountCents: item.amountCents ?? 0, recoveryItemId: item.id, label: kindLabels[item.kind] })}>Pedir estorno</Button>}
              {item.kind === "UNCERTAIN_CREATION" && item.chargeId && <Button type="button" size="sm" variant="secondary" disabled={busy}
                onClick={() => setAction({ kind: "reconcile-link", chargeId: item.chargeId ?? "", label: cents(item.amountCents) })}>Reconciliar link</Button>}
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setAction({ kind: "resolve", item })}>Resolver com justificativa</Button>
            </div>}
        </li>)}</ul>}
    </Card>

    <Card className="overflow-hidden">
      <div className="border-b border-[var(--g-border-subtle)] p-5"><h2 className="font-semibold">Links de pagamento recentes</h2></div>
      {links.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhum link gerado.</p>
        : <ul aria-label="Links de pagamento" className="divide-y divide-[var(--g-border-subtle)]">{links.map((link) => <li key={link.chargeId} aria-label={`Link ${link.orderNumber}`} className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm">
          <div className="min-w-0"><p className="font-mono text-xs">{link.orderNumber}</p><p className="text-xs text-[var(--g-text-muted)]">{link.requestedByName} · {dateTime.format(new Date(link.createdAt))} · venda {link.saleStatus.toLowerCase()}{link.errorCode ? ` · ${link.errorCode}` : ""}{link.inactivationPending ? " · inativação pendente" : ""}</p></div>
          <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{cents(link.amountCents)}</span><Badge tone={link.status === "PAID" ? "success" : link.status === "UNCERTAIN" || link.status === "FAILED" ? "warning" : "neutral"}>{linkLabels[link.status]}</Badge>
            {link.status === "PAID" && link.paidTransactionId && <Button type="button" size="sm" variant="ghost" disabled={busy}
              onClick={() => setAction({ kind: "refund", transactionId: link.paidTransactionId ?? "", amountCents: link.amountCents, recoveryItemId: null, label: link.orderNumber })}>Estornar</Button>}</div>
        </li>)}</ul>}
    </Card>

    <Card className="overflow-hidden">
      <div className="border-b border-[var(--g-border-subtle)] p-5"><h2 className="font-semibold">Estornos pelo PicPay</h2><p className="text-sm text-[var(--g-text-secondary)]">Só o aviso de estorno do PicPay confirma a devolução.</p></div>
      {refunds.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhum estorno pedido.</p>
        : <ul aria-label="Estornos" className="divide-y divide-[var(--g-border-subtle)]">{refunds.map((refund) => <li key={refund.refundId} aria-label={`Estorno ${refund.transactionId}`} className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm">
          <div className="min-w-0"><p>{refund.reason}</p><p className="text-xs text-[var(--g-text-muted)]">{refund.requestedByName} · {dateTime.format(new Date(refund.createdAt))} · <code>{refund.transactionId}</code>{refund.errorCode ? ` · ${refund.errorCode}` : ""}</p></div>
          <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{cents(refund.amountCents)}</span><Badge tone={refund.status === "CONFIRMED" ? "success" : refund.status === "UNCERTAIN" || refund.status === "FAILED" ? "warning" : "neutral"}>{refundLabels[refund.status]}</Badge>
            {refund.status === "UNCERTAIN" && <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setAction({ kind: "reconcile-refund", refund })}>Reconciliar</Button>}</div>
        </li>)}</ul>}
    </Card>
  </div>;
}

function ActionPanel({ action, busy, onCancel, onSubmit }: {
  action: Action; busy: boolean; onCancel: () => void;
  onSubmit: (path: string, body: unknown, fingerprint: string | null, success: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState(action.kind === "refund" ? (action.amountCents / 100).toFixed(2).replace(".", ",") : "");
  const [found, setFound] = useState<"yes" | "no" | "">("");
  const [providerLinkId, setProviderLinkId] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState("");
  const [processed, setProcessed] = useState<"yes" | "no" | "">("");
  const amountCents = Math.round(Number(amount.replace(/\./g, "").replace(",", ".")) * 100);
  const noteOk = note.trim().length >= 3;

  let title = ""; let ready = false; let run = () => Promise.resolve();
  if (action.kind === "resolve") {
    title = `Resolver: ${kindLabels[action.item.kind]}`; ready = noteOk;
    run = () => onSubmit(`/api/v1/admin/finance/online-payments/recovery/${action.item.id}/resolve`, { note: note.trim() }, `resolve:${action.item.id}:${note.trim()}`, "Item resolvido.");
  } else if (action.kind === "refund") {
    title = `Pedir estorno ao PicPay (${action.label})`; ready = noteOk && Number.isSafeInteger(amountCents) && amountCents >= 1 && amountCents <= action.amountCents;
    const body = { transactionId: action.transactionId, amountCents, reason: note.trim(), recoveryItemId: action.recoveryItemId };
    run = () => onSubmit("/api/v1/admin/finance/online-payments/refunds", body, `refund:${JSON.stringify(body)}`, "Estorno pedido; o worker envia ao PicPay.");
  } else if (action.kind === "reconcile-link") {
    title = `Reconciliar link incerto (${action.label})`;
    ready = noteOk && (found === "no" || (found === "yes" && /^[A-Za-z0-9-]{8,64}$/.test(providerLinkId.trim()) && /^https:\/\/\S+$/.test(checkoutUrl.trim())));
    const body = found === "yes" ? { providerLinkId: providerLinkId.trim(), checkoutUrl: checkoutUrl.trim(), note: note.trim() } : { providerLinkId: null, checkoutUrl: null, note: note.trim() };
    run = () => onSubmit(`/api/v1/admin/finance/online-payments/links/${action.chargeId}/reconcile`, body, `reconcile-link:${action.chargeId}:${JSON.stringify(body)}`, "Link reconciliado.");
  } else {
    title = "Reconciliar estorno incerto"; ready = noteOk && processed !== "";
    const body = { processed: processed === "yes", note: note.trim() };
    run = () => onSubmit(`/api/v1/admin/finance/online-payments/refunds/${action.refund.refundId}/reconcile`, body, `reconcile-refund:${action.refund.refundId}:${JSON.stringify(body)}`, "Estorno reconciliado.");
  }

  return <Card className="p-5">
    <form aria-label={title} className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (ready && !busy) void run(); }}>
      <h2 className="font-semibold">{title}</h2>
      {action.kind === "refund" && <Field id="refund-amount" label="Valor do estorno (R$)" description={`Até ${cents(action.amountCents)}.`}><Input id="refund-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>}
      {action.kind === "reconcile-link" && <fieldset className="grid gap-2 text-sm"><legend className="font-semibold">O link existe no painel PicPay?</legend>
        <label className="flex items-center gap-2"><input type="radio" name="found" checked={found === "yes"} onChange={() => setFound("yes")} />Sim, encontrei o link</label>
        <label className="flex items-center gap-2"><input type="radio" name="found" checked={found === "no"} onChange={() => setFound("no")} />Não, ele não foi criado</label>
        {found === "yes" && <div className="grid gap-3 sm:grid-cols-2"><Field id="link-id" label="ID do link"><Input id="link-id" value={providerLinkId} onChange={(event) => setProviderLinkId(event.target.value)} /></Field><Field id="link-url" label="Link (https://…)"><Input id="link-url" value={checkoutUrl} onChange={(event) => setCheckoutUrl(event.target.value)} /></Field></div>}
      </fieldset>}
      {action.kind === "reconcile-refund" && <fieldset className="grid gap-2 text-sm"><legend className="font-semibold">O estorno aparece no painel PicPay?</legend>
        <label className="flex items-center gap-2"><input type="radio" name="processed" checked={processed === "yes"} onChange={() => setProcessed("yes")} />Sim, aguardar a confirmação do PicPay</label>
        <label className="flex items-center gap-2"><input type="radio" name="processed" checked={processed === "no"} onChange={() => setProcessed("no")} />Não, pode ser pedido de novo</label>
      </fieldset>}
      <Field id="action-note" label={action.kind === "refund" ? "Motivo do estorno" : "Justificativa"}><Input id="action-note" maxLength={action.kind === "refund" ? 300 : 500} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
      <div className="flex flex-wrap gap-2"><Button type="submit" loading={busy} disabled={!ready || busy}>Confirmar</Button><Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancelar</Button></div>
    </form>
  </Card>;
}
