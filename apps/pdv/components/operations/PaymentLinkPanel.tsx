"use client";

import type { PaymentLinkCharge } from "@germinatura/contracts";
import { Badge, Button } from "@germinatura/ui";
import { AlertTriangle, CircleCheck, Copy, Link2, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { formatMoney, loadPaymentLink, requestPaymentLink } from "@/lib/operations";

const pollingMs = 3000;
const waiting = new Set<PaymentLinkCharge["status"]>(["REQUESTED", "ACTIVE"]);
const operationKey = () => `pdv-payment-link:${crypto.randomUUID()}`;

/**
 * ADR 0010: the seller asks for a Payment Link and shows it to the customer. The sale is confirmed only by PicPay
 * (webhook or official query), never by this screen; it just follows the status the server reports.
 */
export function PaymentLinkPanel({ saleId, totalCents, online, onPaid }: { saleId: string; totalCents: number; online: boolean; onPaid: (charge: PaymentLinkCharge) => void }) {
  const { showToast } = useToast();
  const [charge, setCharge] = useState<PaymentLinkCharge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(operationKey());
  const paidReported = useRef(false);

  useEffect(() => {
    if (!charge || !waiting.has(charge.status)) return;
    const timer = window.setTimeout(() => {
      loadPaymentLink(charge.chargeId).then(setCharge, () => undefined);
    }, pollingMs);
    return () => window.clearTimeout(timer);
  }, [charge]);

  useEffect(() => {
    if (charge?.status === "PAID" && !paidReported.current) { paidReported.current = true; onPaid(charge); }
  }, [charge, onPaid]);

  async function request() {
    setBusy(true); setError("");
    try { setCharge(await requestPaymentLink(saleId, key.current)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível pedir o link de pagamento."); }
    finally { setBusy(false); }
  }

  function retry() { key.current = operationKey(); setCharge(null); void request(); }

  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); showToast(`${label} copiado.`, "success"); }
    catch { setError("Não foi possível copiar. Selecione o texto e copie manualmente."); }
  }

  const link = charge?.checkoutUrl && /^https:\/\//.test(charge.checkoutUrl) ? charge.checkoutUrl : null;
  return <section aria-label="Link de pagamento" className="mt-5 grid gap-4">
    {!charge && <>
      <p className="text-sm leading-6 text-[var(--g-text-secondary)]">O cliente paga {formatMoney(totalCents)} por Pix, carteira PicPay ou cartão no próprio celular. A venda é confirmada automaticamente quando o PicPay avisar o pagamento.</p>
      <Button variant="operation" size="lg" className="w-full" onClick={() => void request()} loading={busy} disabled={!online || busy}><Link2 className="size-4" /> Gerar link de pagamento</Button>
    </>}
    {charge?.status === "REQUESTED" && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Gerando o link no PicPay…</p>}
    {charge?.status === "ACTIVE" && link && <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
      <div className="justify-self-center rounded-[var(--g-radius-control)] bg-white p-3"><QRCodeSVG value={link} size={176} aria-label="QR Code do link de pagamento" /></div>
      <div className="grid gap-3 text-sm">
        <Badge tone="info">Aguardando pagamento</Badge>
        <p className="leading-6 text-[var(--g-text-secondary)]">Peça ao cliente para ler o QR Code ou envie o link. Esta tela atualiza sozinha quando o PicPay confirmar.</p>
        <code className="break-all rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-2 text-xs">{link}</code>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => void copy(link, "Link")}><Copy className="size-4" /> Copiar link</Button>
          {charge.brcode && <Button type="button" size="sm" variant="secondary" onClick={() => void copy(charge.brcode ?? "", "Pix copia e cola")}><Copy className="size-4" /> Pix copia e cola</Button>}
        </div>
        <p role="status" className="flex items-center gap-2 text-xs text-[var(--g-text-muted)]"><Loader2 className="size-3 animate-spin" /> Consultando o pagamento…</p>
      </div>
    </div>}
    {charge?.status === "PAID" && <p role="status" className="flex items-center gap-2 font-semibold text-[var(--g-status-success-foreground)]"><CircleCheck className="size-5" /> Pagamento confirmado pelo PicPay.</p>}
    {charge?.status === "FAILED" && <div role="alert" className="grid gap-3 text-sm">
      <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--g-status-danger)]" /> O PicPay recusou a criação do link. Tente de novo ou use outro meio de pagamento.</p>
      <Button type="button" variant="secondary" onClick={retry} disabled={!online || busy}>Pedir novo link</Button>
    </div>}
    {charge?.status === "UNCERTAIN" && <div role="alert" className="flex items-start gap-2 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--g-status-warning)]" /><p>O PicPay não respondeu e não sabemos se o link foi criado. Por segurança, nenhum outro link será gerado para esta venda: use outro meio de pagamento. O financeiro vai conferir.</p></div>}
    {charge?.status === "INACTIVE" && <p role="status" className="text-sm text-[var(--g-text-secondary)]">Este link foi inativado porque a venda não aguarda mais pagamento.</p>}
    {error && <p role="alert" className="flex items-start gap-2 text-sm text-[var(--g-status-danger)]"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</p>}
  </section>;
}

export function PaymentLinkSuccess({ charge, onNewSale }: { charge: PaymentLinkCharge; onNewSale: () => void }) {
  return <div className="mx-auto max-w-2xl"><div className="overflow-hidden rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)] bg-[var(--g-surface-default)] text-center">
    <div className="bg-[var(--g-status-success-soft)] p-8 text-[var(--g-status-success-foreground)]"><div className="mx-auto grid size-16 place-items-center rounded-full bg-[var(--g-operation-primary)] text-[var(--g-operation-on-primary)]"><CircleCheck className="size-9" /></div><h2 className="mt-4 text-2xl font-bold">Pagamento confirmado</h2><p className="mt-2 text-sm">Confirmado pelo PicPay; estoque e financeiro já foram registrados.</p></div>
    <div className="p-6 text-left"><div className="flex items-baseline justify-between border-b border-[var(--g-border-subtle)] pb-5"><span className="text-sm text-[var(--g-text-secondary)]">Total recebido</span><strong className="g-money text-2xl">{formatMoney(charge.amountCents)}</strong></div>
      <dl className="grid gap-4 py-5 text-sm sm:grid-cols-2"><div><dt className="text-[var(--g-text-muted)]">Canal</dt><dd className="mt-1 font-semibold">Link de pagamento</dd></div><div><dt className="text-[var(--g-text-muted)]">Pedido PicPay</dt><dd className="mt-1 font-mono text-xs">{charge.orderNumber}</dd></div><div><dt className="text-[var(--g-text-muted)]">Venda</dt><dd className="mt-1 font-mono text-xs">{charge.saleId}</dd></div></dl>
      <Button variant="brand" size="lg" className="w-full" onClick={onNewSale}>Iniciar nova venda</Button></div>
  </div></div>;
}
