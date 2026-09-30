"use client";

import { completePickupRequestSchema, type CardPaymentMethod, type CompletePickupRequest, type PaymentTerminal, type PickupReservation } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Banknote, CircleCheck, Clock, CreditCard, Search, Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { cashChange, completePickup, deliverPaidPickup, formatMoney, loadPaymentTerminals, loadPickups, parseMoneyInput } from "@/lib/operations";

/** With registered Maquininhas, the operator must name the one used. */
const terms = (terminals: PaymentTerminal[], terminalId: string) => terminals.length === 0 || terminalId !== "";
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
type Channel = CompletePickupRequest["integrationChannel"];

/** RES-003: hands over prepared reservations, charging the price frozen when the customer reserved.
 * RES-005: orders already paid online are delivered without any charge. */
export function PickupWorkspace({ online }: { online: boolean }) {
  const { showToast } = useToast();
  const [query, setQuery] = useState("");
  const [pickups, setPickups] = useState<PickupReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PickupReservation | null>(null);
  const [channel, setChannel] = useState<Channel>("DINHEIRO");
  const [tendered, setTendered] = useState("");
  const [proof, setProof] = useState("");
  const [cardMethod, setCardMethod] = useState<CardPaymentMethod | null>(null);
  const [terminals, setTerminals] = useState<PaymentTerminal[]>([]);
  const [terminalId, setTerminalId] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ customer: string; totalCents: number; changeCents: number | null; paidOnline: boolean } | null>(null);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setPickups(await loadPickups(query)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar as retiradas."); }
    finally { setLoading(false); }
  }, [query]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { void loadPaymentTerminals().then(setTerminals, () => setTerminals([])); }, []);

  function choose(pickup: PickupReservation) {
    setSelected(pickup); setDone(null); setChannel("DINHEIRO"); setTendered(""); setProof(""); setCardMethod(null); setTerminalId(""); setError("");
  }

  const change = selected ? cashChange(selected.totalCents, parseMoneyInput(tendered)) : null;
  const payment = completePickupRequestSchema.safeParse({
    integrationChannel: channel,
    tenderedCents: channel === "DINHEIRO" ? parseMoneyInput(tendered) : null,
    proofReference: channel === "DINHEIRO" ? null : proof.trim() || null,
    cardMethod: channel === "MAQUININHA" ? cardMethod : null,
    terminalId: channel === "MAQUININHA" && terminalId ? terminalId : null,
  });
  const ready = payment.success && (channel === "DINHEIRO" ? change !== null : channel !== "MAQUININHA" || terms(terminals, terminalId));

  async function submit() {
    if (!selected || !online || !ready || !payment.success) return;
    const fingerprint = `${selected.reservationId}:${JSON.stringify(payment.data)}`;
    const key = keys.current.get(fingerprint) ?? `pdv-pickup:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    setBusy(true); setError("");
    try {
      const result = await completePickup(selected.reservationId, payment.data, key);
      setDone({ customer: selected.customerName, totalCents: result.totalCents, changeCents: result.changeCents, paidOnline: false });
      setSelected(null);
      showToast("Retirada concluída.", "success");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível concluir a retirada."); }
    finally { setBusy(false); }
  }

  async function deliver() {
    if (!selected || !online) return;
    // One key per order: a double tap or a retry replays the same delivery.
    const fingerprint = `deliver:${selected.reservationId}`;
    const key = keys.current.get(fingerprint) ?? `pdv-deliver:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    setBusy(true); setError("");
    try {
      const result = await deliverPaidPickup(selected.reservationId, key);
      setDone({ customer: selected.customerName, totalCents: result.totalCents, changeCents: null, paidOnline: true });
      setSelected(null);
      showToast("Pedido entregue.", "success");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível registrar a entrega."); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto grid max-w-3xl gap-5">
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 bg-[var(--g-surface-default)] p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    {done && <Card className="p-5"><div className="flex items-center gap-3"><CircleCheck className="size-6 text-[var(--g-operation-primary)]" /><h2 className="text-lg font-semibold">{done.paidOnline ? "Pedido entregue" : "Retirada concluída"}</h2></div>
      <p className="mt-2 text-sm">{done.customer} · <span className="g-money font-semibold">{formatMoney(done.totalCents)}</span>{done.changeCents !== null && <> · troco <span className="g-money font-semibold">{formatMoney(done.changeCents)}</span></>}{done.paidOnline && " · pago online, nada cobrado"}</p></Card>}
    {selected?.paidOnline ? <Card className="p-5">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Entregar pedido de {selected.customerName}</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{selected.items.map((item) => `${item.quantity}× ${item.productName}`).join(", ")}</p></div><Badge tone="info">Pago online</Badge></div>
      <p className="mt-3 text-sm">O PicPay já confirmou o pagamento de <strong className="g-money">{formatMoney(selected.totalCents)}</strong>. Não cobre nada: confira o cliente e entregue os produtos.</p>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <Button variant="operation" size="lg" loading={busy} disabled={!online || busy} onClick={() => void deliver()}>Confirmar entrega</Button>
        <Button variant="ghost" size="lg" disabled={busy} onClick={() => setSelected(null)}>Voltar</Button>
      </div>
    </Card>
    : selected ? <Card className="p-5">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Entregar reserva de {selected.customerName}</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{selected.items.map((item) => `${item.quantity}× ${item.productName}`).join(", ")}</p></div><p className="g-money text-2xl font-bold">{formatMoney(selected.totalCents)}</p></div>
      <p className="mt-2 text-xs text-[var(--g-text-muted)]">Preço congelado na reserva; não é recalculado na retirada.</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-3" role="group" aria-label="Forma de pagamento">
        {([["DINHEIRO", "Dinheiro", Wallet], ["MAQUININHA", "Maquininha", CreditCard], ["PIX_AREA", "Área Pix", Banknote]] as const).map(([value, label, Icon]) => <button key={value} type="button" aria-pressed={channel === value} onClick={() => setChannel(value)} className={`flex min-h-12 items-center justify-center gap-2 rounded-[var(--g-radius-control)] border px-3 text-sm font-semibold ${channel === value ? "border-[var(--g-focus-ring)] bg-[var(--g-surface-selected)]" : "border-[var(--g-border-default)] bg-[var(--g-surface-default)]"}`}><Icon className="size-4" />{label}</button>)}
      </div>
      {channel === "DINHEIRO" ? <><Field id="pickup-tendered" label="Valor recebido (R$)" className="mt-4"><Input id="pickup-tendered" inputMode="decimal" value={tendered} onChange={(event) => setTendered(event.target.value)} /></Field>
        <p role="status" className="mt-2 text-sm">{change === null ? "O valor recebido precisa cobrir o total." : <>Troco: <strong className="g-money">{formatMoney(change)}</strong></>}</p></>
        : <div className="mt-4 grid gap-4">
          {channel === "MAQUININHA" && <fieldset><legend className="text-sm font-semibold">Método do cartão</legend><div className="mt-2 grid grid-cols-2 gap-2">{([["CREDITO", "Crédito"], ["DEBITO", "Débito"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={cardMethod === value} onClick={() => setCardMethod(value)} className={`min-h-12 rounded-[var(--g-radius-control)] border px-3 text-sm font-semibold ${cardMethod === value ? "border-[var(--g-focus-ring)] bg-[var(--g-surface-selected)]" : "border-[var(--g-border-default)] bg-[var(--g-surface-default)]"}`}>{label}</button>)}</div></fieldset>}
          {channel === "MAQUININHA" && terminals.length > 0 && <Field id="pickup-terminal" label="Maquininha usada"><select id="pickup-terminal" className="g-input min-h-12 w-full" value={terminalId} onChange={(event) => setTerminalId(event.target.value)}><option value="">Selecione a maquininha</option>{terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.code} · {terminal.label}</option>)}</select></Field>}
          <Field id="pickup-proof" label="Referência não sensível do comprovante"><Input id="pickup-proof" maxLength={128} value={proof} onChange={(event) => setProof(event.target.value)} autoComplete="off" /></Field>
        </div>}
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <Button variant="operation" size="lg" loading={busy} disabled={!online || !ready || busy} onClick={() => void submit()}>Concluir retirada</Button>
        <Button variant="ghost" size="lg" disabled={busy} onClick={() => setSelected(null)}>Voltar</Button>
      </div>
    </Card>
    : <>
      <Field id="pickup-query" label="Buscar cliente"><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--g-text-muted)]" /><Input id="pickup-query" className="pl-9" maxLength={80} value={query} onChange={(event) => setQuery(event.target.value)} /></div></Field>
      {loading && pickups.length === 0 ? <p role="status" className="p-2">Carregando retiradas…</p>
        : pickups.length === 0 ? <Card className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhuma reserva pronta ou pedido pago para entregar nos seus locais.</Card>
        : <ul aria-label="Reservas e pedidos para entregar" className="grid gap-3">{pickups.map((pickup) => <li key={pickup.reservationId} aria-label={`Reserva de ${pickup.customerName}`}><Card className="p-4">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold">{pickup.customerName}</p><p className="text-sm text-[var(--g-text-secondary)]">{pickup.items.map((item) => `${item.quantity}× ${item.productName}`).join(", ")}</p></div><div className="text-right">{pickup.paidOnline ? <Badge tone="info">Pago online</Badge> : <Badge tone="success">Pronta</Badge>}<p className="g-money mt-1 font-bold">{formatMoney(pickup.totalCents)}</p></div></div>
          <p className="mt-2 flex items-center gap-2 text-xs text-[var(--g-text-muted)]"><Clock className="size-3" />{pickup.pickupDeadline ? `Retirada até ${dateTime.format(new Date(pickup.pickupDeadline))}` : pickup.paidAt ? `Pago em ${dateTime.format(new Date(pickup.paidAt))}` : "Pago online"} · {pickup.locationName}</p>
          {pickup.pickupInstructions && <p className="mt-1 text-sm">{pickup.pickupInstructions}</p>}
          <Button type="button" variant="secondary" className="mt-3 w-full" disabled={!online} onClick={() => choose(pickup)}>{pickup.paidOnline ? "Entregar (já pago)" : "Entregar e cobrar"}</Button>
        </Card></li>)}</ul>}
    </>}
  </div>;
}
