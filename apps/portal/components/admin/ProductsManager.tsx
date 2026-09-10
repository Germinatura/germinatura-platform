"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { formatMoneyBrl, parseBrlToCents } from "@germinatura/domain";
import {
  catalogProductPriceHistoryResponseSchema,
  setCatalogProductPriceResponseSchema,
  setCatalogProductPriceSchema,
  type CatalogProduct,
  type CatalogProductImage,
  catalogProductImageMutationResponseSchema,
  removeCatalogProductImageResponseSchema,
  reorderCatalogProductImagesResponseSchema,
  type CatalogProductPrice,
  saveCatalogProductResponseSchema,
  saveCatalogProductSchema,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";

type ManagedCatalogProduct = CatalogProduct & { images: CatalogProductImage[] };

interface CatalogCategoryOption {
  id: string;
  name: string;
  active: boolean;
}

export function ProductsManager({ products, categories }: { products: ManagedCatalogProduct[]; categories: CatalogCategoryOption[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"product" | "price" | "images">("product");
  const [notice, setNotice] = useState("");
  const [formGeneration, setFormGeneration] = useState(0);
  const product = products.find((item) => item.id === selected);
  const categoryById = new Map(categories.map((category) => [category.id, category.name]));

  return <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(24rem,0.8fr)]">
    <Card className="p-5">
      <h2 className="text-xl font-semibold">Produtos cadastrados</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">{products.length} produto{products.length === 1 ? "" : "s"} nesta busca</p>
      {notice && <p role="status" className="mt-4 text-[var(--g-status-success-foreground)]">{notice}</p>}
      {products.length === 0 ? <p className="mt-6 text-[var(--g-text-secondary)]">Nenhum produto corresponde à busca. Cadastre um produto pelo formulário.</p> :
        <ul className="mt-4 divide-y divide-[var(--g-border-subtle)]">{products.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0 flex-1 break-words">
            <h3 className="font-semibold">{item.name}</h3>
            <p className="mt-1 text-sm text-[var(--g-text-secondary)]">{item.sku} · {categoryById.get(item.categoryId) ?? "Categoria indisponível"}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              <Badge tone={item.active ? "success" : "warning"}>{item.active ? "Ativo" : "Inativo"}</Badge>
              {item.published && <Badge tone="info">Portal</Badge>}
              {item.sellablePdv && <Badge tone="info">PDV</Badge>}
              {item.reservable && <Badge tone="neutral">Reservável</Badge>}
              {item.tracksLots && <Badge tone="neutral">Controla lote</Badge>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" aria-label={`Editar imagens de ${item.name}`} onClick={() => { setSelected(item.id); setPanel("images"); setNotice(""); }}>Imagens</Button><Button type="button" variant="secondary" aria-label={`Editar preço de ${item.name}`} onClick={() => { setSelected(item.id); setPanel("price"); setNotice(""); }}>Preço</Button><Button type="button" variant="secondary" aria-label={`Editar produto ${item.name}`} onClick={() => { setSelected(item.id); setPanel("product"); setNotice(""); }}>Editar</Button></div>
        </li>)}</ul>}
    </Card>
    {panel === "images" && product ? <ProductImagesPanel key={`${product.id}:${product.revision}:${formGeneration}`} product={product}
      onBack={() => { setPanel("product"); setNotice(""); }}
      onSaved={(message) => { setNotice(message); router.refresh(); }} /> : panel === "price" && product ? <ProductPricePanel key={`${product.id}:${product.revision}:${formGeneration}`} product={product}
      onBack={() => { setPanel("product"); setNotice(""); }}
      onSaved={() => { setFormGeneration((value) => value + 1); setNotice("Preço definido. A vigência anterior e a nova foram registradas na auditoria."); router.refresh(); }} /> :
      <ProductForm key={`${product?.id ?? "new"}:${product?.revision ?? 0}:${formGeneration}`} product={product} categories={categories}
        onNew={() => { setSelected(null); setPanel("product"); setNotice(""); }}
        onManagePrice={() => setPanel("price")}
        onSaved={() => { setSelected(null); setFormGeneration((value) => value + 1); setNotice("Produto salvo. A alteração foi registrada na auditoria."); }} />}
  </div>;
}

function ProductForm({ product, categories, onNew, onManagePrice, onSaved }: { product?: CatalogProduct; categories: CatalogCategoryOption[]; onNew: () => void; onManagePrice: () => void; onSaved: () => void }) {
  const router = useRouter();
  const activeCategories = categories.filter((category) => category.active);
  const currentCategoryIsInactive = Boolean(product && !activeCategories.some((category) => category.id === product.categoryId));
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? activeCategories[0]?.id ?? "");
  const [name, setName] = useState(product?.name ?? "");
  const [slug, setSlug] = useState(product?.slug ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [active, setActive] = useState(product?.active ?? true);
  const [published, setPublished] = useState(product?.published ?? false);
  const [sellablePdv, setSellablePdv] = useState(product?.sellablePdv ?? false);
  const [reservable, setReservable] = useState(product?.reservable ?? false);
  const [tracksLots, setTracksLots] = useState(product?.tracksLots ?? false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const key = useRef<string | null>(null);
  const submitted = useRef(false);

  function changed() { key.current = null; setError(""); }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitted.current) return;
    const parsed = saveCatalogProductSchema.safeParse({
      id: product?.id ?? null, expectedRevision: product?.revision ?? null, categoryId, name, slug,
      description: description.trim() === "" ? null : description, active, published, sellablePdv,
      reservable, tracksLots, reason,
    });
    if (!parsed.success) { setError("Confira categoria, nome, identificador e motivo antes de salvar."); return; }
    key.current ??= `product:${crypto.randomUUID()}`;
    submitted.current = true;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/catalog/products", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current }, body: JSON.stringify(parsed.data),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "Não foi possível salvar. Tente novamente.";
        throw new Error(message);
      }
      saveCatalogProductResponseSchema.parse(body);
      onSaved(); router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha de conexão. Tente novamente.");
    } finally { submitted.current = false; setSaving(false); }
  }

  return <Card className="p-5">
    <h2 className="text-xl font-semibold">{product ? "Editar produto" : "Novo produto"}</h2>
    <p className="mt-1 text-sm text-[var(--g-text-secondary)]">O SKU é gerado pelo servidor no primeiro salvamento e nunca é reutilizado.</p>
    <form onSubmit={submit} className="mt-5 space-y-4" aria-label={product ? "Editar produto" : "Novo produto"}>
      <fieldset disabled={saving || activeCategories.length === 0} className="space-y-4">
        <Field id="product-category" label="Categoria">
          <select id="product-category" required value={categoryId} onChange={(event) => { changed(); setCategoryId(event.target.value); }} className="g-input">
            {currentCategoryIsInactive && <option value={product?.categoryId} disabled>Categoria atual inativa — selecione outra</option>}
            {activeCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </Field>
        <Field id="product-name" label="Nome"><Input id="product-name" required maxLength={160} value={name} onChange={(event) => { changed(); setName(event.target.value); }} /></Field>
        <Field id="product-slug" label="Identificador" description="Use letras minúsculas, números e hífen. Deve ser único."><Input id="product-slug" required maxLength={100} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => { changed(); setSlug(event.target.value); }} /></Field>
        <Field id="product-description" label="Descrição opcional"><textarea id="product-description" maxLength={2000} value={description} onChange={(event) => { changed(); setDescription(event.target.value); }} className="g-input min-h-24" /></Field>
        {product && <p className="rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-3 text-sm text-[var(--g-text-secondary)]">SKU: <span className="font-semibold">{product.sku}</span></p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle id="product-active" checked={active} onChange={(value) => { changed(); setActive(value); }}>Produto ativo</Toggle>
          <Toggle id="product-published" checked={published} onChange={(value) => { changed(); setPublished(value); }}>Publicar no Portal</Toggle>
          <Toggle id="product-pdv" checked={sellablePdv} onChange={(value) => { changed(); setSellablePdv(value); }}>Disponível no PDV</Toggle>
          <Toggle id="product-reservable" checked={reservable} onChange={(value) => { changed(); setReservable(value); }}>Permite reserva</Toggle>
          <Toggle id="product-lots" checked={tracksLots} onChange={(value) => { changed(); setTracksLots(value); }}>Controla lote</Toggle>
        </div>
        {(published || sellablePdv) && <p className="rounded-[var(--g-radius-control)] bg-[var(--g-status-warning-soft)] p-3 text-sm text-[var(--g-status-warning-foreground)]">Portal e PDV exigem preço vigente. O servidor confirma essa regra ao salvar.</p>}
        {!active && <p className="rounded-[var(--g-radius-control)] bg-[var(--g-status-warning-soft)] p-3 text-sm">A inativação preserva vendas, preço e auditoria; ela apenas impede novas ofertas do produto.</p>}
        <Field id="product-reason" label="Motivo" description="Explique a criação ou alteração para a auditoria."><Input id="product-reason" required minLength={4} maxLength={500} value={reason} onChange={(event) => { changed(); setReason(event.target.value); }} /></Field>
        <div className="flex flex-wrap gap-3"><Button type="submit" loading={saving}>{product ? "Salvar produto" : "Criar produto"}</Button>{product && <Button type="button" variant="secondary" onClick={onManagePrice}>Definir preço</Button>}{product && <Button type="button" variant="secondary" onClick={onNew}>Novo produto</Button>}</div>
      </fieldset>
      {activeCategories.length === 0 && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">Cadastre uma categoria ativa antes de criar produtos.</p>}
      {error && <div role="alert" className="space-y-2 text-sm text-[var(--g-status-danger-foreground)]"><p>{error}</p><a href="/admin/catalogo" className="inline-flex min-h-11 items-center underline">Atualizar catálogo</a></div>}
    </form>
  </Card>;
}

function ProductImagesPanel({ product, onBack, onSaved }: {
  product: ManagedCatalogProduct; onBack: () => void; onSaved: (message: string) => void;
}) {
  const [images, setImages] = useState(product.images);
  const [revision, setRevision] = useState(product.revision);
  const [file, setFile] = useState<File | null>(null);
  const [altText, setAltText] = useState("");
  const [reason, setReason] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const uploadKey = useRef<string | null>(null);
  const uploadImageId = useRef<string | null>(null);

  function resetUploadIdentity() { uploadKey.current = null; uploadImageId.current = null; setError(""); }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file || images.length >= 6 || altText.trim().length < 1 || reason.trim().length < 4) {
      setError("Escolha uma imagem e preencha a descrição acessível e o motivo."); return;
    }
    uploadKey.current ??= `product-image:add:${crypto.randomUUID()}`;
    uploadImageId.current ??= crypto.randomUUID();
    const body = new FormData();
    body.set("file", file); body.set("imageId", uploadImageId.current); body.set("productId", product.id);
    body.set("expectedRevision", String(revision)); body.set("altText", altText); body.set("reason", reason);
    setAction("upload"); setError("");
    try {
      const response = await fetch("/api/v1/admin/catalog/product-images", { method: "POST", headers: { "Idempotency-Key": uploadKey.current }, body });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "message" in payload ? String(payload.message) : "Não foi possível enviar a imagem.");
      const parsed = catalogProductImageMutationResponseSchema.parse(payload);
      setImages((current) => [...current, parsed.data].sort((left, right) => left.sortOrder - right.sortOrder));
      setRevision(parsed.data.productRevision); setFile(null); setAltText(""); setReason(""); resetUploadIdentity();
      onSaved("Imagem adicionada. A primeira imagem é usada como capa do produto.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setAction(null); }
  }

  async function persistOrder(next: CatalogProductImage[]) {
    if (reason.trim().length < 4) { setError("Informe o motivo antes de alterar a capa ou a ordem."); return; }
    const key = `product-image:order:${crypto.randomUUID()}`;
    setAction("order"); setError("");
    try {
      const response = await fetch("/api/v1/admin/catalog/product-images", {
        method: "PUT", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ productId: product.id, expectedRevision: revision, imageIds: next.map((image) => image.id), reason }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "message" in payload ? String(payload.message) : "Não foi possível ordenar as imagens.");
      const parsed = reorderCatalogProductImagesResponseSchema.parse(payload);
      setRevision(parsed.data.productRevision); setImages(next.map((image, index) => ({ ...image, sortOrder: index })));
      onSaved("Ordem das imagens atualizada. A primeira imagem é a capa.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setAction(null); }
  }

  async function remove(image: CatalogProductImage) {
    if (reason.trim().length < 4) { setError("Informe o motivo antes de remover a imagem."); return; }
    setAction(image.id); setError("");
    try {
      const response = await fetch(`/api/v1/admin/catalog/product-images/${image.id}`, {
        method: "DELETE", headers: { "Content-Type": "application/json", "Idempotency-Key": `product-image:remove:${crypto.randomUUID()}` },
        body: JSON.stringify({ productId: product.id, expectedRevision: revision, reason }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(payload && typeof payload === "object" && "message" in payload ? String(payload.message) : "Não foi possível remover a imagem.");
      const parsed = removeCatalogProductImageResponseSchema.parse(payload);
      setRevision(parsed.data.productRevision);
      setImages((current) => current.filter((item) => item.id !== image.id).map((item, index) => ({ ...item, sortOrder: index })));
      onSaved("Imagem removida do catálogo e do armazenamento.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha de conexão."); }
    finally { setAction(null); }
  }

  return <Card className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Imagens de {product.name}</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Até seis imagens. A primeira da lista é a capa no Portal e no PDV.</p></div><Button type="button" variant="secondary" onClick={onBack}>Voltar ao produto</Button></div>
    {images.length > 0 && <ol className="mt-5 space-y-3">{images.map((image, index) => <li key={image.id} className="flex flex-col gap-3 rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] p-3 sm:flex-row sm:items-center">
      <div role="img" aria-label={image.altText} className="h-24 w-full shrink-0 rounded-lg bg-cover bg-center sm:w-28" style={{ backgroundImage: `url(${JSON.stringify(image.publicUrl)})` }} />
      <div className="min-w-0 flex-1"><p className="font-semibold">{index === 0 ? "Capa" : `Imagem ${index + 1}`}</p><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{image.altText}</p></div>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={index === 0 || action !== null} onClick={() => void persistOrder([images[index], ...images.slice(0, index), ...images.slice(index + 1)])}>Usar como capa</Button><Button type="button" variant="secondary" disabled={index === 0 || action !== null} onClick={() => { const next = [...images]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; void persistOrder(next); }}>Subir</Button><Button type="button" variant="secondary" disabled={index === images.length - 1 || action !== null} onClick={() => { const next = [...images]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; void persistOrder(next); }}>Descer</Button><Button type="button" variant="secondary" loading={action === image.id} disabled={action !== null} onClick={() => void remove(image)}>Remover</Button></div>
    </li>)}</ol>}
    {images.length === 0 && <p className="mt-5 rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-4 text-sm text-[var(--g-text-secondary)]">Este produto ainda não tem imagem. O catálogo mostra o ícone padrão.</p>}
    <Field id="image-action-reason" label="Motivo da alteração" description="Também é usado ao mudar capa, ordenar ou remover."><Input id="image-action-reason" className="mt-5" minLength={4} maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); setError(""); }} /></Field>
    {images.length < 6 && <form onSubmit={upload} className="mt-5 space-y-4 border-t border-[var(--g-border-subtle)] pt-5">
      <h3 className="font-semibold">Adicionar imagem</h3>
      <Field id="product-image-file" label="Arquivo JPG, PNG ou WebP" description="Máximo de 5 MB."><Input id="product-image-file" type="file" required accept="image/jpeg,image/png,image/webp" onChange={(event) => { resetUploadIdentity(); setFile(event.target.files?.[0] ?? null); }} /></Field>
      <Field id="product-image-alt" label="Descrição acessível" description="Descreva o produto para quem não consegue ver a foto."><Input id="product-image-alt" required minLength={1} maxLength={180} value={altText} onChange={(event) => { resetUploadIdentity(); setAltText(event.target.value); }} /></Field>
      <Button type="submit" loading={action === "upload"} disabled={action !== null}>Enviar imagem</Button>
    </form>}
    {error && <p role="alert" className="mt-4 text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
  </Card>;
}

function ProductPricePanel({ product, onBack, onSaved }: { product: CatalogProduct; onBack: () => void; onSaved: () => void }) {
  const router = useRouter();
  const [history, setHistory] = useState<CatalogProductPrice[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const idempotencyKey = useRef<string | null>(null);
  const submitted = useRef(false);

  const fetchHistory = useCallback(async (cursor?: string) => {
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`/api/v1/admin/catalog/products/${product.id}/prices?${params.toString()}`, { cache: "no-store" });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error("Não foi possível carregar o histórico de preços.");
    return catalogProductPriceHistoryResponseSchema.parse(body);
  }, [product.id]);

  useEffect(() => {
    let active = true;
    void fetchHistory().then((page) => {
      if (!active) return;
      setHistory(page.data);
      setNextCursor(page.nextCursor);
    }).catch(() => {
      if (active) setHistoryError("Não foi possível carregar o histórico de preços. Atualize a página antes de decidir.");
    }).finally(() => {
      if (active) setLoadingHistory(false);
    });
    return () => { active = false; };
  }, [fetchHistory]);

  async function loadOlderHistory() {
    if (!nextCursor) return;
    setLoadingHistory(true); setHistoryError("");
    try {
      const page = await fetchHistory(nextCursor);
      setHistory((current) => [...current, ...page.data]);
      setNextCursor(page.nextCursor);
    } catch {
      setHistoryError("Não foi possível carregar o histórico de preços. Atualize a página antes de decidir.");
    } finally { setLoadingHistory(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitted.current) return;
    let amountCents: number;
    try { amountCents = parseBrlToCents(price); } catch { setError("Informe um preço em reais, sem separador de milhar e com até duas casas decimais."); return; }
    const parsed = setCatalogProductPriceSchema.safeParse({ productId: product.id, expectedProductRevision: product.revision, amountCents, reason });
    if (!parsed.success) { setError("Confira o preço e o motivo antes de salvar."); return; }
    idempotencyKey.current ??= `product-price:${crypto.randomUUID()}`;
    submitted.current = true; setSaving(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/catalog/product-prices", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current }, body: JSON.stringify(parsed.data),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "Não foi possível definir o preço.";
        throw new Error(message);
      }
      setCatalogProductPriceResponseSchema.parse(body);
      router.refresh(); onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha de conexão. Tente novamente.");
    } finally { submitted.current = false; setSaving(false); }
  }

  return <Card className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Preço e histórico</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{product.name} · {product.sku}</p></div><Button type="button" variant="secondary" onClick={onBack}>Voltar ao produto</Button></div>
    <form onSubmit={submit} className="mt-5 space-y-4" aria-label={`Definir preço de ${product.name}`}>
      <fieldset disabled={saving} className="space-y-4"><Field id="product-price" label="Novo preço" description="Informe em reais, por exemplo 25,90. O servidor recebe apenas centavos inteiros."><Input id="product-price" required inputMode="decimal" autoComplete="off" placeholder="25,90" value={price} onChange={(event) => { idempotencyKey.current = null; setError(""); setPrice(event.target.value); }} /></Field><Field id="product-price-reason" label="Motivo" description="A alteração e a vigência anterior ficam registradas na auditoria."><Input id="product-price-reason" required minLength={4} maxLength={500} value={reason} onChange={(event) => { idempotencyKey.current = null; setError(""); setReason(event.target.value); }} /></Field><Button type="submit" loading={saving}>Definir preço</Button></fieldset>
      {error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
    </form>
    <section className="mt-8 border-t border-[var(--g-border-subtle)] pt-5" aria-label="Histórico de preços"><h3 className="text-base font-semibold">Histórico</h3>{loadingHistory && history.length === 0 ? <p className="mt-3 text-sm text-[var(--g-text-secondary)]">Carregando histórico…</p> : historyError ? <p role="alert" className="mt-3 text-sm text-[var(--g-status-danger-foreground)]">{historyError}</p> : history.length === 0 ? <p className="mt-3 text-sm text-[var(--g-text-secondary)]">Nenhum preço foi definido para este produto.</p> : <ul className="mt-3 divide-y divide-[var(--g-border-subtle)]">{history.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><div><p className="font-semibold">{formatMoneyBrl(item.amountCents)}</p><p className="mt-1 text-xs text-[var(--g-text-secondary)]">Início: {formatDateTime(item.validFrom)}{item.validTo ? ` · término: ${formatDateTime(item.validTo)}` : " · vigente"}</p></div><Badge tone={isCurrentPrice(item) ? "success" : "neutral"}>{isCurrentPrice(item) ? "Vigente" : new Date(item.validFrom) > new Date() ? "Agendado" : "Encerrado"}</Badge></li>)}</ul>}{nextCursor && <Button type="button" variant="secondary" className="mt-4" loading={loadingHistory} onClick={() => void loadOlderHistory()}>Carregar histórico anterior</Button>}</section>
  </Card>;
}

function isCurrentPrice(price: CatalogProductPrice) {
  const now = Date.now();
  return new Date(price.validFrom).getTime() <= now && (price.validTo === null || new Date(price.validTo).getTime() > now);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(value));
}

function Toggle({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-sm"><input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-5" />{children}</label>;
}
