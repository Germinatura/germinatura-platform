"use client";

import { distributeStockResponseSchema, distributeStockSchema } from "@germinatura/contracts";
import { Button, Card, Field, Input } from "@germinatura/ui";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useRef, useState } from "react";

type Location = { id: string; name: string; locationType: "CENTRAL" | "SELLER" };
type Balance = { locationId: string; productId: string; availableQuantity: number };
type Product = { id: string; sku: string; name: string };

export function StockDistributionForm({ locations, balances, products }: { locations: Location[]; balances: Balance[]; products: Product[] }) {
  const router = useRouter();
  const central = locations.find((location) => location.locationType === "CENTRAL");
  const sellers = locations.filter((location) => location.locationType === "SELLER");
  const availableProducts = useMemo(() => products.flatMap((product) => {
    const balance = balances.find((item) => item.locationId === central?.id && item.productId === product.id);
    return balance && balance.availableQuantity > 0 ? [{ ...product, availableQuantity: balance.availableQuantity }] : [];
  }), [balances, central?.id, products]);
  const [productId, setProductId] = useState(availableProducts[0]?.id ?? "");
  const [toLocationId, setToLocationId] = useState(sellers[0]?.id ?? "");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const key = useRef<string | null>(null);
  const selected = availableProducts.find((product) => product.id === productId);
  const unavailable = !central || sellers.length === 0 || availableProducts.length === 0;

  function changed() { key.current = null; setError(""); setNotice(""); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setNotice("");
    const parsed = distributeStockSchema.safeParse({ fromLocationId: central?.id, toLocationId, productId, quantity: Number(quantity), reason });
    if (!parsed.success) { setError("Confira destino, produto, quantidade inteira e motivo."); return; }
    key.current ??= `stock:distribution:${crypto.randomUUID()}`;
    setSaving(true);
    try {
      const response = await fetch("/api/v1/admin/inventory/distributions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key.current },
        body: JSON.stringify(parsed.data),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body && typeof body === "object" && "message" in body ? String(body.message) : "Não foi possível concluir a distribuição.");
      const result = distributeStockResponseSchema.safeParse(body);
      if (!result.success) throw new Error("A distribuição foi recebida, mas a confirmação é inválida. Atualize a página.");
      setNotice(`${result.data.data.quantity} unidade(s) distribuída(s). Movimento ${result.data.data.movementId.slice(0, 8)} registrado.`);
      setQuantity("1"); setReason(""); key.current = null; router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível concluir a distribuição."); }
    finally { setSaving(false); }
  }

  return <Card className="p-5"><div><h2 className="text-lg font-bold">Distribuir da central</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Transfira saldo disponível para um vendedor. A operação cria um movimento imutável e nunca edita o saldo diretamente.</p></div>
    {unavailable ? <p className="mt-5 rounded-[var(--g-radius-control)] bg-[var(--g-status-warning-soft)] p-4 text-sm text-[var(--g-status-warning-foreground)]">É necessário ter uma central ativa, um vendedor ativo e saldo disponível na central.</p> : <form className="mt-5 grid gap-4 lg:grid-cols-2" onSubmit={submit} aria-label="Distribuir estoque da central">
      <Field id="distribution-source" label="Origem"><Input id="distribution-source" value={central.name} disabled /></Field>
      <Field id="distribution-destination" label="Destino"><select id="distribution-destination" className="g-input" value={toLocationId} onChange={(event) => { changed(); setToLocationId(event.target.value); }}>{sellers.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></Field>
      <Field id="distribution-product" label="Produto"><select id="distribution-product" className="g-input" value={productId} onChange={(event) => { changed(); setProductId(event.target.value); }}>{availableProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku} · {product.availableQuantity} disponível</option>)}</select></Field>
      <Field id="distribution-quantity" label="Quantidade" description={selected ? `Até ${selected.availableQuantity} unidade(s) disponíveis agora.` : undefined}><Input id="distribution-quantity" required type="number" inputMode="numeric" min={1} max={selected?.availableQuantity} step={1} value={quantity} onChange={(event) => { changed(); setQuantity(event.target.value); }} /></Field>
      <div className="lg:col-span-2"><Field id="distribution-reason" label="Motivo" description="A justificativa fica vinculada ao movimento e à auditoria."><Input id="distribution-reason" required minLength={4} maxLength={500} value={reason} onChange={(event) => { changed(); setReason(event.target.value); }} /></Field></div>
      {error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)] lg:col-span-2">{error}</p>}
      {notice && <p role="status" className="text-sm text-[var(--g-status-success-foreground)] lg:col-span-2">{notice}</p>}
      <div className="lg:col-span-2"><Button type="submit" loading={saving}>Distribuir estoque</Button></div>
    </form>}
  </Card>;
}
