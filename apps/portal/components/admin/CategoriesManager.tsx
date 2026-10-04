"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { type CatalogCategory, saveCatalogCategorySchema, saveCatalogCategoryResponseSchema } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";

export function CategoriesManager({ categories }: { categories: CatalogCategory[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [formGeneration, setFormGeneration] = useState(0);
  const category = categories.find((item) => item.id === selected);
  return <div className="grid items-start gap-6 lg:grid-cols-2">
    <Card className="p-5">
      <h2 className="text-xl font-semibold">Categorias cadastradas</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">{categories.length} nesta página · até 50 por página</p>
      {notice && <p role="status" className="mt-4 text-[var(--g-status-success-foreground)]">{notice}</p>}
      {categories.length === 0 ? <p className="mt-6 text-[var(--g-text-secondary)]">Nenhuma categoria cadastrada. Crie a primeira pelo formulário.</p> :
        <ul className="mt-4 divide-y divide-[var(--g-border-subtle)]">{categories.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0 flex-1 break-words">
            <p className="font-semibold">{item.name}</p>
            <p className="text-sm text-[var(--g-text-secondary)]">{item.slug} · Ordem {item.sortOrder}</p>
            <Badge tone={item.active ? "success" : "warning"}>{item.active ? "Ativa" : "Inativa"}</Badge>
          </div>
          <Button type="button" variant="secondary" aria-label={`Editar categoria ${item.name}`} onClick={() => { setSelected(item.id); setNotice(""); }}>Editar</Button>
        </li>)}</ul>}
    </Card>
    <CategoryForm key={`${category?.id ?? "new"}:${category?.revision ?? 0}:${formGeneration}`} category={category}
      onNew={() => { setSelected(null); setNotice(""); }}
      onSaved={() => { setSelected(null); setFormGeneration((value) => value + 1); setNotice("Categoria salva. A alteração foi registrada na auditoria."); }} />
  </div>;
}

function CategoryForm({ category, onNew, onSaved }: { category?: CatalogCategory; onNew: () => void; onSaved: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(category?.name ?? "");
  const [slug, setSlug] = useState(category?.slug ?? "");
  const [active, setActive] = useState(category?.active ?? true);
  const [sortOrder, setSortOrder] = useState(String(category?.sortOrder ?? 0));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const key = useRef<string | null>(null);
  const submitted = useRef(false);
  function changed() { key.current = null; setError(""); }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitted.current) return;
    const parsed = saveCatalogCategorySchema.safeParse({ id: category?.id ?? null, expectedRevision: category?.revision ?? null,
      name, slug, active, sortOrder: sortOrder.trim() === "" ? null : Number(sortOrder), reason });
    if (!parsed.success) { setError("Confira o nome, identificador, ordem e motivo antes de salvar."); return; }
    key.current ??= `category:${crypto.randomUUID()}`;
    submitted.current = true;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/catalog/categories", { method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key.current }, body: JSON.stringify(parsed.data) });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "Não foi possível salvar. Tente novamente.";
        throw new Error(message);
      }
      saveCatalogCategoryResponseSchema.parse(body);
      onSaved(); router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha de conexão. Tente novamente.");
    } finally { submitted.current = false; setSaving(false); }
  }

  return <Card className="p-5">
    <h2 className="text-xl font-semibold">{category ? "Editar categoria" : "Nova categoria"}</h2>
    <form onSubmit={submit} className="mt-5 space-y-4" aria-label={category ? "Editar categoria" : "Nova categoria"}>
      <fieldset disabled={saving} className="space-y-4">
        <Field id="category-name" label="Nome"><Input id="category-name" required maxLength={120} value={name} onChange={(event) => { changed(); setName(event.target.value); }} /></Field>
        <Field id="category-slug" label="Identificador" description="Use letras minúsculas, números e hífen. Deve ser único."><Input id="category-slug" required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => { changed(); setSlug(event.target.value); }} /></Field>
        <Field id="category-order" label="Ordem de exibição"><Input id="category-order" required type="number" min={0} max={2147483647} step={1} value={sortOrder} onChange={(event) => { changed(); setSortOrder(event.target.value); }} /></Field>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={active} onChange={(event) => { changed(); setActive(event.target.checked); }} className="size-5" />Categoria ativa</label>
        {!active && <p className="rounded-[var(--g-radius-control)] bg-[var(--g-status-warning-soft)] p-3 text-sm">Ao salvar como inativa, os produtos desta categoria deixam de aparecer no catálogo público e de participar de novas cotações. O histórico é preservado.</p>}
        <Field id="category-reason" label="Motivo" description="Explique a criação ou alteração para a auditoria."><Input id="category-reason" required minLength={4} maxLength={500} value={reason} onChange={(event) => { changed(); setReason(event.target.value); }} /></Field>
        <div className="flex flex-wrap gap-3"><Button type="submit" loading={saving}>Salvar categoria</Button>{category && <Button type="button" variant="secondary" onClick={onNew}>Nova categoria</Button>}</div>
      </fieldset>
      {error && <div role="alert" className="space-y-2 text-sm text-[var(--g-status-danger-foreground)]"><p>{error}</p><a href="/admin/catalogo/categorias" className="inline-flex min-h-11 items-center underline">Atualizar categorias</a></div>}
    </form>
  </Card>;
}
