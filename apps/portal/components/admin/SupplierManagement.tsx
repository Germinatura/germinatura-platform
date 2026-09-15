"use client";

import { useEffect, useRef, useState } from "react";
import {
  saveSupplierResponseSchema,
  saveSupplierSchema,
  suppliersResponseSchema,
  type Supplier,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { Loader2, Plus, RefreshCw } from "lucide-react";

export function SupplierManagement() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selected, setSelected] = useState<Supplier | null>(null);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [generation, setGeneration] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchSuppliers(appliedQuery, status)
      .then((data) => { if (active) { setSuppliers(data); setSelected((current) => current ? data.find((supplier) => supplier.id === current.id) ?? null : null); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Falha de conexão."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [appliedQuery, refreshKey, status]);

  return <div className="space-y-6">
    <Card className="p-5"><form onSubmit={(event) => { event.preventDefault(); setLoading(true); setError(""); setAppliedQuery(query.trim()); setRefreshKey((value) => value + 1); }} className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
      <Field id="supplier-search" label="Buscar fornecedor"><Input id="supplier-search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={160} placeholder="Nome, contato ou documento" /></Field>
      <Field id="supplier-status" label="Status"><select id="supplier-status" className="g-input" value={status} onChange={(event) => { setLoading(true); setError(""); setStatus(event.target.value as typeof status); }}><option value="ALL">Todos</option><option value="ACTIVE">Ativos</option><option value="INACTIVE">Inativos</option></select></Field>
      <Button type="submit" variant="secondary" loading={loading}><RefreshCw className="size-4" /> Atualizar</Button>
    </form></Card>
    {notice && <p role="status" className="rounded-[var(--g-radius-control)] bg-[var(--g-status-success-soft)] p-4 text-sm text-[var(--g-status-success-foreground)]">{notice}</p>}
    {error && <p role="alert" className="rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(24rem,0.8fr)]">
      <Card className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Fornecedores cadastrados</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{suppliers.length} resultado{suppliers.length === 1 ? "" : "s"}</p></div><Button type="button" variant="secondary" onClick={() => { setSelected(null); setGeneration((value) => value + 1); setNotice(""); }}><Plus className="size-4" /> Novo</Button></div>
        {loading && suppliers.length === 0 ? <p role="status" className="mt-6 flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Carregando fornecedores…</p> : suppliers.length === 0 ? <p className="mt-6 text-sm text-[var(--g-text-secondary)]">Nenhum fornecedor encontrado.</p> : <ul className="mt-4 divide-y divide-[var(--g-border-subtle)]">{suppliers.map((supplier) => <li key={supplier.id} className="flex flex-wrap items-start justify-between gap-3 py-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{supplier.name}</h3><Badge tone={supplier.active ? "success" : "warning"}>{supplier.active ? "Ativo" : "Inativo"}</Badge></div><p className="mt-1 break-words text-sm text-[var(--g-text-secondary)]">{[supplier.contactName, supplier.email, supplier.phone].filter(Boolean).join(" · ")}</p>{supplier.document && <p className="mt-1 text-sm text-[var(--g-text-muted)]">Documento: {supplier.document}</p>}</div><Button type="button" variant="secondary" aria-label={`Editar fornecedor ${supplier.name}`} onClick={() => { setSelected(supplier); setGeneration((value) => value + 1); setNotice(""); }}>Editar</Button></li>)}</ul>}
      </Card>
      <SupplierForm key={`${selected?.id ?? "new"}:${selected?.revision ?? 0}:${generation}`} supplier={selected} onSaved={async (message) => { setNotice(message); setSelected(null); setGeneration((value) => value + 1); setLoading(true); setRefreshKey((value) => value + 1); }} />
    </div>
  </div>;
}

function SupplierForm({ supplier, onSaved }: { supplier: Supplier | null; onSaved: (message: string) => Promise<void> }) {
  const [name, setName] = useState(supplier?.name ?? "");
  const [contactName, setContactName] = useState(supplier?.contactName ?? "");
  const [email, setEmail] = useState(supplier?.email ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [document, setDocument] = useState(supplier?.document ?? "");
  const [notes, setNotes] = useState(supplier?.notes ?? "");
  const [active, setActive] = useState(supplier?.active ?? true);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const key = useRef<string | null>(null);

  function changed() { key.current = null; setError(""); }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const nullable = (value: string) => value.trim() === "" ? null : value.trim();
    const parsed = saveSupplierSchema.safeParse({
      id: supplier?.id ?? null, expectedRevision: supplier?.revision ?? null, name,
      contactName: nullable(contactName), email: nullable(email), phone: nullable(phone),
      document: nullable(document), notes: nullable(notes), active, reason,
    });
    if (!parsed.success) { setError("Informe nome, ao menos um contato e o motivo da alteração."); return; }
    key.current ??= `supplier:${crypto.randomUUID()}`;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/procurement/suppliers", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current }, body: JSON.stringify(parsed.data) });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(messageFrom(body, "Não foi possível salvar o fornecedor."));
      saveSupplierResponseSchema.parse(body);
      await onSaved(supplier ? "Fornecedor atualizado e auditado." : "Fornecedor cadastrado e auditado.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setSaving(false); }
  }

  return <Card className="p-5"><h2 className="text-xl font-semibold">{supplier ? "Editar fornecedor" : "Novo fornecedor"}</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Informe pelo menos uma forma de contato. Documento e observação são opcionais.</p><form onSubmit={submit} className="mt-5 space-y-4"><fieldset disabled={saving} className="space-y-4">
    <Field id="supplier-name" label="Nome"><Input id="supplier-name" required minLength={2} maxLength={160} value={name} onChange={(event) => { changed(); setName(event.target.value); }} /></Field>
    <Field id="supplier-contact" label="Pessoa de contato"><Input id="supplier-contact" minLength={2} maxLength={160} value={contactName} onChange={(event) => { changed(); setContactName(event.target.value); }} /></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field id="supplier-email" label="E-mail"><Input id="supplier-email" type="email" maxLength={254} value={email} onChange={(event) => { changed(); setEmail(event.target.value); }} /></Field><Field id="supplier-phone" label="Telefone"><Input id="supplier-phone" minLength={5} maxLength={40} value={phone} onChange={(event) => { changed(); setPhone(event.target.value); }} /></Field></div>
    <Field id="supplier-document" label="Documento opcional" description="CPF, CNPJ ou identificação fiscal; a formatação é normalizada pelo servidor."><Input id="supplier-document" minLength={5} maxLength={40} value={document} onChange={(event) => { changed(); setDocument(event.target.value); }} /></Field>
    <Field id="supplier-notes" label="Observação opcional"><textarea id="supplier-notes" className="g-input min-h-24" minLength={2} maxLength={1000} value={notes} onChange={(event) => { changed(); setNotes(event.target.value); }} /></Field>
    <label className="flex min-h-11 items-center gap-3 rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] px-4"><input type="checkbox" checked={active} onChange={(event) => { changed(); setActive(event.target.checked); }} /><span className="text-sm font-semibold">Fornecedor ativo para novas compras</span></label>
    {!active && <p className="rounded-[var(--g-radius-control)] bg-[var(--g-status-warning-soft)] p-3 text-sm text-[var(--g-status-warning-foreground)]">A inativação impede o uso em novas compras e preserva todo o histórico.</p>}
    <Field id="supplier-reason" label="Motivo" description="Obrigatório para auditoria da criação ou alteração."><Input id="supplier-reason" required minLength={4} maxLength={500} value={reason} onChange={(event) => { changed(); setReason(event.target.value); }} /></Field>
    <Button type="submit" loading={saving}>{supplier ? "Salvar fornecedor" : "Cadastrar fornecedor"}</Button>
  </fieldset>{error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}</form></Card>;
}

function messageFrom(body: unknown, fallback: string) {
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
}

async function fetchSuppliers(query: string, status: "ALL" | "ACTIVE" | "INACTIVE") {
  const params = new URLSearchParams({ status });
  if (query) params.set("q", query);
  const response = await fetch(`/api/v1/admin/procurement/suppliers?${params}`, { cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(messageFrom(body, "Não foi possível carregar fornecedores."));
  return suppliersResponseSchema.parse(body).data;
}
