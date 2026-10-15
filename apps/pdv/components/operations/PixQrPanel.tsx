"use client";

import type { PixChargeResponse } from "@germinatura/contracts";
import { Button } from "@germinatura/ui";
import { AlertTriangle, Check, Copy, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { PixChargeError, formatMoney, loadPixCharge } from "@/lib/operations";

type PixState =
  | { status: "loading" }
  | { status: "ready"; charge: PixChargeResponse["data"] }
  | { status: "error"; message: string; notConfigured: boolean };

/**
 * H2d: a static Pix QR (BR Code) for the amount the Portal decided, with its "copia e cola". It is a convenience for the
 * payer only: the operator still checks the PicPay Empresas app and confirms manually. The code is asked again only
 * when what decides the amount changes (the expected charge or the waiver), and the confirmation stays blocked while the
 * QR is missing, misconfigured or disagrees with the total to charge.
 */
export function PixQrPanel({ saleId, waived, expectedCents, onReady }: { saleId: string; waived: boolean; expectedCents: number; onReady: (ready: boolean) => void }) {
  const [state, setState] = useState<PixState>({ status: "loading" });
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    let active = true;
    const start = window.setTimeout(() => {
      setState({ status: "loading" });
      setCopied("idle");
      loadPixCharge(saleId, waived).then(
        (charge) => { if (active) setState({ status: "ready", charge }); },
        (error: unknown) => {
          if (!active) return;
          setState({ status: "error", message: error instanceof Error ? error.message : "Não foi possível gerar o QR Pix.", notConfigured: error instanceof PixChargeError && error.notConfigured });
        },
      );
    }, 0);
    return () => { active = false; window.clearTimeout(start); };
  }, [saleId, waived, expectedCents]);

  const mismatch = state.status === "ready" && state.charge.amountCents !== expectedCents;
  const ready = state.status === "ready" && !mismatch;
  useEffect(() => { onReady(ready); }, [ready, onReady]);

  async function copy(payload: string) {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  if (state.status === "loading") {
    return <p role="status" className="mt-5 flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Gerando o QR Pix…</p>;
  }
  if (state.status === "error") {
    return <div role="alert" className="mt-5 flex items-start gap-3 rounded-[var(--g-radius-control)] border border-[var(--g-status-danger)]/50 bg-[var(--g-surface-subtle)] p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" />
      <div><p className="font-semibold">{state.notConfigured ? "Pix indisponível neste PDV" : "Não foi possível gerar o QR Pix"}</p><p className="mt-1 text-[var(--g-text-secondary)]">{state.message}</p>
        {state.notConfigured && <p className="mt-1 text-[var(--g-text-secondary)]">Peça a um administrador para configurar o recebedor Pix. Enquanto isso, use outro meio de pagamento.</p>}</div>
    </div>;
  }
  const { charge } = state;
  return <section aria-label="Pagamento por Pix" className="mt-5 grid gap-4 rounded-[var(--g-radius-card)] border border-[var(--g-border-default)] p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="text-sm text-[var(--g-text-secondary)]">Valor do Pix</p>
      <p className="g-money text-2xl font-bold" data-testid="pix-amount">{formatMoney(charge.amountCents)}</p>
    </div>
    {charge.surchargeCents > 0 && <p className="-mt-3 text-xs text-[var(--g-text-muted)]">Produtos {formatMoney(charge.productCents)} + acréscimo Pix {formatMoney(charge.surchargeCents)}</p>}
    {charge.waived && <p className="-mt-3 text-xs text-[var(--g-text-muted)]">Acréscimo Pix removido.</p>}
    {mismatch
      ? <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">O valor do QR ({formatMoney(charge.amountCents)}) não confere com o total a cobrar ({formatMoney(expectedCents)}). Atualize a página antes de cobrar.</p>
      : <>
        <div className="justify-self-center rounded-[var(--g-radius-control)] bg-white p-3">
          <QRCodeSVG value={charge.payload} size={232} level="M" marginSize={1} title={`QR Code Pix de ${formatMoney(charge.amountCents)}`} className="h-auto w-[min(232px,70vw)]" />
        </div>
        <div className="grid gap-2">
          <label htmlFor="pix-copy-paste" className="text-sm font-semibold">Pix copia e cola</label>
          <textarea id="pix-copy-paste" readOnly value={charge.payload} rows={3} className="g-input w-full resize-none break-all p-3 font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
          <Button type="button" variant="secondary" onClick={() => void copy(charge.payload)}>
            {copied === "copied" ? <><Check className="size-4" />Código copiado</> : <><Copy className="size-4" />Copiar código Pix</>}
          </Button>
          <p aria-live="polite" className="text-xs text-[var(--g-text-muted)]">{copied === "failed" ? "Não foi possível copiar automaticamente: selecione o código e copie." : copied === "copied" ? "Cole no app do banco do cliente." : ""}</p>
        </div>
      </>}
    <p className="rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-3 text-sm"><strong>Confirme o recebimento no PicPay antes de concluir.</strong> O QR só facilita o pagamento: nada é confirmado automaticamente.</p>
  </section>;
}
