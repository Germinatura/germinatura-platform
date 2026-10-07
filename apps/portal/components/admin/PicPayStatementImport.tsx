"use client";

import {
  automaticFinanceCategories, financeCategorySchema, picpayStatementBulkPreviewResponseSchema, picpayStatementBulkResolveResponseSchema,
  picpayStatementImportResponseSchema, picpayStatementImportsResponseSchema, picpayStatementLinesResponseSchema,
  picpayStatementLinkCandidatesResponseSchema, picpayStatementMaxBytes, picpayStatementPreviewResponseSchema,
  type FinanceCategory, type PicpayStatementBulkPreview, type PicpayStatementErrorCode, type PicpayStatementImport as StatementImport,
  type PicpayStatementImportsResponse, type PicpayStatementLine, type PicpayStatementLineStatus, type PicpayStatementLinkCandidate,
  type PicpayStatementMovement, type PicpayStatementPreview, type ResolvePicpayStatementLineRequest,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, FileUp, Link2, ListChecks, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { financeAccountLabels, financeCategoryLabels } from "@/lib/finance-labels";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatMoney = (cents: number) => money.format(cents / 100);
const formatDay = (value: string) => value.split("-").reverse().join("/");
const formatTime = (value: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
const manualCategories = financeCategorySchema.options.filter((category) => !automaticFinanceCategories.includes(category));

const movementLabels: Record<PicpayStatementMovement, string> = {
  PIX_RECEBIDO: "Pix recebido", PIX_ENVIADO: "Pix enviado", PIX_ESTORNADO: "Pix estornado", PIX_DEVOLVIDO: "Pix devolvido",
  RECEBIVEIS_VENDA: "Recebíveis de venda", COFRINHO_GUARDADO: "Dinheiro guardado", COFRINHO_RESGATADO: "Dinheiro resgatado",
  DESCONHECIDO: "Movimento desconhecido",
};
const statusLabels: Record<PicpayStatementLineStatus, string> = {
  TRANSFERENCIA: "Transferência", CONCILIADA_VENDA: "Conciliada com venda", CONCILIADA_ESTORNO: "Conciliada com estorno",
  CONCILIADA_PICPAY: "Conciliada com Minhas vendas",
  CLASSIFICADA: "Classificada", VINCULADA: "Vinculada a registro", JA_REGISTRADO: "Já registrada", PENDENTE_REVISAO: "A revisar", PENDENTE_CLASSIFICACAO: "A classificar",
};
const errorLabels: Record<PicpayStatementErrorCode, string> = {
  EMPTY_FILE: "Arquivo vazio", INVALID_ENCODING: "Codificação inválida (use UTF-8)", TOO_MANY_LINES: "Arquivo com linhas demais",
  INVALID_HEADER: "Cabeçalho diferente de data;movimento;descrição;tipo;valor", NO_LINES: "Nenhuma movimentação no arquivo",
  INVALID_FIELD_COUNT: "Quantidade de campos inválida", INVALID_DATE: "Data inválida", FUTURE_DATE: "Data no futuro",
  INVALID_MOVEMENT: "Movimento vazio ou longo demais", INVALID_TYPE: "Tipo diferente de Entrada/Saída", INVALID_AMOUNT: "Valor inválido",
  ZERO_AMOUNT: "Valor zerado", AMOUNT_SIGN_MISMATCH: "Sinal do valor não confere com o tipo",
};

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

function statusTone(status: PicpayStatementLineStatus) {
  if (status === "PENDENTE_REVISAO" || status === "PENDENTE_CLASSIFICACAO") return "warning" as const;
  if (status === "TRANSFERENCIA") return "info" as const;
  return "success" as const;
}

/** Spec 5.8 (FIN-007): PicPay Empresas statement import with preview and line review. */
export function PicPayStatementImport() {
  const { showToast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PicpayStatementPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [acceptOverlap, setAcceptOverlap] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imports, setImports] = useState<PicpayStatementImportsResponse | null>(null);
  const [selected, setSelected] = useState<StatementImport | null>(null);
  const [lines, setLines] = useState<PicpayStatementLine[]>([]);
  const [nextAfter, setNextAfter] = useState<number | null>(null);
  const [pendingOnly, setPendingOnly] = useState(true);
  const [loadingLines, setLoadingLines] = useState(false);
  const [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());
  const keyFor = (scope: string, payload: unknown) => {
    const fingerprint = `${scope}:${JSON.stringify(payload)}`;
    const key = keys.current.get(fingerprint) ?? `statement-${scope}:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, key);
    return key;
  };

  const loadImports = useCallback(async () => {
    const response = await fetch("/api/v1/admin/finance/statement-imports", { cache: "no-store" });
    if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar as importações."));
    const parsed = picpayStatementImportsResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
    setImports(parsed.data);
    return parsed.data;
  }, []);

  const loadLines = useCallback(async (importId: string, after: number | null) => {
    setLoadingLines(true);
    try {
      const query = new URLSearchParams({ pending: String(pendingOnly) });
      if (after !== null) query.set("after", String(after));
      const response = await fetch(`/api/v1/admin/finance/statement-imports/${importId}/lines?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar as linhas."));
      const parsed = picpayStatementLinesResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setSelected(parsed.data.import);
      setLines((current) => after === null ? parsed.data.data : [...current, ...parsed.data.data]);
      setNextAfter(parsed.data.nextAfter);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar as linhas."); }
    finally { setLoadingLines(false); }
  }, [pendingOnly]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadImports().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Não foi possível carregar as importações."));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadImports]);
  useEffect(() => {
    if (!selected) return;
    const timer = window.setTimeout(() => void loadLines(selected.id, null), 0);
    return () => window.clearTimeout(timer);
    // Reload only when the filter or the chosen import changes.
  }, [selected?.id, loadLines]); // eslint-disable-line react-hooks/exhaustive-deps

  async function choose(next: File | null) {
    setFile(next); setPreview(null); setAcceptOverlap(false); setError("");
    if (!next) return;
    if (next.size > picpayStatementMaxBytes) { setError("O arquivo passa de 2 MB."); return; }
    setPreviewing(true);
    try {
      const response = await fetch("/api/v1/admin/finance/statement-imports/preview", { method: "POST", headers: { "Content-Type": "text/csv" }, body: next });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível ler o arquivo."));
      const parsed = picpayStatementPreviewResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A prévia retornou dados inválidos.");
      setPreview(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível ler o arquivo."); }
    finally { setPreviewing(false); }
  }

  async function commit() {
    if (!file || !preview) return;
    setImporting(true); setError("");
    try {
      const query = new URLSearchParams({ fileName: file.name, acceptOverlap: String(acceptOverlap) });
      const response = await fetch(`/api/v1/admin/finance/statement-imports?${query}`, {
        method: "POST", headers: { "Content-Type": "text/csv", "Idempotency-Key": keyFor("import", { sha: preview.sha256, acceptOverlap }) }, body: file,
      });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível importar o extrato."));
      const parsed = picpayStatementImportResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A importação retornou dados inválidos.");
      showToast(`Extrato importado como importação nº ${parsed.data.data.number}.`, "success");
      setFile(null); setPreview(null); setAcceptOverlap(false);
      await loadImports();
      setSelected(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível importar o extrato."); }
    finally { setImporting(false); }
  }

  async function resolve(line: PicpayStatementLine, body: ResolvePicpayStatementLineRequest) {
    setError("");
    const response = await fetch(`/api/v1/admin/finance/statement-lines/${line.id}/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor(`resolve-${line.id}`, body) }, body: JSON.stringify(body),
    });
    if (!response.ok) { setError(await messageFrom(response, "Não foi possível revisar a linha.")); return false; }
    showToast(`Linha ${line.lineNumber} revisada.`, "success");
    keys.current.clear();
    await loadImports().catch(() => null);
    if (selected) await loadLines(selected.id, null);
    return true;
  }

  const overlapBlocks = (preview?.overlaps.length ?? 0) > 0 && !acceptOverlap;
  const canImport = preview && preview.errorCount === 0 && !preview.alreadyImported && !overlapBlocks;
  return <div className="grid gap-6">
    <Card className="p-5">
      <h2 className="font-semibold">Importar extrato</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Envie o CSV exportado pelo PicPay Empresas. Nada é gravado antes de você conferir a prévia. O mesmo arquivo não é importado duas vezes, e uma linha com problema impede a importação do arquivo inteiro.</p>
      <Field id="statement-file" label="Arquivo CSV" className="mt-4 max-w-md">
        <input id="statement-file" type="file" accept=".csv,text/csv" className="g-input min-h-11 w-full" onChange={(event) => void choose(event.target.files?.[0] ?? null)} />
      </Field>
      {previewing && <p role="status" className="mt-3 flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Lendo o arquivo…</p>}
      {preview && <section aria-label="Prévia da importação" className="mt-5 grid gap-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-[var(--g-text-muted)]">Período</dt><dd className="font-semibold">{preview.periodFrom && preview.periodTo ? `${formatDay(preview.periodFrom)} a ${formatDay(preview.periodTo)}` : "—"}</dd></div>
          <div><dt className="text-[var(--g-text-muted)]">Linhas</dt><dd className="font-semibold">{preview.lineCount}</dd></div>
          <div><dt className="text-[var(--g-text-muted)]">Entradas</dt><dd className="g-money font-semibold">{formatMoney(preview.inflowCents)}</dd></div>
          <div><dt className="text-[var(--g-text-muted)]">Saídas</dt><dd className="g-money font-semibold">{formatMoney(preview.outflowCents)}</dd></div>
        </dl>
        {preview.byMovement.length > 0 && <table className="w-full text-left text-sm">
          <caption className="sr-only">Movimentos do arquivo</caption>
          <thead><tr className="text-[var(--g-text-muted)]"><th className="py-1 pr-3 font-medium">Movimento</th><th className="py-1 pr-3 font-medium">Linhas</th><th className="py-1 font-medium">Total</th></tr></thead>
          <tbody>{preview.byMovement.map((row) => <tr key={row.movement} className="border-t border-[var(--g-border-subtle)]"><td className="py-1 pr-3">{movementLabels[row.movement]}</td><td className="py-1 pr-3">{row.count}</td><td className="g-money py-1">{formatMoney(row.amountCents)}</td></tr>)}</tbody>
        </table>}
        <ul aria-label="O que a importação fará" className="grid gap-1 text-sm">
          <li>Transferências automáticas (Cofrinho e recebíveis): <strong>{preview.plan.TRANSFERENCIA}</strong></li>
          <li>Pix conciliados com uma única venda: <strong>{preview.plan.CONCILIADA_VENDA}</strong></li>
          <li>Estornos conciliados com um único estorno interno: <strong>{preview.plan.CONCILIADA_ESTORNO}</strong></li>
          <li>Linhas para revisar: <strong>{preview.plan.PENDENTE_REVISAO}</strong></li>
          <li>Movimentos desconhecidos para classificar: <strong>{preview.plan.PENDENTE_CLASSIFICACAO}</strong></li>
          {preview.cutover && preview.cutover.historyLines > 0 && <li>Histórico do cutover (antes de {formatDay(preview.cutover.operatingSince)}): <strong>{preview.cutover.historyLines}</strong> linha(s). Nunca conciliam venda; recebíveis históricos ficam para revisão como receita histórica.</li>}
          {preview.cutover && preview.cutover.beforeOpeningLines > 0 && <li className="text-[var(--g-status-warning-foreground)]">{preview.cutover.beforeOpeningLines} linha(s) anteriores à abertura ({formatDay(preview.cutover.asOf)}) ficam fora do saldo: esse dinheiro já está na posição de abertura.</li>}
          {preview.repeatedLines > 0 && <li className="text-[var(--g-text-secondary)]">{preview.repeatedLines} linhas têm data, descrição e valor iguais a outra linha; cada uma é mantida como transação própria.</li>}
        </ul>
        {preview.errorCount > 0 && <div role="alert" className="rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm">
          <p className="font-semibold">{preview.errorCount} problema(s) no arquivo. Corrija ou exporte novamente antes de importar.</p>
          <ul className="mt-2 grid gap-1">{preview.errors.map((item) => <li key={`${item.line}-${item.code}`}>Linha {item.line}: {errorLabels[item.code]}</li>)}</ul>
        </div>}
        {preview.alreadyImported && <p role="alert" className="text-sm font-semibold text-[var(--g-status-danger)]">Este arquivo já foi importado (importação nº {preview.alreadyImported.number}).</p>}
        {preview.overlaps.length > 0 && !preview.alreadyImported && <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={acceptOverlap} onChange={(event) => setAcceptOverlap(event.target.checked)} />
          <span>O período cruza {preview.overlaps.map((item) => `a importação nº ${item.number} (${formatDay(item.periodFrom)} a ${formatDay(item.periodTo)})`).join(", ")}. Confirmo que este arquivo traz movimentações diferentes e quero importar mesmo assim.</span>
        </label>}
        <div><Button type="button" loading={importing} disabled={!canImport || importing} onClick={() => void commit()}><FileUp className="size-4" />Importar extrato</Button></div>
      </section>}
    </Card>
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    <Card className="p-5">
      <h2 className="font-semibold">Importações</h2>
      {imports && <p className="mt-1 text-sm text-[var(--g-text-secondary)]">{imports.pendingTotal} linha(s) aguardando revisão em todas as importações.</p>}
      {!imports ? <p role="status" className="mt-3 flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando…</p>
        : imports.data.length === 0 ? <p className="mt-3 text-sm text-[var(--g-text-secondary)]">Nenhum extrato importado.</p>
        : <ul aria-label="Importações" className="mt-3 divide-y divide-[var(--g-border-subtle)]">
          {imports.data.map((item) => {
            const pending = item.statusCounts.PENDENTE_REVISAO + item.statusCounts.PENDENTE_CLASSIFICACAO;
            return <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-semibold">Importação nº {item.number} · {formatDay(item.periodFrom)} a {formatDay(item.periodTo)}</p>
                <p className="text-sm text-[var(--g-text-secondary)]">{financeAccountLabels[item.account]} · {item.lineCount} linhas · {item.fileName} · {item.actorName} · {formatTime(item.createdAt)}</p>
              </div>
              <div className="flex items-center gap-2">
                {pending > 0 ? <Badge tone="warning">{pending} a revisar</Badge> : <Badge tone="success">Revisada</Badge>}
                <Button type="button" size="sm" variant={selected?.id === item.id ? "brand" : "ghost"} onClick={() => { setLines([]); setSelected(item); }}>Ver linhas</Button>
              </div>
            </li>;
          })}
        </ul>}
    </Card>
    {selected && selected.statusCounts.PENDENTE_REVISAO + selected.statusCounts.PENDENTE_CLASSIFICACAO > 0 && <BulkClassification
      key={selected.id} statementImport={selected}
      onDone={async () => { keys.current.clear(); await loadImports().catch(() => null); await loadLines(selected.id, null); }} />}
    {selected && <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 p-5">
        <h2 className="font-semibold">Linhas da importação nº {selected.number}</h2>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pendingOnly} onChange={(event) => { setLines([]); setPendingOnly(event.target.checked); }} />Só as que aguardam revisão</label>
      </div>
      {loadingLines && lines.length === 0 ? <p role="status" className="flex items-center gap-2 px-5 pb-5 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando linhas…</p>
        : lines.length === 0 ? <p className="px-5 pb-5 text-sm text-[var(--g-text-secondary)]">{pendingOnly ? "Nenhuma linha aguardando revisão." : "Nenhuma linha."}</p>
        : <ul aria-label="Linhas do extrato" className="divide-y divide-[var(--g-border-subtle)] border-t border-[var(--g-border-subtle)]">
          {lines.map((line) => <StatementLineItem key={line.id} line={line} onResolve={resolve} onLinked={async () => {
            keys.current.clear(); await loadImports().catch(() => null); if (selected) await loadLines(selected.id, null);
          }} />)}
        </ul>}
      {nextAfter !== null && <div className="p-5"><Button type="button" variant="ghost" loading={loadingLines} onClick={() => void loadLines(selected.id, nextAfter)}>Carregar mais</Button></div>}
    </Card>}
  </div>;
}

function StatementLineItem({ line, onResolve, onLinked }: {
  line: PicpayStatementLine; onResolve: (line: PicpayStatementLine, body: ResolvePicpayStatementLineRequest) => Promise<boolean>; onLinked: () => Promise<void>;
}) {
  const [category, setCategory] = useState<FinanceCategory | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = line.status === "PENDENTE_REVISAO" || line.status === "PENDENTE_CLASSIFICACAO";
  const reopenable = line.status === "CLASSIFICADA" || line.status === "JA_REGISTRADO" || line.status === "CONCILIADA_ESTORNO"
    || line.status === "VINCULADA";
  const reversal = line.movement === "PIX_ESTORNADO" || line.movement === "PIX_DEVOLVIDO";
  const classifiable = pending && line.movement !== "COFRINHO_GUARDADO" && line.movement !== "COFRINHO_RESGATADO";
  // Recebíveis de venda waits for review only as cutover history, and then only as historical revenue.
  const categories: readonly FinanceCategory[] = line.movement === "RECEBIVEIS_VENDA" ? ["RECEITA_HISTORICA"] : manualCategories;
  const linkable = pending && !["COFRINHO_GUARDADO", "COFRINHO_RESGATADO", "RECEBIVEIS_VENDA"].includes(line.movement);
  const run = async (body: ResolvePicpayStatementLineRequest) => {
    setBusy(true);
    try { if (await onResolve(line, body)) { setReason(""); setCategory(""); } } finally { setBusy(false); }
  };
  const detail = line.resolution?.category ? financeCategoryLabels[line.resolution.category]
    : line.resolution?.counterAccount ? `PicPay Empresas ↔ ${financeAccountLabels[line.resolution.counterAccount]}`
    : line.resolution?.reason ?? "";
  return <li aria-label={`Linha ${line.lineNumber}`} className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-semibold">{line.movementLabel}{line.description ? ` · ${line.description}` : ""}</p>
        <p className="text-sm text-[var(--g-text-secondary)]">Linha {line.lineNumber} · {formatDay(line.occurredOn)}{detail ? ` · ${detail}` : ""}{line.resolution && !pending ? ` · ${line.resolution.automatic ? "automática" : line.resolution.actorName}` : ""}</p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={statusTone(line.status)}>{statusLabels[line.status]}</Badge>
        <span className="g-money font-bold">{line.amountCents > 0 ? "+" : "−"}{formatMoney(Math.abs(line.amountCents))}</span>
      </div>
    </div>
    {pending && <div className="mt-3 grid gap-3">
      {reversal && <p className="text-xs text-[var(--g-text-muted)]">{line.amountCents < 0 ? "Saída que desfaz uma entrada: a categoria escolhida tem a receita reduzida." : "Entrada que desfaz uma saída: a categoria escolhida tem a despesa reduzida."} Nunca conta como nova receita.</p>}
      {line.saleCandidates.length > 0 && <div><p className="text-sm font-medium">Vendas com o mesmo valor</p><ul className="mt-1 grid gap-1">
        {line.saleCandidates.map((candidate) => <li key={candidate.paymentAttemptId} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{formatTime(candidate.approvedAt)} · {candidate.operatorName} · {formatMoney(candidate.amountCents)}</span>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run({ action: "CONCILIAR_VENDA", paymentAttemptId: candidate.paymentAttemptId })}>Conciliar com esta venda</Button>
        </li>)}
      </ul></div>}
      {line.refundCandidates.length > 0 && <div><p className="text-sm font-medium">Estornos internos com o mesmo valor</p><ul className="mt-1 grid gap-1">
        {line.refundCandidates.map((candidate) => <li key={candidate.refundEntryId} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{formatTime(candidate.refundedAt)} · {formatMoney(Math.abs(candidate.amountCents))}</span>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run({ action: "CONCILIAR_ESTORNO", refundEntryId: candidate.refundEntryId })}>Conciliar com este estorno</Button>
        </li>)}
      </ul></div>}
      <div className="flex flex-wrap items-end gap-2">
        {classifiable && <>
          <Field id={`line-category-${line.id}`} label="Categoria"><select id={`line-category-${line.id}`} className="g-input min-h-11 w-full" value={category} onChange={(event) => setCategory(event.target.value as FinanceCategory)}><option value="">Selecione</option>{categories.map((item) => <option key={item} value={item}>{financeCategoryLabels[item]}</option>)}</select></Field>
          <Button type="button" size="sm" disabled={busy || !category} onClick={() => category && void run({ action: "CLASSIFICAR", category })}>Classificar</Button>
        </>}
        <Field id={`line-reason-${line.id}`} label="Já registrada em outro lugar (motivo)" className="min-w-64 flex-1"><Input id={`line-reason-${line.id}`} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        <Button type="button" size="sm" variant="ghost" disabled={busy || reason.trim().length < 8} onClick={() => void run({ action: "JA_REGISTRADO", reason: reason.trim() })}>Marcar como já registrada</Button>
      </div>
      {linkable && <LinkRecord line={line} onLinked={onLinked} />}
    </div>}
    {reopenable && <div className="mt-3 flex flex-wrap items-end gap-2">
      <Field id={`line-reopen-${line.id}`} label="Motivo para reabrir" className="min-w-64 flex-1"><Input id={`line-reopen-${line.id}`} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      <Button type="button" size="sm" variant="ghost" disabled={busy || reason.trim().length < 8} onClick={() => void run({ action: "REABRIR", reason: reason.trim() })}><RotateCcw className="size-4" />Reabrir</Button>
    </div>}
  </li>;
}

const bulkMovements: PicpayStatementMovement[] = ["PIX_RECEBIDO", "PIX_ENVIADO", "PIX_ESTORNADO", "PIX_DEVOLVIDO", "RECEBIVEIS_VENDA", "DESCONHECIDO"];
const refusalLabels: Record<string, string> = {
  STATEMENT_HISTORICAL_REVENUE_NOT_ALLOWED: "não aceitam receita histórica (só entradas anteriores ao início da operação)",
  STATEMENT_LINE_ACTION_NOT_ALLOWED: "não aceitam esta categoria",
  FINANCE_CATEGORY_AUTOMATIC_ONLY: "são de venda, que vem só das vendas registradas",
};

/** Bulk classification of pending lines: preview with count and total, strong confirmation, the server re-checks. */
function BulkClassification({ statementImport, onDone }: { statementImport: StatementImport; onDone: () => Promise<void> }) {
  const { showToast } = useToast();
  const [filter, setFilter] = useState<{ movement: PicpayStatementMovement; from: string; to: string; category: FinanceCategory | "" }>(
    { movement: "PIX_RECEBIDO", from: "", to: "", category: "" });
  const [preview, setPreview] = useState<PicpayStatementBulkPreview | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef<string | null>(null);
  const selection = () => ({ movement: filter.movement, from: filter.from || null, to: filter.to || null, lineIds: null, category: filter.category });
  const change = (next: Partial<typeof filter>) => { setFilter((value) => ({ ...value, ...next })); setPreview(null); setConfirmed(false); setError(""); };

  async function runPreview() {
    if (!filter.category) { setError("Escolha a categoria."); return; }
    setBusy(true); setError(""); setConfirmed(false);
    try {
      const response = await fetch(`/api/v1/admin/finance/statement-imports/${statementImport.id}/bulk/preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection()),
      });
      if (!response.ok) { setError(await messageFrom(response, "Não foi possível gerar a prévia.")); return; }
      const parsed = picpayStatementBulkPreviewResponseSchema.safeParse(await response.json());
      if (!parsed.success) { setError("A prévia retornou dados inválidos."); return; }
      setPreview(parsed.data.data); key.current = `statement-bulk:${crypto.randomUUID()}`;
    } finally { setBusy(false); }
  }

  async function confirm() {
    if (!preview || !key.current) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/finance/statement-imports/${statementImport.id}/bulk`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current },
        body: JSON.stringify({ ...selection(), reason: reason.trim(), expectedCount: preview.count, expectedTotalCents: preview.totalCents,
          expectedSelectionSha256: preview.selectionSha256 }),
      });
      if (!response.ok) { setError(await messageFrom(response, "Não foi possível classificar as linhas.")); setPreview(null); return; }
      const parsed = picpayStatementBulkResolveResponseSchema.safeParse(await response.json());
      if (!parsed.success) { setError("A classificação retornou dados inválidos."); return; }
      showToast(`${parsed.data.data.count} linha(s) classificadas como ${financeCategoryLabels[parsed.data.data.category]}.`, "success");
      setPreview(null); setReason(""); setConfirmed(false);
      await onDone();
    } finally { setBusy(false); }
  }

  const blocked = (preview?.refusals.length ?? 0) > 0;
  const tooMany = preview ? preview.count > preview.maxLines : false;
  const ready = preview && preview.count > 0 && !blocked && !tooMany && reason.trim().length >= 8 && confirmed;
  return <Card className="p-5">
    <section aria-label="Classificação em lote">
      <h2 className="flex items-center gap-2 font-semibold"><ListChecks className="size-5" />Classificação em lote</h2>
      <p className="mt-1 max-w-2xl text-sm text-[var(--g-text-secondary)]">Classifica de uma vez as linhas que aguardam revisão nesta importação. Dinheiro guardado, resgatado e transferências automáticas nunca entram. Cada linha guarda a própria decisão, e a confirmação é recusada se a seleção mudar depois da prévia.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="bulk-movement" label="Movimento"><select id="bulk-movement" className="g-input min-h-11 w-full" value={filter.movement} onChange={(event) => change({ movement: event.target.value as PicpayStatementMovement })}>{bulkMovements.map((movement) => <option key={movement} value={movement}>{movementLabels[movement]}</option>)}</select></Field>
        <Field id="bulk-from" label="De (opcional)"><Input id="bulk-from" type="date" value={filter.from} onChange={(event) => change({ from: event.target.value })} /></Field>
        <Field id="bulk-to" label="Até (opcional)"><Input id="bulk-to" type="date" value={filter.to} onChange={(event) => change({ to: event.target.value })} /></Field>
        <Field id="bulk-category" label="Categoria"><select id="bulk-category" className="g-input min-h-11 w-full" value={filter.category} onChange={(event) => change({ category: event.target.value as FinanceCategory })}><option value="">Selecione</option>{(filter.movement === "RECEBIVEIS_VENDA" ? ["RECEITA_HISTORICA" as const] : manualCategories).map((item) => <option key={item} value={item}>{financeCategoryLabels[item]}</option>)}</select></Field>
      </div>
      <div className="mt-3"><Button type="button" variant="ghost" loading={busy && !preview} disabled={busy} onClick={() => void runPreview()}>Ver prévia</Button></div>
      {preview && <div aria-label="Prévia do lote" className="mt-4 grid gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)] p-4 text-sm">
        <dl className="grid gap-3 sm:grid-cols-3">
          <div><dt className="text-[var(--g-text-muted)]">Quantidade</dt><dd className="text-lg font-bold">{preview.count}</dd></div>
          <div><dt className="text-[var(--g-text-muted)]">Valor total</dt><dd className="g-money text-lg font-bold">{formatMoney(preview.totalCents)}</dd></div>
          <div><dt className="text-[var(--g-text-muted)]">Categoria</dt><dd className="text-lg font-bold">{financeCategoryLabels[preview.category]}</dd></div>
        </dl>
        {preview.periodFrom && preview.periodTo && <p>Período das linhas: {formatDay(preview.periodFrom)} a {formatDay(preview.periodTo)}.</p>}
        {preview.count === 0 && <p>Nenhuma linha pendente com esse filtro.</p>}
        {tooMany && <p role="alert" className="font-semibold text-[var(--g-status-danger)]">O lote passa de {preview.maxLines} linhas. Restrinja o período.</p>}
        {blocked && <ul role="alert" className="grid gap-1 font-semibold text-[var(--g-status-danger)]">{preview.refusals.map((refusal) => <li key={refusal.code}>{refusal.count} linha(s) {refusalLabels[refusal.code] ?? "não aceitam esta categoria"}. Ajuste o filtro ou a categoria.</li>)}</ul>}
        {preview.count > 0 && !blocked && !tooMany && <>
          <Field id="bulk-reason" label="Motivo do lote"><Input id="bulk-reason" maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>Confirmo classificar <strong>{preview.count}</strong> linha(s), total <strong>{formatMoney(preview.totalCents)}</strong>, como <strong>{financeCategoryLabels[preview.category]}</strong>.</span></label>
          <div><Button type="button" loading={busy} disabled={!ready || busy} onClick={() => void confirm()}>Classificar selecionadas</Button></div>
        </>}
      </div>}
      {error && <p role="alert" className="mt-3 text-sm font-semibold text-[var(--g-status-danger)]">{error}</p>}
    </section>
  </Card>;
}

/** Link to the supplier payment or manual entry that already carries the line's effect: no second expense. */
function LinkRecord({ line, onLinked }: { line: PicpayStatementLine; onLinked: () => Promise<void> }) {
  const { showToast } = useToast();
  const [candidates, setCandidates] = useState<PicpayStatementLinkCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());

  async function load() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/finance/statement-lines/${line.id}/link-candidates`, { cache: "no-store" });
      if (!response.ok) { setError(await messageFrom(response, "Não foi possível buscar registros.")); return; }
      const parsed = picpayStatementLinkCandidatesResponseSchema.safeParse(await response.json());
      if (!parsed.success) { setError("A busca retornou dados inválidos."); return; }
      setCandidates(parsed.data.data);
    } finally { setBusy(false); }
  }

  async function link(candidate: PicpayStatementLinkCandidate) {
    const body = { payableSettlementId: candidate.kind === "PAYABLE_SETTLEMENT" ? candidate.id : null,
      manualEntryId: candidate.kind === "MANUAL_ENTRY" ? candidate.id : null, reason: null };
    const key = keys.current.get(candidate.id) ?? `statement-link:${crypto.randomUUID()}`;
    keys.current.set(candidate.id, key);
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/finance/statement-lines/${line.id}/link`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
      });
      if (!response.ok) { setError(await messageFrom(response, "Não foi possível vincular.")); return; }
      showToast(`Linha ${line.lineNumber} vinculada ao registro existente.`, "success");
      await onLinked();
    } finally { setBusy(false); }
  }

  return <div className="grid gap-2">
    {candidates === null ? <div><Button type="button" size="sm" variant="ghost" loading={busy} disabled={busy} onClick={() => void load()}><Link2 className="size-4" />Vincular a registro existente</Button></div>
      : candidates.length === 0 ? <p className="text-sm text-[var(--g-text-secondary)]">Nenhum pagamento a fornecedor ou lançamento do PicPay Empresas com o mesmo valor, sem vínculo. Se o registro existe em outro lugar, marque como já registrada com o motivo.</p>
      : <div><p className="text-sm font-medium">Registros com o mesmo valor no PicPay Empresas</p><ul aria-label={`Registros para a linha ${line.lineNumber}`} className="mt-1 grid gap-1">
        {candidates.map((candidate) => <li key={candidate.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{formatDay(candidate.occurredOn)} · {candidate.kind === "PAYABLE_SETTLEMENT" ? "Pagamento a fornecedor" : "Lançamento manual"} · {candidate.label} · {formatMoney(Math.abs(candidate.amountCents))}</span>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void link(candidate)}>Vincular</Button>
        </li>)}
      </ul></div>}
    {error && <p role="alert" className="text-sm font-semibold text-[var(--g-status-danger)]">{error}</p>}
  </div>;
}

