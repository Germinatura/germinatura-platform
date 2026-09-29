"use client";

import { paymentLinkChargeResponseSchema, type PaymentLinkCharge } from "@germinatura/contracts";
import { Badge, Button, Card } from "@germinatura/ui";
import { CircleAlert, CircleCheck, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const pollingMs = 3000;

/**
 * ADR 0010: follows an online payment. Coming back from PicPay confirms nothing; the page only shows what the
 * server knows, and the server only learns it from PicPay (webhook or official query).
 */
export function PaymentLinkTracker({ chargeId }: { chargeId: string }) {
  const [charge, setCharge] = useState<PaymentLinkCharge | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/payments/payment-links/${chargeId}`, { cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 404 ? "Pagamento não encontrado." : "Não foi possível consultar o pagamento agora.");
        const parsed = paymentLinkChargeResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
        if (cancelled) return;
        setCharge(parsed.data.data); setError("");
        if (["REQUESTED", "ACTIVE", "UNCERTAIN"].includes(parsed.data.data.status)) timer = window.setTimeout(() => void poll(), pollingMs);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Não foi possível consultar o pagamento agora.");
        timer = window.setTimeout(() => void poll(), pollingMs * 3);
      }
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [chargeId]);

  const link = charge?.checkoutUrl && /^https:\/\//.test(charge.checkoutUrl) ? charge.checkoutUrl : null;
  return <Card className="mx-auto grid max-w-xl gap-5 p-6">
    {!charge && !error && <p role="status" className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Consultando o pagamento…</p>}
    {charge && <div className="flex items-baseline justify-between gap-3"><span className="text-sm text-[var(--g-text-secondary)]">Total</span><strong className="g-money text-2xl">{money.format(charge.amountCents / 100)}</strong></div>}
    {charge?.status === "REQUESTED" && <p role="status" className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Preparando o pagamento no PicPay…</p>}
    {charge?.status === "ACTIVE" && link && <div className="grid gap-4">
      <Badge tone="info">Aguardando pagamento</Badge>
      <p className="text-sm leading-6 text-[var(--g-text-secondary)]">Pague por Pix, carteira PicPay ou cartão na página segura do PicPay. Depois de pagar, volte aqui: a confirmação aparece sozinha quando o PicPay avisar.</p>
      <a href={link} rel="noopener noreferrer" className="g-button g-button--brand g-button--lg inline-flex items-center justify-center gap-2"><ExternalLink className="size-4" /> Pagar com PicPay</a>
      <div className="justify-self-center rounded-[var(--g-radius-control)] bg-white p-3"><QRCodeSVG value={link} size={160} aria-label="QR Code do pagamento" /></div>
      <p role="status" className="flex items-center gap-2 text-xs text-[var(--g-text-muted)]"><Loader2 className="size-3 animate-spin" /> Aguardando a confirmação do PicPay…</p>
    </div>}
    {charge?.status === "PAID" && <div className="grid gap-3 text-center">
      <CircleCheck className="mx-auto size-12 text-[var(--g-status-success-foreground)]" />
      <h2 className="text-2xl font-bold">Pagamento confirmado</h2>
      <p className="text-sm text-[var(--g-text-secondary)]">O PicPay confirmou o pagamento. Pedido {charge.orderNumber}.</p>
      <Link href="/reservas" className="text-sm font-semibold underline">Ver minhas reservas</Link>
    </div>}
    {charge?.status === "UNCERTAIN" && <p role="status" className="flex items-start gap-2 text-sm"><CircleAlert className="mt-0.5 size-4 shrink-0 text-[var(--g-status-warning)]" /> Estamos confirmando com o PicPay se o pagamento foi preparado. Não pague de novo; a comissão vai conferir e esta página atualiza sozinha.</p>}
    {charge?.status === "FAILED" && <div role="alert" className="grid gap-3 text-sm"><p className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0 text-[var(--g-status-danger)]" /> O PicPay não conseguiu preparar este pagamento.</p><Link href="/reservas"><Button variant="secondary">Voltar às reservas e tentar de novo</Button></Link></div>}
    {charge?.status === "INACTIVE" && <p role="status" className="text-sm text-[var(--g-text-secondary)]">Este pagamento não está mais disponível: a reserva expirou, foi cancelada ou já foi paga de outra forma.</p>}
    {error && <p role="alert" className="flex items-start gap-2 text-sm text-[var(--g-status-danger)]"><CircleAlert className="mt-0.5 size-4 shrink-0" /> {error}</p>}
  </Card>;
}
