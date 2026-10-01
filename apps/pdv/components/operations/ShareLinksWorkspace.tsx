"use client";

import { shareChannelSchema, type SellerShareLinksResponse, type ShareChannel } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Copy, Link2, Loader2, Plus } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { formatMoney } from "@/lib/operations-pure";
import { attributeSaleOrigin, createShareLink, loadShareLinks } from "@/lib/share-links";

const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000";
const channelLabels: Record<ShareChannel, string> = { WHATSAPP: "WhatsApp", INSTAGRAM: "Instagram", MURAL: "Mural", PRESENCIAL: "Presencial", OUTRO: "Outro" };
const linkFor = (code: string) => `${portalUrl}/d/${code}`;

/** GROW-002: the seller's own tracked links, with QR code and results. */
export function ShareLinksWorkspace({ online }: { online: boolean }) {
  const { showToast } = useToast();
  const [data, setData] = useState<SellerShareLinksResponse["data"] | null>(null);
  const [form, setForm] = useState({ title: "", channel: "WHATSAPP" as ShareChannel });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await loadShareLinks()); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar a divulgação."); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (form.title.trim().length < 3) return;
    setBusy(true); setError("");
    key.current ??= `seller-link:${crypto.randomUUID()}`;
    try {
      await createShareLink({ title: form.title.trim(), channel: form.channel, productIds: [] }, key.current);
      key.current = null;
      setForm({ ...form, title: "" });
      showToast("Link criado.", "success");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível criar o link."); }
    finally { setBusy(false); }
  }
  async function copy(code: string) {
    try { await navigator.clipboard.writeText(linkFor(code)); showToast("Link copiado.", "success"); }
    catch { showToast("Não foi possível copiar.", "error"); }
  }

  return <div className="grid gap-6">
    <Card className="p-5">
      <h2 className="font-semibold">Novo link de divulgação</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Visitas, reservas e vendas pagas que vierem por este link contam para você.</p>
      <form aria-label="Novo link" onSubmit={create} className="mt-4 flex flex-wrap items-end gap-3">
        <Field id="link-title" label="Nome do link" className="min-w-56 flex-1"><Input id="link-title" maxLength={120} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Ex.: Grupo da turma" /></Field>
        <Field id="link-channel" label="Onde vai divulgar"><select id="link-channel" className="g-input min-h-11" value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value as ShareChannel })}>{shareChannelSchema.options.map((channel) => <option key={channel} value={channel}>{channelLabels[channel]}</option>)}</select></Field>
        <Button type="submit" loading={busy} disabled={busy || !online || form.title.trim().length < 3}><Plus className="size-4" />Criar link</Button>
      </form>
    </Card>
    {error && <p role="alert" className="flex items-center gap-2 text-sm text-[var(--g-status-danger)]"><AlertTriangle className="size-4" />{error}</p>}
    {!data ? <p role="status" className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando…</p>
      : data.links.length === 0 ? <p className="text-sm text-[var(--g-text-secondary)]">Você ainda não tem links.</p>
      : <ul aria-label="Meus links" className="grid gap-4 md:grid-cols-2">{data.links.map((link) => <li key={link.id} aria-label={link.title}><Card className="grid gap-3 p-5 sm:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold"><Link2 aria-hidden className="size-4 shrink-0" />{link.title}</p>
          <p className="mt-1 text-xs text-[var(--g-text-muted)]">{channelLabels[link.channel]}</p>
          <div className="mt-3 flex flex-wrap gap-2"><Badge tone="info">{link.visits} visita(s)</Badge><Badge tone="success">{link.reservations} reserva(s)</Badge><Badge tone="success">{link.paidSales} venda(s) paga(s) · {formatMoney(link.paidTotalCents)}</Badge></div>
          <div className="mt-3 flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="secondary" onClick={() => void copy(link.code)}><Copy className="size-4" />Copiar link</Button><code className="break-all text-xs">{linkFor(link.code)}</code></div>
        </div>
        <div className="justify-self-start rounded-lg bg-white p-3"><QRCodeSVG value={linkFor(link.code)} size={120} aria-label={`QR Code do link ${link.title}`} /></div>
      </Card></li>)}</ul>}
  </div>;
}

/** After a PDV sale, the seller can say which campaign brought the customer. Optional and once. */
export function SaleOriginPicker({ saleId }: { saleId: string }) {
  const [campaigns, setCampaigns] = useState<SellerShareLinksResponse["data"]["campaigns"] | null>(null);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => { loadShareLinks().then((value) => { if (active) setCampaigns(value.campaigns); }).catch(() => { if (active) setCampaigns([]); }); }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, []);
  if (!campaigns || campaigns.length === 0) return null;
  if (saved) return <p role="status" className="mb-4 text-sm text-[var(--g-text-secondary)]">Origem registrada: {saved}.</p>;
  async function save() {
    setBusy(true); setError("");
    try { setSaved((await attributeSaleOrigin(saleId, code)).campaignTitle); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível registrar a origem."); }
    finally { setBusy(false); }
  }
  return <div className="mb-4 flex flex-wrap items-end gap-2">
    <Field id="sale-origin" label="O cliente veio por uma divulgação? (opcional)" className="min-w-56 flex-1"><select id="sale-origin" className="g-input min-h-11 w-full" value={code} onChange={(event) => setCode(event.target.value)}><option value="">Não sei / nenhuma</option>{campaigns.map((campaign) => <option key={campaign.code} value={campaign.code}>{campaign.mine ? `Meu link: ${campaign.title}` : campaign.title}</option>)}</select></Field>
    <Button type="button" variant="secondary" loading={busy} disabled={busy || !code} onClick={() => void save()}>Registrar origem</Button>
    {error && <p role="alert" className="w-full text-sm text-[var(--g-status-danger)]">{error}</p>}
  </div>;
}
