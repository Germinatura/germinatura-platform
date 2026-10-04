"use client";

import {
  adminSaleDetailResponseSchema,
  adminSalesResponseSchema,
  adminSellerShiftsResponseSchema,
  confirmedSaleReversalRequestSchema,
  salesCancelResponseSchema,
  type AdminSale,
  type AdminSaleDetail,
  type AdminSellerShift,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const formatMoney = (cents: number) => money.format(cents / 100);
const formatDate = (value: string) => dateTime.format(new Date(value));

const statusLabels: Record<string, string> = { AWAITING_PAYMENT: "Aguardando pagamento", CONFIRMED: "Concluída", CANCELLED: "Cancelada" };
const channelLabels: Record<string, string> = { PDV: "PDV", PORTAL: "Portal", RESERVA: "Reserva" };
const methodLabels: Record<string, string> = {
  DINHEIRO: "Dinheiro", MAQUININHA: "Maquininha", PIX_AREA: "Área Pix", TAP: "PicPay Tap",
  PAYMENT_LINK: "Link de pagamento", CHECKOUT_API: "Checkout PicPay", PICPAY_WALLET: "Carteira PicPay",
  CREDITO: "Crédito", DEBITO: "Débito", VOUCHER_ALIMENTACAO: "Vale-alimentação", VOUCHER_REFEICAO: "Vale-refeição",
};
const ledgerLabels: Record<string, string> = {
  RECEIVABLE_PICPAY: "Recebível PicPay", CASH_RECEIPT: "Recebimento em dinheiro", FEE: "Taxa", SETTLEMENT: "Liquidação",
  REFUND: "Estorno", DIVERGENCE: "Divergência",
};
const movementLabels: Record<string, string> = { SALE_RECEIPT: "Entrada no caixa", REFUND_PAYOUT: "Devolução em dinheiro", OPENING_FLOAT: "Fundo de troco" };
const blockedLabels: Record<string, string> = {
  SALE_NOT_CONFIRMED: "Só vendas concluídas podem ser estornadas.",
  PAID_RAFFLE_REVERSAL_REQUIRED: "Venda de rifa paga exige a reversão específica de rifas.",
  RAFFLE_CLOSED_REFUND_REQUIRES_CANCELLATION: "Rifa encerrada: o estorno só é possível cancelando a rifa inteira antes do sorteio.",
  RAFFLE_ALREADY_DRAWN: "Rifa já sorteada: nenhuma venda pode ser estornada.",
  PAYMENT_ATTEMPT_NOT_REFUNDABLE: "O pagamento desta venda não pode ser estornado.",
};

function paymentLine(payment: AdminSale["payment"]) {
  if (!payment?.integrationChannel) return "Sem pagamento";
  return [payment.integrationChannel, payment.cardMethod, payment.terminalCode]
    .filter((value): value is string => Boolean(value)).map((value) => methodLabels[value] ?? value).join(" · ");
}

function statusBadge(sale: AdminSale) {
  if (sale.pendingReason === "RECONCILIATION_PENDING") return <Badge tone="warning">Pendente de conciliação</Badge>;
  if (sale.status === "AWAITING_PAYMENT") return <Badge tone="warning">Aguardando pagamento</Badge>;
  if (sale.status === "CANCELLED") return <Badge tone={sale.payment?.status === "REFUNDED" ? "danger" : "neutral"}>{sale.payment?.status === "REFUNDED" ? "Estornada" : "Cancelada"}</Badge>;
  return <Badge tone="success">{statusLabels[sale.status]}</Badge>;
}

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

type Filters = { status: string; channel: string; pending: boolean; from: string; to: string };

/** Etapa 6: finance reviews every sale and reverses confirmed ones, handing cash back from an open drawer when needed. */
export function FinanceSalesManagement() {
  const [filters, setFilters] = useState<Filters>({ status: "", channel: "", pending: false, from: "", to: "" });
  const [sales, setSales] = useState<AdminSale[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openSale, setOpenSale] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.channel) params.set("channel", filters.channel);
      if (filters.pending) params.set("pending", "true");
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/v1/admin/finance/sales?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar as vendas."));
      const parsed = adminSalesResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setSales((current) => cursor ? [...current, ...parsed.data.data] : parsed.data.data);
      setNextCursor(parsed.data.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar as vendas."); }
    finally { setLoading(false); }
  }, [filters]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [load]);

  return <div className="grid gap-6">
    <Card className="p-5">
      <form aria-label="Filtrar vendas" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <Field id="sales-status" label="Situação"><select id="sales-status" className="g-input min-h-11 w-full" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">Todas</option><option value="AWAITING_PAYMENT">Aguardando pagamento</option><option value="CONFIRMED">Concluídas</option><option value="CANCELLED">Canceladas</option></select></Field>
        <Field id="sales-channel" label="Canal"><select id="sales-channel" className="g-input min-h-11 w-full" value={filters.channel} onChange={(event) => setFilters({ ...filters, channel: event.target.value })}><option value="">Todos</option><option value="PDV">PDV</option><option value="PORTAL">Portal</option><option value="RESERVA">Reserva</option></select></Field>
        <Field id="sales-from" label="De"><Input id="sales-from" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></Field>
        <Field id="sales-to" label="Até"><Input id="sales-to" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></Field>
        <div className="flex items-center justify-between gap-3 lg:flex-col lg:items-start">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.pending} onChange={(event) => setFilters({ ...filters, pending: event.target.checked })} />Só pendentes</label>
          <Button type="submit" size="sm" variant="ghost" disabled={loading}><RefreshCw className="size-4" />Atualizar</Button>
        </div>
      </form>
    </Card>
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    <Card className="overflow-hidden">
      {loading && sales.length === 0 ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando vendas…</p>
        : sales.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhuma venda com estes filtros.</p>
        : <ul aria-label="Vendas" className="divide-y divide-[var(--g-border-subtle)]">
          {sales.map((sale) => <li key={sale.saleId} aria-label={`Venda ${sale.saleId}`} className={sale.pendingReason ? "bg-[var(--g-status-warning-soft)]" : undefined}>
            <button type="button" aria-expanded={openSale === sale.saleId} onClick={() => setOpenSale(openSale === sale.saleId ? null : sale.saleId)} className="flex w-full flex-wrap items-center justify-between gap-3 p-5 text-left hover:bg-[var(--g-surface-hover)]">
              <span className="min-w-0">
                <span className="g-money block text-lg font-bold">{formatMoney(sale.totalCents)}</span>
                <span className="block text-sm text-[var(--g-text-secondary)]">{formatDate(sale.createdAt)} · {channelLabels[sale.channel] ?? sale.channel} · {sale.sellerName} · {paymentLine(sale.payment)}</span>
              </span>
              <span className="flex items-center gap-2">{statusBadge(sale)}{openSale === sale.saleId ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</span>
            </button>
            {openSale === sale.saleId && <SaleDetail saleId={sale.saleId} onChanged={() => void load()} />}
          </li>)}
        </ul>}
    </Card>
    {nextCursor && <Button type="button" variant="secondary" loading={loading} onClick={() => void load(nextCursor)}>Carregar mais</Button>}
  </div>;
}

function SaleDetail({ saleId, onChanged }: { saleId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<AdminSaleDetail | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`/api/v1/admin/finance/sales/${saleId}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar a venda."));
      const parsed = adminSaleDetailResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A venda retornou dados inválidos.");
      setDetail(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar a venda."); }
  }, [saleId]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  if (error) return <p role="alert" className="px-5 pb-5 text-sm text-[var(--g-status-danger)]">{error}</p>;
  if (!detail) return <p role="status" className="px-5 pb-5 text-sm text-[var(--g-text-secondary)]">Carregando detalhes…</p>;
  return <div className="grid gap-5 border-t border-[var(--g-border-subtle)] bg-[var(--g-surface-default)] p-5 lg:grid-cols-2">
    <section aria-label="Itens"><h3 className="text-sm font-semibold">Itens</h3><ul className="mt-2 space-y-1 text-sm">{detail.items.map((item) => <li key={item.productSku} className="flex justify-between gap-3"><span>{item.quantity}× {item.productName}{item.discountCents > 0 ? ` (desconto ${formatMoney(item.discountCents)})` : ""}</span><span className="g-money">{formatMoney(item.totalCents)}</span></li>)}</ul>
      <p className="mt-2 text-xs text-[var(--g-text-muted)]">{detail.locationName} · venda {detail.saleId}</p></section>
    {detail.raffle && <section aria-label="Rifa" className="lg:col-span-2"><h3 className="text-sm font-semibold">Rifa</h3><p className="mt-2 text-sm">{detail.raffle.campaignName} · números <span className="g-money font-semibold">{detail.raffle.numbers.join(", ")}</span></p></section>}
    <section aria-label="Pagamento"><h3 className="text-sm font-semibold">Pagamento</h3><p className="mt-2 text-sm">{paymentLine(detail.payment)}{detail.payment?.proofReference ? ` · ref. ${detail.payment.proofReference}` : ""}</p>
      {detail.payment?.confirmedAt && <p className="text-xs text-[var(--g-text-muted)]">Confirmado em {formatDate(detail.payment.confirmedAt)}</p>}</section>
    <section aria-label="Lançamentos financeiros"><h3 className="text-sm font-semibold">Lançamentos</h3><ul className="mt-2 space-y-1 text-sm">{detail.ledger.length === 0 ? <li className="text-[var(--g-text-muted)]">Nenhum lançamento.</li> : detail.ledger.map((entry) => <li key={entry.id} className="flex justify-between gap-3"><span>{ledgerLabels[entry.entryType] ?? entry.entryType}{entry.refundMethod ? ` (${entry.refundMethod === "CASH_DRAWER" ? "dinheiro do caixa" : "outro meio"})` : ""}{entry.reference ? ` · ${entry.reference}` : ""}</span><span className="g-money">{formatMoney(entry.amountCents)}</span></li>)}</ul>
      {detail.cashMovements.length > 0 && <ul aria-label="Movimentos de caixa" className="mt-3 space-y-1 text-sm">{detail.cashMovements.map((movement) => <li key={movement.id} className="flex justify-between gap-3"><span>{movementLabels[movement.movementType]} · turno {movement.shiftId.slice(0, 8)}</span><span className="g-money">{formatMoney(movement.amountCents)}</span></li>)}</ul>}</section>
    <section aria-label="Histórico"><h3 className="text-sm font-semibold">Histórico</h3><ul className="mt-2 space-y-1 text-sm">{detail.history.map((entry) => <li key={`${entry.toStatus}-${entry.createdAt}`}>{formatDate(entry.createdAt)} · {statusLabels[entry.toStatus] ?? entry.toStatus}{entry.reason ? ` — ${entry.reason}` : ""}</li>)}</ul></section>
    <div className="lg:col-span-2">{detail.reversal.allowed
      ? <ReversalForm detail={detail} onDone={() => { void load(); onChanged(); }} />
      : detail.status === "CONFIRMED" && detail.reversal.blockedReason ? <p className="text-sm text-[var(--g-text-secondary)]">{blockedLabels[detail.reversal.blockedReason] ?? "Esta venda não pode ser estornada."}</p> : null}</div>
  </div>;
}

function ReversalForm({ detail, onDone }: { detail: AdminSaleDetail; onDone: () => void }) {
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState<"OTHER" | "CASH_DRAWER">("OTHER");
  const [shifts, setShifts] = useState<AdminSellerShift[] | null>(null);
  const [shiftId, setShiftId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());

  useEffect(() => {
    if (method !== "CASH_DRAWER" || shifts !== null) return;
    void fetch("/api/v1/admin/finance/shifts?status=OPEN", { cache: "no-store" }).then(async (response) => {
      const parsed = adminSellerShiftsResponseSchema.safeParse(await response.json().catch(() => null));
      setShifts(response.ok && parsed.success ? parsed.data.data : []);
    }, () => setShifts([]));
  }, [method, shifts]);

  const payload = { reason: reason.trim(), refundReference: reference.trim(), ...(method === "CASH_DRAWER" && shiftId ? { cashPayoutShiftId: shiftId } : {}) };
  const valid = confirmedSaleReversalRequestSchema.safeParse(payload).success && (method === "OTHER" || shiftId !== "");

  async function submit() {
    if (!valid) return;
    const fingerprint = JSON.stringify(payload);
    const key = keys.current.get(fingerprint) ?? `finance-reverse:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/sales/${detail.saleId}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível estornar a venda."));
      if (!salesCancelResponseSchema.safeParse(await response.json()).success) throw new Error("O estorno retornou dados inválidos.");
      showToast(method === "CASH_DRAWER" ? "Venda estornada e devolução registrada no caixa." : "Venda estornada.", "success");
      onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível estornar a venda."); setConfirming(false); }
    finally { setBusy(false); }
  }

  return <form aria-label="Estornar venda" className="grid gap-4 rounded-[var(--g-radius-card)] border border-[var(--g-border-default)] p-4" onSubmit={(event) => { event.preventDefault(); if (confirming) void submit(); else if (valid) setConfirming(true); }}>
    <h3 className="font-semibold">Estornar venda</h3>
    <p className="text-sm text-[var(--g-text-secondary)]">{detail.raffle ? "Os números saem do sorteio (e voltam ao quadro se a rifa estiver aberta)" : "O estoque volta ao local da venda"} e o lançamento de estorno fica vinculado ao pagamento original, que não é alterado.</p>
    {detail.payment?.integrationChannel === "PAYMENT_LINK" && <p className="text-sm text-[var(--g-text-secondary)]">Pago pelo link de pagamento: peça a devolução ao PicPay em Financeiro › Pagamentos online e use aqui a referência desse pedido.</p>}
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id={`reversal-reason-${detail.saleId}`} label="Motivo"><Input id={`reversal-reason-${detail.saleId}`} minLength={8} maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); setConfirming(false); }} /></Field>
      <Field id={`reversal-reference-${detail.saleId}`} label="Referência do estorno" description="Identificador não sensível (nunca número de cartão)."><Input id={`reversal-reference-${detail.saleId}`} maxLength={128} value={reference} onChange={(event) => { setReference(event.target.value); setConfirming(false); }} /></Field>
    </div>
    <fieldset className="grid gap-2 text-sm"><legend className="font-semibold">Como o valor volta ao cliente?</legend>
      <label className="flex items-center gap-2"><input type="radio" name={`refund-method-${detail.saleId}`} checked={method === "OTHER"} onChange={() => { setMethod("OTHER"); setConfirming(false); }} />Outro meio (PicPay, transferência) — o caixa não muda</label>
      {detail.reversal.cashPayoutAllowed && <label className="flex items-center gap-2"><input type="radio" name={`refund-method-${detail.saleId}`} checked={method === "CASH_DRAWER"} onChange={() => { setMethod("CASH_DRAWER"); setConfirming(false); }} />Dinheiro entregue pelo caixa de um turno aberto</label>}
    </fieldset>
    {method === "CASH_DRAWER" && (shifts === null ? <p role="status" className="text-sm">Carregando turnos abertos…</p>
      : shifts.length === 0 ? <p className="text-sm text-[var(--g-status-danger)]">Nenhum turno aberto. Abra um turno no PDV ou registre a devolução por outro meio.</p>
      : <Field id={`reversal-shift-${detail.saleId}`} label="Turno que entregou o dinheiro"><select id={`reversal-shift-${detail.saleId}`} className="g-input min-h-11 w-full" value={shiftId} onChange={(event) => { setShiftId(event.target.value); setConfirming(false); }}><option value="">Selecione o turno</option>{shifts.map((shift) => <option key={shift.shiftId} value={shift.shiftId}>{shift.sellerName} · {shift.locationName} · caixa {formatMoney(shift.expectedCashCents)}</option>)}</select></Field>)}
    {error && <p role="alert" className="text-sm text-[var(--g-status-danger)]">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant={confirming ? "danger" : "secondary"} loading={busy} disabled={!valid || busy}><RotateCcw className="size-4" />{confirming ? `Confirmar estorno de ${formatMoney(detail.totalCents)}` : "Estornar venda"}</Button>
      {confirming && <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Voltar</Button>}
    </div>
  </form>;
}
