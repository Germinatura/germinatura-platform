"use client";

import { useEffect, useRef, useState } from "react";
import { formatMoneyBrl, moneyFromCents, parseBrlToCents } from "@germinatura/domain";
import { cancelPurchaseOrderSchema, createPurchaseOrderSchema, purchaseOrderCommandResponseSchema, purchaseOrdersResponseSchema, suppliersResponseSchema, type PurchaseOrder, type Supplier } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";

type Product = { id: string; name: string; sku: string };
type Line = { id: string; productId: string; quantity: string; cost: string };
const newLine = (id: string): Line => ({ id, productId: "", quantity: "1", cost: "" });
const nullable = (value: string) => value.trim() || null;
const messageFrom = (body: unknown, fallback: string) => body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;

export function PurchaseOrdersManagement({ products }: { products: Product[] }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"ALL" | "OPEN" | "CANCELLED">("ALL");
  const [supplierId, setSupplierId] = useState("");
  const [orderedOn, setOrderedOn] = useState("");
  const [expectedOn, setExpectedOn] = useState("");
  const [freight, setFreight] = useState("0,00");
  const [otherCost, setOtherCost] = useState("0,00");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [proofReference, setProofReference] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine("initial")]);
  const [cancelReasons, setCancelReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const createKey = useRef<string | null>(null);
  const cancelKeys = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true;
    Promise.all([fetch("/api/v1/admin/procurement/suppliers?status=ACTIVE", { cache: "no-store" }), fetch(`/api/v1/admin/procurement/orders?status=${status}`, { cache: "no-store" })])
      .then(async ([supplierResponse, orderResponse]) => {
        const [supplierBody, orderBody]: unknown[] = await Promise.all([supplierResponse.json(), orderResponse.json()]);
        if (!supplierResponse.ok || !orderResponse.ok) throw new Error(messageFrom(!supplierResponse.ok ? supplierBody : orderBody, "Não foi possível consultar compras."));
        if (active) { setSuppliers(suppliersResponseSchema.parse(supplierBody).data); const page = purchaseOrdersResponseSchema.parse(orderBody); setOrders(page.data); setNextCursor(page.nextCursor); }
      }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Falha de conexão."); });
    return () => { active = false; };
  }, [refresh, status]);

  function changeLine(id: string, patch: Partial<Line>) {
    createKey.current = null;
    setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line));
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    let freightCents: number; let otherCostCents: number; let items: { productId: string; quantity: number; unitCostCents: number }[];
    try {
      freightCents = parseBrlToCents(freight); otherCostCents = parseBrlToCents(otherCost);
      items = lines.map((line) => ({ productId: line.productId, quantity: Number(line.quantity), unitCostCents: parseBrlToCents(line.cost) }));
    } catch { setError("Informe os custos em reais com até duas casas decimais."); return; }
    const parsed = createPurchaseOrderSchema.safeParse({ supplierId, orderedOn, expectedOn: nullable(expectedOn), freightCents, otherCostCents, paymentMethod, proofReference: nullable(proofReference), notes: nullable(notes), items, reason });
    if (!parsed.success) { setError("Confira fornecedor, datas, produtos distintos, quantidades, custos e motivo."); return; }
    createKey.current ??= `purchase-order:${crypto.randomUUID()}`;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/admin/procurement/orders", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": createKey.current }, body: JSON.stringify(parsed.data) });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(messageFrom(body, "Não foi possível criar o pedido."));
      purchaseOrderCommandResponseSchema.parse(body);
      createKey.current = null; setSupplierId(""); setOrderedOn(""); setExpectedOn(""); setFreight("0,00"); setOtherCost("0,00"); setPaymentMethod(""); setProofReference(""); setNotes(""); setReason(""); setLines([newLine("initial")]);
      setNotice("Pedido registrado e auditado. Aguarde o recebimento físico para entrada no estoque."); setRefresh((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setBusy(false); }
  }

  async function cancel(order: PurchaseOrder) {
    const parsed = cancelPurchaseOrderSchema.safeParse({ reason: cancelReasons[order.id] ?? "" });
    if (!parsed.success) { setError("Informe o motivo do cancelamento."); return; }
    const key = cancelKeys.current.get(order.id) ?? `purchase-cancel:${crypto.randomUUID()}`;
    cancelKeys.current.set(order.id, key); setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/v1/admin/procurement/orders/${order.id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(parsed.data) });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(messageFrom(body, "Não foi possível cancelar o pedido."));
      purchaseOrderCommandResponseSchema.parse(body); cancelKeys.current.delete(order.id);
      setNotice("Pedido cancelado e preservado no histórico."); setRefresh((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setBusy(false); }
  }

  async function loadOlder() {
    if (!nextCursor) return; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/procurement/orders?status=${status}&cursor=${nextCursor}`, { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(messageFrom(body, "Não foi possível carregar os pedidos."));
      const page = purchaseOrdersResponseSchema.parse(body); setOrders((current) => [...current, ...page.data.filter((item) => !current.some((known) => known.id === item.id))]); setNextCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setBusy(false); }
  }

  return <div className="space-y-6">
    {error && <p role="alert" className="rounded-lg bg-[var(--g-status-danger-soft)] p-4 text-sm">{error}</p>}
    {notice && <p role="status" className="rounded-lg bg-[var(--g-status-success-soft)] p-4 text-sm">{notice}</p>}
    <Card className="p-5"><h2 className="text-xl font-semibold">Novo pedido</h2><form onSubmit={(event) => void create(event)} className="mt-5 space-y-4"><fieldset disabled={busy} className="space-y-4">
      <Field id="order-supplier" label="Fornecedor ativo"><select id="order-supplier" required className="g-input" value={supplierId} onChange={(event) => { createKey.current = null; setSupplierId(event.target.value); }}><option value="">Selecione</option>{suppliers.filter((supplier) => supplier.active).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></Field>
      <div className="grid gap-4 sm:grid-cols-2"><Field id="order-date" label="Data do pedido"><Input id="order-date" type="date" required value={orderedOn} onChange={(event) => { createKey.current = null; setOrderedOn(event.target.value); }} /></Field><Field id="order-expected" label="Previsão de entrega opcional"><Input id="order-expected" type="date" value={expectedOn} onChange={(event) => { createKey.current = null; setExpectedOn(event.target.value); }} /></Field></div>
      <fieldset className="space-y-3"><legend className="font-semibold">Itens e custos unitários</legend>{lines.map((line, index) => <div key={line.id} className="grid gap-3 rounded-lg border border-[var(--g-border-default)] p-3 sm:grid-cols-[minmax(0,1fr)_7rem_9rem_auto] sm:items-end"><Field id={`order-product-${line.id}`} label={`Produto ${index + 1}`}><select id={`order-product-${line.id}`} required className="g-input" value={line.productId} onChange={(event) => changeLine(line.id, { productId: event.target.value })}><option value="">Selecione</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></Field><Field id={`order-quantity-${line.id}`} label="Quantidade"><Input id={`order-quantity-${line.id}`} required type="number" min="1" step="1" value={line.quantity} onChange={(event) => changeLine(line.id, { quantity: event.target.value })} /></Field><Field id={`order-cost-${line.id}`} label="Custo unitário (R$)"><Input id={`order-cost-${line.id}`} required inputMode="decimal" value={line.cost} onChange={(event) => changeLine(line.id, { cost: event.target.value })} placeholder="12,50" /></Field><Button type="button" variant="secondary" disabled={lines.length === 1} onClick={() => { createKey.current = null; setLines((current) => current.filter((item) => item.id !== line.id)); }}>Remover</Button></div>)}<Button type="button" variant="secondary" disabled={lines.length >= 100} onClick={() => { createKey.current = null; setLines((current) => [...current, newLine(crypto.randomUUID())]); }}>Adicionar item</Button></fieldset>
      <div className="grid gap-4 sm:grid-cols-2"><Field id="order-freight" label="Frete (R$)"><Input id="order-freight" required inputMode="decimal" value={freight} onChange={(event) => { createKey.current = null; setFreight(event.target.value); }} /></Field><Field id="order-other" label="Outros custos (R$)"><Input id="order-other" required inputMode="decimal" value={otherCost} onChange={(event) => { createKey.current = null; setOtherCost(event.target.value); }} /></Field></div>
      <Field id="order-payment-method" label="Forma de pagamento prevista"><Input id="order-payment-method" required minLength={2} maxLength={80} value={paymentMethod} onChange={(event) => { createKey.current = null; setPaymentMethod(event.target.value); }} placeholder="Ex.: transferência após entrega" /></Field>
      <Field id="order-proof" label="Referência do comprovante opcional"><Input id="order-proof" minLength={4} maxLength={500} value={proofReference} onChange={(event) => { createKey.current = null; setProofReference(event.target.value); }} /></Field>
      <Field id="order-notes" label="Observações opcionais"><textarea id="order-notes" className="g-input min-h-20" minLength={4} maxLength={1000} value={notes} onChange={(event) => { createKey.current = null; setNotes(event.target.value); }} /></Field>
      <Field id="order-reason" label="Motivo do registro"><Input id="order-reason" required minLength={4} maxLength={500} value={reason} onChange={(event) => { createKey.current = null; setReason(event.target.value); }} /></Field>
      <Button type="submit" loading={busy} disabled={!suppliers.length || !products.length}>Registrar pedido</Button>
    </fieldset></form></Card>
    <Card className="p-5"><div className="flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-xl font-semibold">Histórico de pedidos</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{orders.length} pedido(s) carregado(s)</p></div><Field id="order-status" label="Status"><select id="order-status" className="g-input" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="ALL">Todos</option><option value="OPEN">Abertos</option><option value="CANCELLED">Cancelados</option></select></Field></div>
      {!orders.length ? <p className="mt-5 text-sm text-[var(--g-text-secondary)]">Nenhum pedido encontrado.</p> : <ul className="mt-5 divide-y divide-[var(--g-border-subtle)]">{orders.map((order) => <li key={order.id} className="py-5"><div className="flex flex-wrap justify-between gap-2"><div><h3 className="font-semibold">{order.supplierName} · {order.orderedOn}</h3><p className="text-sm text-[var(--g-text-secondary)]">{order.id}</p></div><Badge tone={order.status === "OPEN" ? "success" : "neutral"}>{order.status === "OPEN" ? "Aberto" : "Cancelado"}</Badge></div><ul className="mt-3 space-y-1 text-sm">{order.items.map((item) => <li key={item.id}>{item.productName} · {item.quantity} × {formatMoneyBrl(moneyFromCents(item.unitCostCents))} = {formatMoneyBrl(moneyFromCents(item.lineTotalCents))}</li>)}</ul><p className="mt-2 text-sm">Itens {formatMoneyBrl(moneyFromCents(order.itemsSubtotalCents))} · Frete {formatMoneyBrl(moneyFromCents(order.freightCents))} · Outros {formatMoneyBrl(moneyFromCents(order.otherCostCents))}</p><p className="font-semibold">Total previsto: {formatMoneyBrl(moneyFromCents(order.totalCents))}</p><p className="mt-1 text-sm">Pagamento previsto: {order.paymentMethod}{order.expectedOn ? ` · Entrega: ${order.expectedOn}` : ""}</p>{order.proofReference && <p className="text-sm">Referência: {order.proofReference}</p>}{order.notes && <p className="text-sm">Observação: {order.notes}</p>}{order.cancellationReason && <p className="mt-2 text-sm">Cancelamento: {order.cancellationReason}</p>}{order.status === "OPEN" && <div className="mt-3 flex flex-wrap items-end gap-3"><Field id={`cancel-${order.id}`} label="Motivo do cancelamento"><Input id={`cancel-${order.id}`} minLength={4} maxLength={500} value={cancelReasons[order.id] ?? ""} onChange={(event) => { cancelKeys.current.delete(order.id); setCancelReasons((current) => ({ ...current, [order.id]: event.target.value })); }} /></Field><Button type="button" variant="secondary" disabled={busy || (cancelReasons[order.id]?.trim().length ?? 0) < 4} loading={busy} onClick={() => void cancel(order)}>Cancelar pedido</Button></div>}</li>)}</ul>}
      {nextCursor && <Button type="button" className="mt-4" variant="secondary" loading={busy} onClick={() => void loadOlder()}>Carregar anteriores</Button>}
    </Card>
  </div>;
}
