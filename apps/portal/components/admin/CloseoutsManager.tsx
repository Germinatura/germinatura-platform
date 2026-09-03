"use client";

import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, ClipboardCheck, RotateCcw, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

export interface CloseoutListItem {
  id: string;
  sellerName: string;
  locationName: string;
  periodStart: string;
  periodEnd: string;
  status: "CLOSED" | "REOPENED";
  confirmedSalesCount: number;
  confirmedSalesTotalCents: number;
  paymentCount: number;
  paymentTotalCents: number;
  paymentDifferenceCents: number;
  stockDifferenceUnits: number;
  justification: string | null;
  createdAt: string;
  reopenedAt: string | null;
  reopenReason: string | null;
}

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const formatMoney = (cents: number) => money.format(cents / 100);

async function responseMessage(response: Response) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? "Não foi possível reabrir o fechamento.";
}

export function CloseoutsManager({ initialItems, unavailable }: { initialItems: CloseoutListItem[]; unavailable: boolean }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"ALL" | CloseoutListItem["status"]>("ALL");
  const [selected, setSelected] = useState<CloseoutListItem | null>(null);
  const filtered = useMemo(() => initialItems.filter((item) => {
    const matchesStatus = status === "ALL" || item.status === status;
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return matchesStatus && (!normalized || `${item.sellerName} ${item.locationName}`.toLocaleLowerCase("pt-BR").includes(normalized));
  }), [initialItems, query, status]);
  const closed = initialItems.filter((item) => item.status === "CLOSED").length;
  const reopened = initialItems.length - closed;
  const divergent = initialItems.filter((item) => item.paymentDifferenceCents !== 0 || item.stockDifferenceUnits !== 0).length;

  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header><p className="text-sm font-semibold text-[var(--g-brand-primary)]">Financeiro</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Fechamentos</h1><p className="mt-2 max-w-2xl text-base text-[var(--g-text-secondary)]">Consulte os resumos imutáveis da operação e reabra somente quando uma correção auditada for necessária.</p></header>
    {unavailable && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)]"><AlertTriangle className="mt-0.5 size-5 shrink-0" />Não foi possível consultar todos os fechamentos. Tente recarregar a página antes de tomar uma decisão.</div>}
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumo dos fechamentos">
      <Summary label="Registrados" value={initialItems.length} /><Summary label="Fechados" value={closed} tone="success" /><Summary label="Reabertos" value={reopened} tone="warning" /><Summary label="Com divergência" value={divergent} tone={divergent ? "warning" : "brand"} />
    </section>
    <Card className="overflow-hidden"><div className="flex flex-col gap-4 border-b border-[var(--g-border-subtle)] p-5 md:flex-row md:items-end md:justify-between"><div><h2 className="text-lg font-bold">Histórico operacional</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{filtered.length} de {initialItems.length} fechamentos</p></div><div className="flex flex-col gap-3 sm:flex-row"><label className="relative block"><span className="sr-only">Buscar fechamento</span><Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-[var(--g-text-muted)]" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-10" placeholder="Vendedor ou localização" /></label><label><span className="sr-only">Filtrar estado</span><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="min-h-11 w-full rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] bg-[var(--g-surface-default)] px-3 text-sm focus-visible:outline-3 focus-visible:outline-[var(--g-focus-ring)]"><option value="ALL">Todos os estados</option><option value="CLOSED">Fechados</option><option value="REOPENED">Reabertos</option></select></label></div></div>
      {!unavailable && filtered.length === 0 ? <Empty hasItems={initialItems.length > 0} /> : !unavailable && <CloseoutsList items={filtered} onReopen={setSelected} />}
    </Card>
  </div>{selected && <ReopenDialog item={selected} onClose={() => setSelected(null)} />}</div>;
}

function CloseoutsList({ items, onReopen }: { items: CloseoutListItem[]; onReopen: (item: CloseoutListItem) => void }) {
      return <><div className="hidden overflow-x-auto lg:block"><table className="w-full text-left text-sm"><thead className="bg-[var(--g-surface-subtle)] text-xs uppercase tracking-wide text-[var(--g-text-muted)]"><tr><th className="px-6 py-3">Vendedor</th><th className="px-6 py-3">Período</th><th className="px-6 py-3 text-right">Vendas</th><th className="px-6 py-3 text-right">Pagamentos</th><th className="px-6 py-3">Estado</th><th className="px-6 py-3 text-right">Ação</th></tr></thead><tbody className="divide-y divide-[var(--g-border-subtle)]">{items.map((item) => <tr key={item.id} className="hover:bg-[var(--g-surface-hover)]"><td className="px-6 py-4"><p className="font-semibold">{item.sellerName}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">{item.locationName}</p></td><td className="px-6 py-4"><p>{dateTime.format(new Date(item.periodStart))}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">até {dateTime.format(new Date(item.periodEnd))}</p></td><td className="px-6 py-4 text-right"><p className="font-semibold tabular-nums">{formatMoney(item.confirmedSalesTotalCents)}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">{item.confirmedSalesCount} vendas</p></td><td className="px-6 py-4 text-right"><p className="font-semibold tabular-nums">{formatMoney(item.paymentTotalCents)}</p><p className="mt-1 text-xs text-[var(--g-text-muted)]">{item.paymentCount} pagamentos</p></td><td className="max-w-64 px-6 py-4"><Status item={item} />{(item.paymentDifferenceCents !== 0 || item.stockDifferenceUnits !== 0) && <p className="mt-2 text-xs text-[var(--g-text-muted)]">Financeiro {formatMoney(item.paymentDifferenceCents)} · estoque {item.stockDifferenceUnits}</p>}{item.status === "REOPENED" && item.reopenReason && <p className="mt-2 truncate text-xs text-[var(--g-status-warning-foreground)]" title={item.reopenReason}>{item.reopenReason}</p>}</td><td className="px-6 py-4 text-right">{item.status === "CLOSED" ? <Button variant="ghost" size="sm" onClick={() => onReopen(item)}><RotateCcw className="size-4" /> Reabrir</Button> : <span className="text-xs text-[var(--g-text-muted)]">Sem ação</span>}</td></tr>)}</tbody></table></div><div className="divide-y divide-[var(--g-border-subtle)] lg:hidden">{items.map((item) => <article key={item.id} className="space-y-4 p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{item.sellerName}</h3><p className="mt-1 text-xs text-[var(--g-text-muted)]">{item.locationName} · {dateTime.format(new Date(item.periodEnd))}</p></div><Status item={item} /></div><dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-[var(--g-text-muted)]">Vendas</dt><dd className="mt-1 font-semibold tabular-nums">{formatMoney(item.confirmedSalesTotalCents)}</dd></div><div><dt className="text-[var(--g-text-muted)]">Pagamentos</dt><dd className="mt-1 font-semibold tabular-nums">{formatMoney(item.paymentTotalCents)}</dd></div><div><dt className="text-[var(--g-text-muted)]">Diferença financeira</dt><dd className="mt-1 font-semibold tabular-nums">{formatMoney(item.paymentDifferenceCents)}</dd></div><div><dt className="text-[var(--g-text-muted)]">Diferença de estoque</dt><dd className="mt-1 font-semibold tabular-nums">{item.stockDifferenceUnits}</dd></div></dl>{item.justification && <p className="rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-3 text-sm"><strong>Justificativa:</strong> {item.justification}</p>}{item.status === "REOPENED" && item.reopenReason && <p className="text-sm text-[var(--g-status-warning-foreground)]"><strong>Motivo da reabertura:</strong> {item.reopenReason}</p>}{item.status === "CLOSED" && <Button variant="secondary" className="w-full" onClick={() => onReopen(item)}><RotateCcw className="size-4" /> Reabrir fechamento</Button>}</article>)}</div></>;
}

function ReopenDialog({ item, onClose }: { item: CloseoutListItem; onClose: () => void }) {
  const [reason, setReason] = useState(""); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const key = useRef(`closeout-reopen:${crypto.randomUUID()}`); const router = useRouter(); const { showToast } = useToast();
  async function submit(event: React.FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { const response = await fetch(`/api/v1/closeouts/${item.id}/reopen`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current }, body: JSON.stringify({ reason: reason.trim() }) }); if (!response.ok) throw new Error(await responseMessage(response)); showToast("Fechamento reaberto e auditado.", "success"); onClose(); router.refresh(); } catch (cause) { const message = cause instanceof Error ? cause.message : "Não foi possível reabrir o fechamento."; setError(message); showToast(message, "error"); } finally { setSaving(false); } }
  return <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[var(--g-surface-overlay)] sm:items-center sm:p-6"><button type="button" className="absolute inset-0" onClick={onClose} aria-label="Fechar janela" /><section role="dialog" aria-modal="true" aria-labelledby="reopen-title" className="relative max-h-[100dvh] w-full overflow-y-auto rounded-t-[var(--g-radius-card)] bg-[var(--g-surface-default)] p-6 shadow-[var(--g-shadow-raised)] sm:max-w-xl sm:rounded-[var(--g-radius-card)]"><div className="flex items-start justify-between gap-4"><div><h2 id="reopen-title" className="text-xl font-bold">Reabrir fechamento</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">{item.sellerName} · {item.locationName}</p></div><button type="button" onClick={onClose} className="flex size-11 shrink-0 items-center justify-center rounded-[var(--g-radius-control)] hover:bg-[var(--g-surface-hover)]" aria-label="Fechar"><X className="size-5" /></button></div><div className="mt-5 rounded-[var(--g-radius-control)] bg-[var(--g-status-warning-soft)] p-4 text-sm leading-6 text-[var(--g-status-warning-foreground)]">A reabertura não altera o snapshot. Ela registra quem autorizou, quando e por quê, permitindo um novo fechamento corrigido.</div><form onSubmit={submit} className="mt-5 space-y-5"><Field id="reopen-reason" label="Motivo da reabertura" description="Descreva a correção necessária em pelo menos 4 caracteres."><textarea id="reopen-reason" required minLength={4} maxLength={500} rows={4} value={reason} onChange={(event) => { setReason(event.target.value); key.current = `closeout-reopen:${crypto.randomUUID()}`; }} className="mt-2 w-full rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] px-4 py-3 text-sm focus-visible:outline-3 focus-visible:outline-[var(--g-focus-ring)]" /></Field>{error && <p role="alert" className="text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}<div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" variant="danger" loading={saving} disabled={reason.trim().length < 4}><RotateCcw className="size-4" /> Confirmar reabertura</Button></div></form></section></div>;
}

function Status({ item }: { item: CloseoutListItem }) { const divergent = item.paymentDifferenceCents !== 0 || item.stockDifferenceUnits !== 0; return <div className="flex flex-wrap gap-1"><Badge tone={item.status === "CLOSED" ? "success" : "warning"}>{item.status === "CLOSED" ? "Fechado" : "Reaberto"}</Badge>{divergent && <Badge tone="danger">Divergência</Badge>}</div>; }
function Summary({ label, value, tone = "brand" }: { label: string; value: number; tone?: "brand" | "success" | "warning" }) { const styles = tone === "success" ? "text-[var(--g-status-success-foreground)]" : tone === "warning" ? "text-[var(--g-status-warning-foreground)]" : "text-[var(--g-brand-primary)]"; return <Card className="p-5"><p className="text-sm font-semibold text-[var(--g-text-secondary)]">{label}</p><p className={`mt-4 text-3xl font-bold tabular-nums ${styles}`}>{value}</p></Card>; }
function Empty({ hasItems }: { hasItems: boolean }) { return <div className="grid min-h-64 place-items-center p-8 text-center"><div>{hasItems ? <Search className="mx-auto size-10 text-[var(--g-text-muted)]" /> : <ClipboardCheck className="mx-auto size-10 text-[var(--g-text-muted)]" />}<h3 className="mt-4 font-semibold">{hasItems ? "Nenhum fechamento encontrado" : "Ainda não há fechamentos"}</h3><p className="mt-2 text-sm text-[var(--g-text-secondary)]">{hasItems ? "Ajuste a busca ou o filtro de estado." : "Os fechamentos registrados pelos vendedores aparecerão aqui."}</p></div></div>; }
