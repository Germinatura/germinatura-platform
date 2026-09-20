"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { createPurchaseReceiptSchema, purchaseReceiptCommandResponseSchema, purchaseReceiptsResponseSchema, purchaseOrdersResponseSchema, type PurchaseOrder, type PurchaseReceipt } from "@germinatura/contracts";
import { formatMoneyBrl, moneyFromCents } from "@germinatura/domain";
import { Button, Card, Field, Input } from "@germinatura/ui";

type Progress = { orderItemId: string; orderedQuantity: number; receivedQuantity: number };
const nullable = (value: string) => value.trim() || null;
const messageFrom = (body: unknown, fallback: string) => body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;

export function PurchaseReceiptsManagement({ initialOrderId }: { initialOrderId: string }) {
  const [searchId, setSearchId] = useState(initialOrderId);
  const [lookupId, setLookupId] = useState(initialOrderId);
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [receipts, setReceipts] = useState<PurchaseReceipt[]>([]);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [receivedOn, setReceivedOn] = useState("");
  const [lotCode, setLotCode] = useState("");
  const [manufacturedOn, setManufacturedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const createKey = useRef<string | null>(null);

  useEffect(() => {
    if (!z.uuid().safeParse(lookupId).success) return;
    let active = true;
    Promise.all([
      fetch(`/api/v1/admin/procurement/orders?orderId=${lookupId}`, { cache: "no-store" }),
      fetch(`/api/v1/admin/procurement/receipts?orderId=${lookupId}`, { cache: "no-store" }),
    ]).then(async ([orderResponse, receiptResponse]) => {
      const [orderBody, receiptBody]: unknown[] = await Promise.all([orderResponse.json(), receiptResponse.json()]);
      if (!orderResponse.ok || !receiptResponse.ok) throw new Error(messageFrom(!orderResponse.ok ? orderBody : receiptBody, "Não foi possível consultar o pedido."));
      const orderPage = purchaseOrdersResponseSchema.parse(orderBody);
      const receiptPage = purchaseReceiptsResponseSchema.parse(receiptBody);
      if (active) {
        setOrder(orderPage.data[0] ?? null);
        setReceipts(receiptPage.data);
        setProgress(receiptPage.progress);
        setNextCursor(receiptPage.nextCursor);
        setItemId("");
        if (!orderPage.data.length) setError("Pedido não encontrado.");
      }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Falha de conexão."); });
    return () => { active = false; };
  }, [lookupId, refresh]);

  function search(event: React.FormEvent) {
    event.preventDefault();
    const parsed = z.uuid().safeParse(searchId.trim());
    if (!parsed.success) { setError("Informe um identificador de pedido válido."); return; }
    setError(""); setNotice(""); setOrder(null); setReceipts([]); setProgress([]); setLookupId(parsed.data);
    if (parsed.data === lookupId) setRefresh((value) => value + 1);
  }

  async function receive(event: React.FormEvent) {
    event.preventDefault();
    if (!order) return;
    const parsed = createPurchaseReceiptSchema.safeParse({
      orderId: order.id, orderItemId: itemId, quantity: Number(quantity), receivedOn,
      lotCode: nullable(lotCode), manufacturedOn: nullable(manufacturedOn),
      expiresOn: nullable(expiresOn), reason,
    });
    if (!parsed.success) { setError("Confira item, quantidade, lote, datas e motivo."); return; }
    const available = progress.find((item) => item.orderItemId === itemId);
    if (!available || parsed.data.quantity > available.orderedQuantity - available.receivedQuantity) {
      setError("A quantidade excede o saldo do pedido. Atualize a consulta."); return;
    }
    createKey.current ??= `purchase-receipt:${crypto.randomUUID()}`;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/admin/procurement/receipts", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": createKey.current },
        body: JSON.stringify(parsed.data),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(messageFrom(body, "Não foi possível registrar o recebimento."));
      const result = purchaseReceiptCommandResponseSchema.parse(body);
      createKey.current = null;
      setQuantity("1"); setLotCode(""); setManufacturedOn(""); setExpiresOn(""); setReason("");
      setNotice(`Recebimento registrado. ${formatMoneyBrl(moneyFromCents(result.data.totalCostCents))} vinculados ao estoque e à obrigação a pagar.`);
      setRefresh((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setBusy(false); }
  }

  async function loadOlder() {
    if (!order || !nextCursor) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/procurement/receipts?orderId=${order.id}&cursor=${nextCursor}`, { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(messageFrom(body, "Não foi possível carregar os recebimentos."));
      const page = purchaseReceiptsResponseSchema.parse(body);
      setReceipts((current) => [...current, ...page.data.filter((item) => !current.some((known) => known.id === item.id))]);
      setNextCursor(page.nextCursor); setProgress(page.progress);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setBusy(false); }
  }

  const selected = order?.items.find((item) => item.id === itemId);
  const selectedProgress = progress.find((item) => item.orderItemId === itemId);
  return <div className="space-y-6">
    {error && <p role="alert" className="rounded-lg bg-[var(--g-status-danger-soft)] p-4 text-sm">{error}</p>}
    {notice && <p role="status" className="rounded-lg bg-[var(--g-status-success-soft)] p-4 text-sm">{notice}</p>}
    <Card className="p-5"><form onSubmit={search} className="flex flex-wrap items-end gap-3">
      <Field id="receipt-order-search" label="Identificador do pedido"><Input id="receipt-order-search" value={searchId} onChange={(event) => setSearchId(event.target.value)} placeholder="UUID do pedido" /></Field>
      <Button type="submit">Consultar pedido</Button>
    </form></Card>
    {order && <>
      <Card className="p-5 space-y-3"><h2 className="text-xl font-semibold">{order.supplierName}</h2>
        <p className="text-sm text-[var(--g-text-secondary)]">Pedido {order.id} · {order.orderedOn} · {order.status === "OPEN" ? "Aberto" : order.status === "PARTIALLY_RECEIVED" ? "Parcial" : order.status === "RECEIVED" ? "Recebido" : "Cancelado"}</p>
        <p>Total previsto: <strong>{formatMoneyBrl(moneyFromCents(order.totalCents))}</strong></p>
        <ul className="space-y-1 text-sm">{order.items.map((item) => { const current = progress.find((value) => value.orderItemId === item.id); return <li key={item.id}>{item.productName} · recebido {current?.receivedQuantity ?? 0} de {item.quantity} · custo unitário {formatMoneyBrl(moneyFromCents(item.unitCostCents))}</li>; })}</ul>
      </Card>
      {["OPEN", "PARTIALLY_RECEIVED"].includes(order.status) && <Card className="p-5"><h2 className="text-xl font-semibold">Registrar entrega conferida</h2>
        <form onSubmit={(event) => void receive(event)} className="mt-5 space-y-4"><fieldset disabled={busy} className="space-y-4">
          <Field id="receipt-item" label="Item do pedido"><select id="receipt-item" required className="g-input" value={itemId} onChange={(event) => { createKey.current = null; setItemId(event.target.value); }}><option value="">Selecione</option>{order.items.filter((item) => { const current = progress.find((value) => value.orderItemId === item.id); return (current?.receivedQuantity ?? 0) < item.quantity; }).map((item) => <option key={item.id} value={item.id}>{item.productName} · {item.productSku}</option>)}</select></Field>
          {selected && selectedProgress && <p className="text-sm">Restam {selectedProgress.orderedQuantity - selectedProgress.receivedQuantity} unidade(s) deste item.</p>}
          <div className="grid gap-4 sm:grid-cols-2"><Field id="receipt-quantity" label="Quantidade conferida"><Input id="receipt-quantity" required type="number" min="1" max={selectedProgress ? selectedProgress.orderedQuantity - selectedProgress.receivedQuantity : undefined} step="1" value={quantity} onChange={(event) => { createKey.current = null; setQuantity(event.target.value); }} /></Field><Field id="receipt-date" label="Data do recebimento"><Input id="receipt-date" required type="date" value={receivedOn} onChange={(event) => { createKey.current = null; setReceivedOn(event.target.value); }} /></Field></div>
          <Field id="receipt-lot" label="Código do lote"><Input id="receipt-lot" required minLength={2} maxLength={100} value={lotCode} onChange={(event) => { createKey.current = null; setLotCode(event.target.value); }} placeholder="Código impresso na embalagem" /></Field>
          <div className="grid gap-4 sm:grid-cols-2"><Field id="receipt-manufacture" label="Fabricação opcional"><Input id="receipt-manufacture" type="date" value={manufacturedOn} onChange={(event) => { createKey.current = null; setManufacturedOn(event.target.value); }} /></Field><Field id="receipt-expiry" label="Validade opcional"><Input id="receipt-expiry" type="date" value={expiresOn} onChange={(event) => { createKey.current = null; setExpiresOn(event.target.value); }} /></Field></div>
          <Field id="receipt-reason" label="Motivo e conferência"><Input id="receipt-reason" required minLength={4} maxLength={500} value={reason} onChange={(event) => { createKey.current = null; setReason(event.target.value); }} placeholder="Ex.: entrega conferida com nota" /></Field>
          <Button type="submit" loading={busy} disabled={!itemId}>Registrar recebimento</Button>
        </fieldset></form>
      </Card>}
      <Card className="p-5"><h2 className="text-xl font-semibold">Histórico de recebimentos</h2>
        {!receipts.length ? <p className="mt-3 text-sm text-[var(--g-text-secondary)]">Nenhuma entrega registrada.</p> : <ul className="mt-3 divide-y divide-[var(--g-border-subtle)]">{receipts.map((receipt) => <li key={receipt.id} className="py-4 text-sm"><p className="font-semibold">{order.items.find((item) => item.id === receipt.orderItemId)?.productName ?? receipt.productId} · {receipt.quantity} unidade(s) · {receipt.receivedOn}</p><p>Lote {receipt.lot.code}{receipt.lot.expiresOn ? ` · validade ${receipt.lot.expiresOn}` : ""}</p><p>Custo {formatMoneyBrl(moneyFromCents(receipt.baseCostCents))} + rateio {formatMoneyBrl(moneyFromCents(receipt.allocatedExtraCents))} = {formatMoneyBrl(moneyFromCents(receipt.totalCostCents))}</p><p className="text-[var(--g-text-secondary)]">Movimento {receipt.movementId} · obrigação {receipt.payableId}</p></li>)}</ul>}
        {nextCursor && <Button type="button" className="mt-4" variant="secondary" loading={busy} onClick={() => void loadOlder()}>Carregar anteriores</Button>}
      </Card>
    </>}
  </div>;
}
