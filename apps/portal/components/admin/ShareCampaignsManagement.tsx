"use client";

import {
  createShareCampaignRequestSchema, createShareCampaignResponseSchema, publicCatalogProductsResponseSchema, shareCampaignsResponseSchema,
  type PublicCatalogProduct, type ShareCampaign, type ShareChannel,
} from "@germinatura/contracts";
import { buildShareText } from "@germinatura/domain";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Copy, Loader2, Share2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const channelLabels: Record<ShareChannel, string> = {
  WHATSAPP: "WhatsApp", INSTAGRAM: "Instagram", MURAL: "Mural", PRESENCIAL: "Presencial (QR Code)", OUTRO: "Outro",
};

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/** Spec 5.13 (GROW-001): share texts with current prices, tracked links, QR codes and results per campaign. */
export function ShareCampaignsManagement() {
  const { showToast } = useToast();
  const [products, setProducts] = useState<PublicCatalogProduct[]>([]);
  const [campaigns, setCampaigns] = useState<ShareCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [channel, setChannel] = useState<ShareChannel>("WHATSAPP");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [catalogResponse, campaignsResponse] = await Promise.all([
        fetch("/api/v1/catalog/products?limit=50", { cache: "no-store" }),
        fetch("/api/v1/admin/share-campaigns", { cache: "no-store" }),
      ]);
      if (!campaignsResponse.ok) throw new Error(await messageFrom(campaignsResponse, "Não foi possível carregar as divulgações."));
      const catalog = publicCatalogProductsResponseSchema.safeParse(await catalogResponse.json().catch(() => null));
      const parsed = shareCampaignsResponseSchema.safeParse(await campaignsResponse.json());
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setProducts(catalog.success ? catalog.data.data : []);
      setCampaigns(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar as divulgações."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const linkFor = (code: string) => `${window.location.origin}/d/${code}`;
  const textFor = (campaign: Pick<ShareCampaign, "title" | "channel" | "code" | "productIds">) => buildShareText({
    channel: campaign.channel, title: campaign.title, link: linkFor(campaign.code),
    products: campaign.productIds.map((id) => products.find((product) => product.id === id))
      .filter((product): product is PublicCatalogProduct => Boolean(product))
      .map((product) => ({ name: product.name, priceCents: product.price.amountCents })),
  });

  const payload = createShareCampaignRequestSchema.safeParse({ title, channel, productIds: selected });
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!payload.success) return;
    const fingerprint = JSON.stringify(payload.data);
    const key = keys.current.get(fingerprint) ?? `share-campaign:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/share-campaigns", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload.data),
      });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível criar a divulgação."));
      const parsed = createShareCampaignResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A divulgação retornou dados inválidos.");
      showToast("Divulgação criada.", "success");
      setTitle(""); setSelected([]);
      await load();
      setOpenId(parsed.data.data.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível criar a divulgação."); }
    finally { setBusy(false); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); showToast("Texto copiado.", "success"); }
    catch { setError("Não foi possível copiar. Selecione o texto e copie manualmente."); }
  }

  return <div className="grid gap-6">
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-semibold"><Share2 className="size-4" />Nova divulgação</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">O texto usa os preços atuais e um link rastreável; visitas e reservas feitas a partir dele aparecem no histórico.</p>
      <form aria-label="Nova divulgação" onSubmit={create} className="mt-4 grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="share-title" label="Título"><Input id="share-title" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
          <Field id="share-channel" label="Canal"><select id="share-channel" className="g-input min-h-11 w-full" value={channel} onChange={(event) => setChannel(event.target.value as ShareChannel)}>{(Object.keys(channelLabels) as ShareChannel[]).map((item) => <option key={item} value={item}>{channelLabels[item]}</option>)}</select></Field>
        </div>
        <fieldset className="grid gap-2 text-sm"><legend className="font-semibold">Produtos (opcional; sem seleção, o link leva ao catálogo)</legend>
          <div className="flex flex-wrap gap-3">{products.map((product) => <label key={product.id} className="flex items-center gap-2"><input type="checkbox" checked={selected.includes(product.id)} disabled={!selected.includes(product.id) && selected.length >= 20}
            onChange={(event) => setSelected((current) => event.target.checked ? [...current, product.id] : current.filter((id) => id !== product.id))} />{product.name}</label>)}</div>
        </fieldset>
        {error && <div role="alert" className="flex items-start gap-2 text-sm text-[var(--g-status-danger)]"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><p>{error}</p></div>}
        <div><Button type="submit" loading={busy} disabled={!payload.success || busy}>Criar divulgação</Button></div>
      </form>
    </Card>
    <Card className="overflow-hidden">
      {loading ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando divulgações…</p>
        : campaigns.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhuma divulgação criada ainda.</p>
        : <ul aria-label="Divulgações" className="divide-y divide-[var(--g-border-subtle)]">{campaigns.map((campaign) => {
          const text = textFor(campaign);
          return <li key={campaign.id} aria-label={`Divulgação ${campaign.title}`} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><p className="font-semibold">{campaign.title}</p><p className="text-xs text-[var(--g-text-muted)]">{channelLabels[campaign.channel]} · {dateTime.format(new Date(campaign.createdAt))} · {campaign.createdByName}</p></div>
              <div className="flex flex-wrap gap-2"><Badge tone="info">{campaign.visits} visita(s)</Badge><Badge tone="success">{campaign.reservations} reserva(s) · {money.format(campaign.reservedTotalCents / 100)}</Badge></div>
            </div>
            <Button type="button" size="sm" variant="ghost" className="mt-2" aria-expanded={openId === campaign.id} onClick={() => setOpenId(openId === campaign.id ? null : campaign.id)}>{openId === campaign.id ? "Ocultar material" : "Ver texto e QR Code"}</Button>
            {openId === campaign.id && <div className="mt-3 grid gap-4 sm:grid-cols-[1fr_auto]">
              <div><textarea aria-label="Texto da divulgação" readOnly className="g-input min-h-40 w-full py-2 font-mono text-xs" value={text} />
                <div className="mt-2 flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="secondary" onClick={() => void copy(text)}><Copy className="size-4" />Copiar texto</Button><code className="break-all text-xs">{linkFor(campaign.code)}</code></div></div>
              <div className="justify-self-start rounded-[var(--g-radius-control)] bg-white p-3"><QRCodeSVG value={linkFor(campaign.code)} size={144} aria-label={`QR Code da divulgação ${campaign.title}`} /></div>
            </div>}
          </li>;
        })}</ul>}
    </Card>
  </div>;
}
