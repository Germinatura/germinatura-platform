"use client";

import {
  picpayAssignmentPreviewResponseSchema, picpayAssignmentResponseSchema, picpayAttributionStatusResponseSchema,
  picpayIsolationActivationResponseSchema, picpayUnassignedItemsResponseSchema, type PicpayAssignmentPreview, type PicpayAssignmentSelection,
  type PicpayAttributionFile, type PicpayAttributionStatus, type PicpayUnassignedItem,
} from "@germinatura/contracts";
import { Badge, Button, Card, ReasonField } from "@germinatura/ui";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatMoney = (cents: number) => money.format(cents / 100);
const formatDay = (value: string) => value.split("-").reverse().join("/");
const sourceLabels: Record<string, string> = { PICPAY_SALES: "Minhas vendas", PICPAY_RECEIVABLES: "Recebíveis", PICPAY_STATEMENT: "Extrato" };

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/**
 * E0 (ADR 0011), ADMIN_MASTER only: the PicPay account is shared, so its evidence counts in a cohort only after an
 * explicit attribution. Shows what is still unassigned, attributes a whole file or chosen items to the selected cohort
 * (preview, then confirmation with a reason) and turns isolation on once the global evidence was attributed.
 */
export function PicPayAttributionPanel({ cohort, onChanged }: { cohort: { id: string; name: string } | null; onChanged: () => void }) {
  const { showToast } = useToast();
  const [status, setStatus] = useState<PicpayAttributionStatus | null>(null);
  const [error, setError] = useState("");
  const [items, setItems] = useState<{ file: PicpayAttributionFile; list: PicpayUnassignedItem[]; chosen: Set<string> } | null>(null);
  const [pending, setPending] = useState<{ selection: PicpayAssignmentSelection; preview: PicpayAssignmentPreview; label: string } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [switchReason, setSwitchReason] = useState("");
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setError("");
    const response = await fetch("/api/v1/admin/finance/picpay/attribution", { cache: "no-store" });
    if (!response.ok) { setError(await messageFrom(response, "Não foi possível carregar a atribuição.")); return; }
    const parsed = picpayAttributionStatusResponseSchema.safeParse(await response.json());
    if (!parsed.success) { setError("A atribuição retornou dados inválidos."); return; }
    setStatus(parsed.data.data);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function openItems(file: PicpayAttributionFile) {
    setError("");
    const response = await fetch(`/api/v1/admin/finance/picpay/attribution?${new URLSearchParams({ importId: file.id })}`, { cache: "no-store" });
    if (!response.ok) { setError(await messageFrom(response, "Não foi possível listar os itens.")); return; }
    const parsed = picpayUnassignedItemsResponseSchema.safeParse(await response.json());
    if (!parsed.success) { setError("Os itens retornaram dados inválidos."); return; }
    setItems({ file, list: parsed.data.data, chosen: new Set() });
  }

  async function preview(selection: PicpayAssignmentSelection, label: string) {
    setError(""); setPending(null);
    const response = await fetch("/api/v1/admin/finance/picpay/attribution/preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection),
    });
    if (!response.ok) { setError(await messageFrom(response, "Não foi possível gerar a prévia.")); return; }
    const parsed = picpayAssignmentPreviewResponseSchema.safeParse(await response.json());
    if (!parsed.success) { setError("A prévia retornou dados inválidos."); return; }
    setPending({ selection, preview: parsed.data.data, label });
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true); setError("");
    const signature = JSON.stringify([pending.selection, pending.preview.count, pending.preview.totalCents, reason.trim()]);
    const key = keys.current.get(signature) ?? `picpay-assign:${crypto.randomUUID()}`;
    keys.current.set(signature, key);
    try {
      const response = await fetch("/api/v1/admin/finance/picpay/attribution", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ ...pending.selection, reason: reason.trim(), expectedCount: pending.preview.count, expectedTotalCents: pending.preview.totalCents }),
      });
      if (!response.ok) { setError(await messageFrom(response, "Não foi possível atribuir.")); return; }
      const parsed = picpayAssignmentResponseSchema.safeParse(await response.json());
      showToast(parsed.success ? `${parsed.data.data.count} item(ns) atribuído(s) à ${cohort?.name ?? "turma"}.` : "Atribuição registrada.", "success");
      setPending(null); setItems(null); setReason("");
      await load();
      onChanged();
    } finally { setBusy(false); }
  }

  async function activate() {
    setBusy(true); setError("");
    const key = keys.current.get(`isolation:${switchReason.trim()}`) ?? `picpay-isolation:${crypto.randomUUID()}`;
    keys.current.set(`isolation:${switchReason.trim()}`, key);
    try {
      const response = await fetch("/api/v1/admin/finance/picpay/attribution/isolation", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ reason: switchReason.trim() }),
      });
      if (!response.ok) { setError(await messageFrom(response, "Não foi possível ativar o isolamento.")); return; }
      const parsed = picpayIsolationActivationResponseSchema.safeParse(await response.json());
      showToast(parsed.success && !parsed.data.data.activatedNow ? "O isolamento por turma já estava ativo." : "Isolamento por turma ativado.", "success");
      setSwitchReason("");
      await load();
      onChanged();
    } finally { setBusy(false); }
  }

  const toggleItem = (id: string) => setItems((current) => {
    if (!current) return current;
    const chosen = new Set(current.chosen);
    if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
    return { ...current, chosen };
  });

  return <Card className="p-5">
    <section aria-label="Atribuição da evidência PicPay" className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-3xl">
          <h2 className="font-semibold">Atribuição por turma (ADMIN_MASTER)</h2>
          <p className="mt-1 text-sm text-[var(--g-text-secondary)]">A conta PicPay é compartilhada: cada linha do Extrato e cada venda de Minhas vendas só conta numa turma depois de atribuída, pela declaração do arquivo, por um registro da turma ou aqui. Nada é atribuído pela turma padrão, pela descrição ou por quem importou.</p>
        </div>
        {status && <Badge tone={status.enforced ? "success" : "warning"}>{status.enforced ? "Isolamento ativo" : "Isolamento ainda não ativado"}</Badge>}
      </div>
      {error && <p role="alert" className="flex items-start gap-2 text-sm text-[var(--g-status-danger)]"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</p>}
      {!status && !error && <p role="status" className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando…</p>}
      {status && <>
        <dl className="grid gap-3 sm:grid-cols-3">
          <div><dt className="text-sm text-[var(--g-text-secondary)]">Linhas do Extrato sem turma</dt><dd className="mt-1 font-semibold">{status.unassigned.statementLines} · <span className="g-money">{formatMoney(status.unassigned.statementNetCents)}</span></dd><dd className="text-xs text-[var(--g-text-muted)]">{status.unassigned.statementPending} ainda sem revisão</dd></div>
          <div><dt className="text-sm text-[var(--g-text-secondary)]">Vendas de Minhas vendas sem turma</dt><dd className="mt-1 font-semibold">{status.unassigned.transactions} · <span className="g-money">{formatMoney(status.unassigned.transactionsGrossCents)}</span></dd><dd className="text-xs text-[var(--g-text-muted)]">{status.unassigned.historicalTransactions} históricas</dd></div>
          <div><dt className="text-sm text-[var(--g-text-secondary)]">Já atribuídas</dt><dd className="mt-1 text-sm">{status.byCohort.length === 0 ? "Nenhuma" : status.byCohort.map((row) => `${row.name}: ${row.statementLines} linha(s), ${row.transactions} venda(s)`).join(" · ")}</dd></div>
        </dl>
        <p className="text-sm text-[var(--g-text-secondary)]">{status.enforced
          ? "Ativo: o que está sem turma não entra no saldo, no resultado, na receita histórica nem nos indicadores de nenhuma turma, e só o ADMIN_MASTER vê."
          : "Ainda não ativado: os números continuam como antes (toda turma lê toda a evidência). Atribua o que está sem turma, confira saldo e resultado e só então ative o isolamento."}</p>
        <div role="region" aria-label="Arquivos e declaração" tabIndex={0} className="overflow-x-auto"><table className="w-full min-w-[48rem] text-left text-sm">
          <caption className="sr-only">Arquivos importados, declaração e evidência sem turma</caption>
          <thead className="text-[var(--g-text-muted)]"><tr><th className="py-1 pr-3 font-medium">Arquivo</th><th className="py-1 pr-3 font-medium">Período</th><th className="py-1 pr-3 font-medium">Declaração</th><th className="py-1 pr-3 font-medium">Sem turma</th><th className="py-1 font-medium">Atribuir à turma selecionada</th></tr></thead>
          <tbody>{status.files.map((file) => <tr key={file.id} className="border-t border-[var(--g-border-subtle)] align-top">
            <td className="py-2 pr-3">nº {file.number} · {sourceLabels[file.sourceType]}<span className="block text-xs text-[var(--g-text-muted)]">{file.fileName}</span></td>
            <td className="py-2 pr-3">{formatDay(file.periodFrom)} a {formatDay(file.periodTo)}</td>
            <td className="py-2 pr-3">{file.scope === "COHORT" ? `Integralmente da ${file.declaredCohortName ?? "turma"}` : file.scope === "GLOBAL" ? "Misto/global" : "Anterior à declaração"}</td>
            <td className="py-2 pr-3">{file.unassigned} · <span className="g-money">{formatMoney(file.unassignedCents)}</span></td>
            <td className="py-2">{file.unassigned > 0 && cohort ? <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void preview({ importId: file.id, statementLineIds: [], transactionIds: [] }, `arquivo nº ${file.number} inteiro`)}>Arquivo inteiro</Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void openItems(file)}>Escolher itens</Button>
            </div> : file.unassigned > 0 ? "Selecione uma turma" : "—"}</td>
          </tr>)}</tbody>
        </table></div>
        {items && <div className="grid gap-2 rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)] p-4">
          <h3 className="font-semibold">Itens sem turma do arquivo nº {items.file.number}</h3>
          {items.list.length === 0 ? <p className="text-sm">Nada sem turma neste arquivo.</p> : <ul className="grid gap-1 text-sm">{items.list.map((item) => <li key={item.id}>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={items.chosen.has(item.id)} onChange={() => toggleItem(item.id)} />
              <span>{formatDay(item.occurredOn)} · <span className="g-money">{formatMoney(item.amountCents)}</span> · {item.label}</span></label>
          </li>)}</ul>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy || items.chosen.size === 0} onClick={() => {
              const chosen = items.list.filter((item) => items.chosen.has(item.id));
              void preview({ importId: null, statementLineIds: chosen.filter((item) => item.kind === "STATEMENT_LINE").map((item) => item.id),
                transactionIds: chosen.filter((item) => item.kind === "TRANSACTION").map((item) => item.id) }, `${chosen.length} item(ns) do arquivo nº ${items.file.number}`);
            }}>Prévia dos itens escolhidos</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setItems(null)}>Fechar</Button>
          </div>
        </div>}
        {pending && cohort && <div role="group" aria-label="Confirmar atribuição" className="grid gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-warning)]/50 bg-[var(--g-status-warning-soft)] p-4 text-sm">
          <p><strong>Atribuir {pending.label} à {cohort.name}:</strong> {pending.preview.count} item(ns) ({pending.preview.statementLines} linha(s) do Extrato, {pending.preview.transactions} venda(s)), total <span className="g-money">{formatMoney(pending.preview.totalCents)}</span>{pending.preview.firstOn && pending.preview.lastOn ? `, de ${formatDay(pending.preview.firstOn)} a ${formatDay(pending.preview.lastOn)}` : ""}.</p>
          {pending.preview.alreadyInCohort > 0 && <p>{pending.preview.alreadyInCohort} item(ns) já contam nesta turma e ficam como estão.</p>}
          {pending.preview.otherCohort > 0 && <p className="font-semibold text-[var(--g-status-danger)]">{pending.preview.otherCohort} item(ns) já contam em outra turma: a atribuição será recusada. Escolha os itens um a um.</p>}
          <p>A atribuição é definitiva: o item nunca muda de turma depois.</p>
          <ReasonField id="picpay-assign-reason" label="Motivo da atribuição" minLength={8} maxLength={300} value={reason} onChange={setReason} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" loading={busy} disabled={busy || pending.preview.count === 0 || pending.preview.otherCohort > 0 || reason.trim().length < 8} onClick={() => void confirm()}>Confirmar atribuição</Button>
            <Button type="button" variant="ghost" onClick={() => setPending(null)}>Cancelar</Button>
          </div>
        </div>}
        <div className="grid gap-3 border-t border-[var(--g-border-subtle)] pt-4">
          <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-4" />Isolamento por turma</h3>
          {status.enforced
            ? <p className="text-sm">Ativo{status.updatedAt ? ` desde ${new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(status.updatedAt))}` : ""}{status.reason ? `: ${status.reason}` : ""}. A ativação é definitiva.</p>
            : <>
              <p className="text-sm">A ativação é definitiva: não há como desativar pelo Portal. Ative só depois de atribuir a evidência sem turma e conferir saldo e resultado de cada turma.</p>
              <ReasonField id="picpay-isolation-reason" label="Motivo da ativação" minLength={8} maxLength={300} value={switchReason} onChange={setSwitchReason} />
              <div>
                <Button type="button" loading={busy} disabled={busy || switchReason.trim().length < 8} onClick={() => void activate()}>Ativar isolamento</Button>
              </div>
            </>}
        </div>
      </>}
    </section>
  </Card>;
}
