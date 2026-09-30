"use client";

import type { CardPaymentMethod, PaymentTerminal, PdvRaffle, RaffleNumberReservationResponse } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, CircleCheck, Loader2, Ticket } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PaymentLinkPanel } from "@/components/operations/PaymentLinkPanel";
import { useToast } from "@/components/ui/Toast";
import {
  cancelRaffleSale, cashChange, confirmCashPayment, confirmManualPayment, findRaffleBuyer, formatMoney, loadEnabledFeatures,
  loadPaymentTerminals, loadPdvRaffles, loadRaffleBoard, parseMoneyInput, reservePdvRaffle,
} from "@/lib/operations";

type Reservation = RaffleNumberReservationResponse["data"];
type Channel = "MAQUININHA" | "PIX_AREA" | "DINHEIRO" | "PAYMENT_LINK";
const operationKey = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
const messageFrom = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir esta ação.";

/**
 * Spec 6.15 (RAF-004): raffle numbers sold at the PDV with the same payment and finance flow as any other sale.
 * The buyer is a registered account (exact email or username) or a name and one contact, used only for the prize.
 */
export function RaffleSaleWorkspace({ locationId, online }: { locationId: string; online: boolean }) {
  const { showToast } = useToast();
  const [raffles, setRaffles] = useState<PdvRaffle[] | null>(null);
  const [campaign, setCampaign] = useState<PdvRaffle | null>(null);
  const [board, setBoard] = useState<Array<{ number: number; state: "AVAILABLE" | "TAKEN" | "MINE" }> | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [registered, setRegistered] = useState(true);
  const [identifier, setIdentifier] = useState("");
  const [buyer, setBuyer] = useState<{ profileId: string; displayName: string } | null>(null);
  const [buyerName, setBuyerName] = useState("");
  const [buyerContact, setBuyerContact] = useState("");
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [channel, setChannel] = useState<Channel>("PIX_AREA");
  const [proof, setProof] = useState("");
  const [cardMethod, setCardMethod] = useState<CardPaymentMethod | null>(null);
  const [terminals, setTerminals] = useState<PaymentTerminal[]>([]);
  const [terminalId, setTerminalId] = useState("");
  const [tendered, setTendered] = useState("");
  const [paymentLink, setPaymentLink] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reserveKey = useRef(operationKey("pdv-raffle-reserve"));
  const payKey = useRef(operationKey("pdv-raffle-pay"));

  const refresh = useCallback(async () => {
    try { setRaffles(await loadPdvRaffles()); } catch (cause) { setError(messageFrom(cause)); setRaffles([]); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
      void loadEnabledFeatures().then((flags) => setPaymentLink(flags.has("payment_link")), () => setPaymentLink(false));
      void loadPaymentTerminals().then(setTerminals, () => setTerminals([]));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function choose(next: PdvRaffle) {
    setCampaign(next); setSelected([]); setBoard(null); setError(""); reserveKey.current = operationKey("pdv-raffle-reserve");
    try { setBoard(await loadRaffleBoard(next.campaignId)); } catch (cause) { setError(messageFrom(cause)); }
  }

  function toggle(number: number) {
    setSelected((current) => current.includes(number) ? current.filter((item) => item !== number) : current.length >= 100 ? current : [...current, number].sort((a, b) => a - b));
    reserveKey.current = operationKey("pdv-raffle-reserve");
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true); setError("");
    try { await operation(); } catch (cause) { const message = messageFrom(cause); setError(message); showToast(message, "error"); } finally { setBusy(false); }
  }

  const lookup = () => run(async () => {
    const found = await findRaffleBuyer(identifier);
    setBuyer(found);
    if (!found) throw new Error("Nenhum cadastro com esse e-mail ou usuário. Use \"Sem cadastro\" com nome e contato.");
  });

  const reserve = () => run(async () => {
    if (!campaign) return;
    const buyerInput = registered ? (buyer ? { profileId: buyer.profileId } : null) : { name: buyerName.trim(), contact: buyerContact.trim() };
    if (!buyerInput) throw new Error("Identifique o comprador antes de reservar.");
    try {
      setReservation(await reservePdvRaffle(campaign.campaignId, { locationId, numbers: selected, buyer: buyerInput }, reserveKey.current));
      payKey.current = operationKey("pdv-raffle-pay");
    } catch (cause) {
      setBoard(await loadRaffleBoard(campaign.campaignId).catch(() => board));
      throw cause;
    }
  });

  const pay = () => run(async () => {
    if (!reservation) return;
    if (channel === "DINHEIRO") {
      const tenderedCents = parseMoneyInput(tendered);
      if (tenderedCents === null || cashChange(reservation.totalCents, tenderedCents) === null) throw new Error("O valor recebido precisa cobrir o total.");
      await confirmCashPayment(reservation.saleId, tenderedCents, payKey.current);
    } else if (channel !== "PAYMENT_LINK") {
      if (proof.trim().length < 4) throw new Error("Informe a referência não sensível do comprovante.");
      if (channel === "MAQUININHA" && (!cardMethod || (terminals.length > 0 && !terminalId))) throw new Error("Informe o método do cartão e a maquininha.");
      await confirmManualPayment(reservation.saleId, channel, proof.trim(), channel === "MAQUININHA" && cardMethod ? { cardMethod, terminalId: terminalId || null } : null, payKey.current);
    }
    setDone(true); showToast("Venda de rifa confirmada.", "success");
  });

  const cancel = () => run(async () => {
    if (!reservation) return;
    await cancelRaffleSale(reservation.saleId, `pdv-raffle-cancel:${reservation.saleId}`);
    showToast("Números liberados.", "info"); reset();
  });

  function reset() {
    setReservation(null); setDone(false); setSelected([]); setBuyer(null); setIdentifier(""); setBuyerName(""); setBuyerContact("");
    setProof(""); setTendered(""); setCardMethod(null); setTerminalId(""); setError("");
    reserveKey.current = operationKey("pdv-raffle-reserve");
    if (campaign) void choose(campaign);
    void refresh();
  }

  if (raffles === null) return <p role="status" className="flex items-center gap-2 p-6"><Loader2 className="size-4 animate-spin" /> Carregando rifas…</p>;
  if (done && reservation) return <Card className="mx-auto max-w-xl p-6 text-center">
    <CircleCheck className="mx-auto size-12 text-[var(--g-status-success-foreground)]" />
    <h2 className="mt-3 text-2xl font-bold">Venda de rifa confirmada</h2>
    <p className="mt-2 text-sm">Números <strong className="g-money">{reservation.numbers.join(", ")}</strong> · {formatMoney(reservation.totalCents)}</p>
    <Button variant="brand" size="lg" className="mt-5 w-full" onClick={reset}>Nova venda de rifa</Button>
  </Card>;

  return <div className="grid gap-5">
    {error && <div role="alert" className="flex items-start gap-2 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    {!reservation && <>
      {raffles.length === 0 ? <Card className="p-8 text-center"><Ticket className="mx-auto size-8 text-[var(--g-text-muted)]" /><p className="mt-3 font-semibold">Nenhuma rifa aberta para venda</p></Card>
        : <div className="flex flex-wrap gap-2" role="group" aria-label="Rifas abertas">{raffles.map((item) => <Button key={item.campaignId} variant={campaign?.campaignId === item.campaignId ? "brand" : "secondary"} aria-pressed={campaign?.campaignId === item.campaignId} onClick={() => void choose(item)}>{item.name} · {item.unitPriceCents !== null ? formatMoney(item.unitPriceCents) : "—"}</Button>)}</div>}
      {campaign && <Card className="grid gap-4 p-5">
        <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{campaign.name}</h2><Badge tone="info">{campaign.availableCount} disponíveis</Badge></div>
        {!board ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Carregando números…</p>
          : <div role="group" aria-label={`Números de ${campaign.name}`} className="grid max-h-72 grid-cols-6 gap-2 overflow-y-auto sm:grid-cols-10">{board.map((item) => {
            const chosen = selected.includes(item.number);
            return <button key={item.number} type="button" disabled={item.state !== "AVAILABLE"} aria-pressed={chosen} aria-label={`Número ${item.number}${item.state !== "AVAILABLE" ? " indisponível" : ""}`} onClick={() => toggle(item.number)}
              className={`g-money min-h-11 rounded-[var(--g-radius-control)] border text-sm font-semibold ${chosen ? "border-[var(--g-focus-ring)] bg-[var(--g-surface-selected)]" : item.state !== "AVAILABLE" ? "border-transparent bg-[var(--g-surface-subtle)] text-[var(--g-text-muted)] line-through" : "border-[var(--g-border-default)] bg-[var(--g-surface-default)]"}`}>{item.number}</button>;
          })}</div>}
        {selected.length > 0 && <p className="text-sm">Selecionados: <strong className="g-money">{selected.join(", ")}</strong>{campaign.unitPriceCents !== null ? ` · prévia ${formatMoney(campaign.unitPriceCents * selected.length)}` : ""}</p>}
        <fieldset className="grid gap-3"><legend className="text-sm font-semibold">Comprador</legend>
          <div className="flex gap-2"><Button type="button" size="sm" variant={registered ? "brand" : "secondary"} aria-pressed={registered} onClick={() => setRegistered(true)}>Cliente com cadastro</Button><Button type="button" size="sm" variant={!registered ? "brand" : "secondary"} aria-pressed={!registered} onClick={() => setRegistered(false)}>Sem cadastro</Button></div>
          {registered ? <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field id="raffle-buyer-identifier" label="E-mail ou usuário do comprador"><Input id="raffle-buyer-identifier" value={identifier} onChange={(event) => { setIdentifier(event.target.value); setBuyer(null); }} autoComplete="off" /></Field>
            <Button type="button" variant="secondary" disabled={busy || identifier.trim().length < 3} onClick={() => void lookup()}>Buscar</Button>
            {buyer && <p role="status" className="text-sm sm:col-span-2">Comprador: <strong>{buyer.displayName}</strong></p>}
          </div> : <div className="grid gap-2 sm:grid-cols-2">
            <Field id="raffle-buyer-name" label="Nome do comprador"><Input id="raffle-buyer-name" value={buyerName} maxLength={120} onChange={(event) => setBuyerName(event.target.value)} /></Field>
            <Field id="raffle-buyer-contact" label="Telefone ou e-mail" description="Usado só para avisar sobre o prêmio."><Input id="raffle-buyer-contact" value={buyerContact} maxLength={120} onChange={(event) => setBuyerContact(event.target.value)} /></Field>
          </div>}
        </fieldset>
        <Button variant="operation" size="lg" loading={busy} disabled={!online || busy || selected.length === 0 || (registered ? !buyer : buyerName.trim().length < 2 || buyerContact.trim().length < 8)} onClick={() => void reserve()}>Reservar números</Button>
      </Card>}
    </>}
    {reservation && <Card className="grid gap-4 p-5">
      <div className="flex items-center justify-between gap-3"><div><Badge tone="warning">Aguardando pagamento</Badge><h2 className="mt-2 text-xl font-semibold">Números {reservation.numbers.join(", ")}</h2></div><p className="g-money text-2xl font-bold">{formatMoney(reservation.totalCents)}</p></div>
      <p className="text-xs text-[var(--g-text-muted)]">Reserva válida até {new Date(reservation.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Meio de pagamento">
        {(["MAQUININHA", "PIX_AREA", "DINHEIRO", ...(paymentLink ? ["PAYMENT_LINK" as const] : [])] as Channel[]).map((item) => <Button key={item} type="button" variant={channel === item ? "brand" : "secondary"} aria-pressed={channel === item} onClick={() => { setChannel(item); payKey.current = operationKey("pdv-raffle-pay"); }}>{{ MAQUININHA: "Maquininha", PIX_AREA: "Área Pix", DINHEIRO: "Dinheiro", PAYMENT_LINK: "Link de pagamento" }[item]}</Button>)}
      </div>
      {channel === "PAYMENT_LINK" ? <PaymentLinkPanel saleId={reservation.saleId} totalCents={reservation.totalCents} online={online} onPaid={() => { setDone(true); showToast("Pagamento confirmado pelo PicPay.", "success"); }} />
        : <>
          {channel === "DINHEIRO" ? <Field id="raffle-tendered" label="Valor recebido (R$)" description="É preciso ter um turno aberto."><Input id="raffle-tendered" inputMode="decimal" value={tendered} onChange={(event) => setTendered(event.target.value)} /></Field>
            : <>{channel === "MAQUININHA" && <div className="grid gap-2">
              <div className="grid grid-cols-2 gap-2">{(["CREDITO", "DEBITO"] as const).map((method) => <Button key={method} type="button" variant={cardMethod === method ? "brand" : "secondary"} aria-pressed={cardMethod === method} onClick={() => setCardMethod(method)}>{method === "CREDITO" ? "Crédito" : "Débito"}</Button>)}</div>
              {terminals.length > 0 && <Field id="raffle-terminal" label="Maquininha usada"><select id="raffle-terminal" className="g-input min-h-11 w-full" value={terminalId} onChange={(event) => setTerminalId(event.target.value)}><option value="">Selecione</option>{terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.code} · {terminal.label}</option>)}</select></Field>}
            </div>}
            <Field id="raffle-proof" label="Referência não sensível do comprovante" description="Nunca informe número do cartão, CVV, senha ou token."><Input id="raffle-proof" value={proof} maxLength={128} onChange={(event) => setProof(event.target.value)} autoComplete="off" /></Field></>}
          <Button variant="operation" size="lg" loading={busy} disabled={!online || busy} onClick={() => void pay()}>{channel === "DINHEIRO" ? "Registrar recebimento em dinheiro" : "Confirmar recebimento manualmente"}</Button>
        </>}
      <Button variant="ghost" className="text-[var(--g-status-danger)]" disabled={!online || busy} onClick={() => void cancel()}>Cancelar e liberar números</Button>
    </Card>}
  </div>;
}
