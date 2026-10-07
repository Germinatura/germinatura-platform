"use client";

import {
  picpayExceptionsResponseSchema, picpayFilePreviewResponseSchema, picpayImportResponseSchema, picpayImportsResponseSchema,
  picpayPeriodsResponseSchema, picpaySettlementsResponseSchema, picpaySummaryResponseSchema, picpayTransactionsResponseSchema,
  type PicpayException, type PicpayExceptionType, type PicpayFilePreview, type PicpayImport, type PicpayPeriod, type PicpaySettlements,
  type PicpaySourceType, type PicpaySummary, type PicpayTransaction,
} from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PicPayStatementImport } from "@/components/admin/PicPayStatementImport";
import { useToast } from "@/components/ui/Toast";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatMoney = (cents: number) => money.format(cents / 100);
const formatDay = (value: string) => value.split("-").reverse().join("/");
const formatTime = (value: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const shift = (day: string, days: number) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };

const sourceLabels: Record<PicpaySourceType, string> = { PICPAY_SALES: "Minhas vendas", PICPAY_RECEIVABLES: "Recebíveis", PICPAY_STATEMENT: "Extrato" };
const exceptionLabels: Record<PicpayExceptionType, string> = {
  PDV_SEM_PICPAY: "Venda do PDV sem transação PicPay", PICPAY_SEM_PDV: "Transação PicPay sem venda no PDV",
  VALOR_DIVERGENTE: "Valor divergente", METODO_DIVERGENTE: "Forma de pagamento divergente",
  TRANSACAO_DEVOLVIDA: "Transação devolvida sem estorno no PDV", STATUS_DIVERGENTE: "Status divergente entre arquivos",
  LIQUIDACAO_SEM_EXPLICACAO: "Liquidação sem explicação", RECEBIVEL_EM_ATRASO: "Recebível em atraso",
  RECEBIVEL_INCONSISTENTE: "Recebível inconsistente", DUPLICIDADE: "Duplicidade a revisar",
  EXTRATO_NAO_CLASSIFICADO: "Linha do Extrato não classificada", RECEITA_DUPLICADA: "Receita contada duas vezes",
  LIQUIDACAO_DUPLICADA: "Liquidação em dobro", SALDO_DIVERGENTE: "Saldo divergente",
};
const settlementLabels: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" }> = {
  LIQUIDADO: { label: "Liquidado", tone: "success" }, PARCIAL: { label: "Parcial", tone: "warning" },
  EXCEDENTE: { label: "Excedente", tone: "danger" }, EM_ATRASO: { label: "Em atraso", tone: "danger" }, A_RECEBER: { label: "A receber", tone: "info" },
};
const transactionLabels: Record<string, string> = { APROVADA: "Aprovada", NEGADA: "Negada", DEVOLVIDA: "Devolvida", OUTRO: "Outro" };
const periodLabels: Record<string, { label: string; tone: "success" | "warning" | "danger" }> = {
  CONCILIADO: { label: "Conciliado", tone: "success" }, COM_PENDENCIAS: { label: "Com pendências", tone: "warning" },
  REVISAR: { label: "Revisar: nova evidência", tone: "danger" },
};
const errorLabels: Record<string, string> = {
  UNKNOWN_FILE: "Arquivo não reconhecido: envie Minhas vendas, Recebíveis ou Extrato do PicPay Empresas.",
  EMPTY_FILE: "Arquivo vazio", INVALID_ENCODING: "Codificação inválida (use UTF-8)", INVALID_HEADER: "Cabeçalho diferente do esperado",
  NO_LINES: "Nenhuma linha", INVALID_FIELD_COUNT: "Quantidade de campos inválida", INVALID_DATE: "Data inválida", FUTURE_DATE: "Data no futuro",
  INVALID_AMOUNT: "Valor inválido", AMOUNTS_INCONSISTENT: "Bruto, taxas e líquido não fecham", INVALID_FIELD: "Campo inválido",
  INVALID_TRANSACTION_REF: "Número único da transação inválido", DUPLICATE_TRANSACTION: "Transação repetida no arquivo",
  DUPLICATE_INSTALLMENT: "Parcela repetida no arquivo", INVALID_MOVEMENT: "Movimento inválido", INVALID_TYPE: "Tipo diferente de Entrada/Saída",
  ZERO_AMOUNT: "Valor zerado", AMOUNT_SIGN_MISMATCH: "Sinal do valor não confere com o tipo", TOO_MANY_LINES: "Arquivo com linhas demais",
};

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

interface PendingFile { file: File; preview: PicpayFilePreview | null; error: string; result: string }

/** Spec 5.8 (FIN-001, FIN-002, FIN-003, FIN-007): PicPay reconciliation across Minhas vendas, Recebíveis and Extrato. */
export function PicPayReconciliation() {
  const { showToast } = useToast();
  const [period, setPeriod] = useState({ from: shift(today(), -29), to: today() });
  const [refresh, setRefresh] = useState(0);
  const [summary, setSummary] = useState<PicpaySummary | null>(null);
  const [exceptions, setExceptions] = useState<PicpayException[] | null>(null);
  const [settlements, setSettlements] = useState<PicpaySettlements | null>(null);
  const [transactions, setTransactions] = useState<PicpayTransaction[] | null>(null);
  const [imports, setImports] = useState<PicpayImport[] | null>(null);
  const [periods, setPeriods] = useState<PicpayPeriod[] | null>(null);
  const [error, setError] = useState("");
  // New files can add statement lines: the line review below starts over after each import.
  const [imported, setImported] = useState(0);
  const reload = () => setRefresh((value) => value + 1);

  const load = useCallback(async () => {
    setError("");
    const query = new URLSearchParams(period);
    const get = async <T,>(path: string, parse: (body: unknown) => T | null): Promise<T | null> => {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar a conciliação."));
      return parse(await response.json());
    };
    try {
      const [loadedSummary, loadedExceptions, loadedSettlements, loadedTransactions, loadedImports, loadedPeriods] = await Promise.all([
        get(`/api/v1/admin/finance/picpay/summary?${query}`, (body) => picpaySummaryResponseSchema.safeParse(body).data?.data ?? null),
        get(`/api/v1/admin/finance/picpay/exceptions?${query}`, (body) => picpayExceptionsResponseSchema.safeParse(body).data?.data ?? null),
        get(`/api/v1/admin/finance/picpay/settlements?${new URLSearchParams({ from: shift(period.from, -40), to: shift(period.to, 40) })}`,
          (body) => picpaySettlementsResponseSchema.safeParse(body).data?.data ?? null),
        get(`/api/v1/admin/finance/picpay/transactions?${query}`, (body) => picpayTransactionsResponseSchema.safeParse(body).data?.data ?? null),
        get("/api/v1/admin/finance/picpay/files", (body) => picpayImportsResponseSchema.safeParse(body).data?.data ?? null),
        get("/api/v1/admin/finance/picpay/periods", (body) => picpayPeriodsResponseSchema.safeParse(body).data?.data ?? null),
      ]);
      if (!loadedSummary || !loadedExceptions || !loadedSettlements || !loadedTransactions || !loadedImports || !loadedPeriods) {
        throw new Error("A conciliação retornou dados inválidos.");
      }
      setSummary(loadedSummary); setExceptions(loadedExceptions); setSettlements(loadedSettlements);
      setTransactions(loadedTransactions); setImports(loadedImports); setPeriods(loadedPeriods);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar a conciliação."); }
  }, [period]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load, refresh]);

  async function reconcile() {
    const response = await fetch("/api/v1/admin/finance/picpay/reconcile", { method: "POST" });
    if (!response.ok) { setError(await messageFrom(response, "Não foi possível conciliar agora.")); return; }
    showToast("Conciliação recalculada.", "success");
    reload();
  }

  return <div className="grid gap-6">
    <ImportFiles onImported={() => { setImported((value) => value + 1); reload(); }} />
    <Card className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field id="picpay-from" label="De"><Input id="picpay-from" type="date" value={period.from} onChange={(event) => setPeriod({ ...period, from: event.target.value })} /></Field>
          <Field id="picpay-to" label="Até"><Input id="picpay-to" type="date" value={period.to} onChange={(event) => setPeriod({ ...period, to: event.target.value })} /></Field>
        </div>
        <Button type="button" variant="ghost" onClick={() => void reconcile()}><RefreshCw className="size-4" />Conciliar agora</Button>
      </div>
    </Card>
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    {!summary && !error && <p role="status" className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando a conciliação…</p>}
    {summary && <SummaryCards summary={summary} />}
    {exceptions && <ExceptionsPanel exceptions={exceptions} onChanged={reload} />}
    {settlements && <SettlementsPanel settlements={settlements} />}
    {transactions && <TransactionsPanel transactions={transactions} />}
    {periods && <PeriodsPanel periods={periods} period={period} onChanged={reload} />}
    <Card className="p-5">
      <h2 className="font-semibold">Linhas do Extrato</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Revise as linhas que nenhuma evidência explicou: classifique, vincule a um pagamento existente, marque como já registrada ou classifique em lote.</p>
    </Card>
    <PicPayStatementImport key={imported} />
    {imports && <ImportsPanel imports={imports} />}
  </div>;
}

function ImportFiles({ onImported }: { onImported: () => void }) {
  const { showToast } = useToast();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const keys = useRef(new Map<string, string>());

  async function choose(list: FileList | null) {
    const chosen = Array.from(list ?? []);
    setFiles(chosen.map((file) => ({ file, preview: null, error: "", result: "" })));
    setBusy(true);
    try {
      const previews: PendingFile[] = [];
      for (const file of chosen) {
        const response = await fetch("/api/v1/admin/finance/picpay/files/preview", { method: "POST", headers: { "Content-Type": "text/csv" }, body: file });
        if (!response.ok) { previews.push({ file, preview: null, error: await messageFrom(response, "Não foi possível ler o arquivo."), result: "" }); continue; }
        const parsed = picpayFilePreviewResponseSchema.safeParse(await response.json());
        previews.push(parsed.success ? { file, preview: parsed.data.data, error: "", result: "" } : { file, preview: null, error: "A prévia retornou dados inválidos.", result: "" });
      }
      setFiles(previews);
    } finally { setBusy(false); }
  }

  async function importAll() {
    setBusy(true);
    const next = [...files];
    try {
      for (const [index, item] of next.entries()) {
        if (!item.preview?.sourceType || item.preview.errorCount > 0 || item.result) continue;
        if (item.preview.alreadyImported) { next[index] = { ...item, result: "Arquivo já importado." }; continue; }
        const key = keys.current.get(item.preview.sha256) ?? `picpay-file:${crypto.randomUUID()}`;
        keys.current.set(item.preview.sha256, key);
        const response = await fetch(`/api/v1/admin/finance/picpay/files?${new URLSearchParams({ fileName: item.file.name })}`, {
          method: "POST", headers: { "Content-Type": "text/csv", "Idempotency-Key": key }, body: item.file,
        });
        if (!response.ok) { next[index] = { ...item, result: await messageFrom(response, "Não foi possível importar.") }; continue; }
        const parsed = picpayImportResponseSchema.safeParse(await response.json());
        next[index] = { ...item, result: parsed.success
          ? `Importado como arquivo nº ${parsed.data.data.number}: ${parsed.data.data.newCount} novas, ${parsed.data.data.knownCount} já conhecidas, ${parsed.data.data.updatedCount} atualizadas.`
          : "Importado." };
      }
      setFiles(next);
      showToast("Arquivos processados.", "success");
      onImported();
    } finally { setBusy(false); }
  }

  const importable = files.some((item) => item.preview?.sourceType && item.preview.errorCount === 0 && !item.result);
  return <Card className="p-5">
    <section aria-label="Importar arquivos">
      <h2 className="font-semibold">Importar arquivos</h2>
      <p className="mt-1 max-w-3xl text-sm text-[var(--g-text-secondary)]">Envie as exportações do PicPay Empresas: Minhas vendas, Recebíveis e Extrato, juntas ou separadas, em qualquer ordem e com períodos sobrepostos. O tipo vem do cabeçalho do arquivo. O que já é conhecido não é duplicado e nada é gravado antes da importação.</p>
      <Field id="picpay-files" label="Arquivos CSV" className="mt-4 max-w-md">
        <input id="picpay-files" type="file" multiple accept=".csv,text/csv" className="g-input min-h-11 w-full" onChange={(event) => void choose(event.target.files)} />
      </Field>
      {busy && <p role="status" className="mt-3 flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Lendo os arquivos…</p>}
      {files.length > 0 && <div role="region" aria-label="Arquivos escolhidos" tabIndex={0} className="mt-4 overflow-x-auto"><table className="w-full min-w-[56rem] text-left text-sm">
        <caption className="sr-only">Arquivos escolhidos</caption>
        <thead className="text-[var(--g-text-muted)]"><tr><th className="py-1 pr-3 font-medium">Arquivo</th><th className="py-1 pr-3 font-medium">Tipo</th><th className="py-1 pr-3 font-medium">Período</th><th className="py-1 pr-3 font-medium">Linhas</th><th className="py-1 pr-3 font-medium">Novas</th><th className="py-1 pr-3 font-medium">Já conhecidas</th><th className="py-1 pr-3 font-medium">Atualizadas</th><th className="py-1 pr-3 font-medium">Ambíguas</th><th className="py-1 font-medium">Situação</th></tr></thead>
        <tbody>{files.map((item) => <tr key={item.file.name + item.file.size} className="border-t border-[var(--g-border-subtle)] align-top">
          <td className="py-2 pr-3">{item.file.name}{item.preview && <span className="block text-xs text-[var(--g-text-muted)]">SHA-256 {item.preview.sha256.slice(0, 12)}…</span>}</td>
          <td className="py-2 pr-3">{item.preview?.sourceType ? <span className="flex items-center gap-1"><CheckCircle2 className="size-4 text-[var(--g-status-success)]" />{sourceLabels[item.preview.sourceType]}</span> : "—"}</td>
          <td className="py-2 pr-3">{item.preview?.periodFrom && item.preview.periodTo ? `${formatDay(item.preview.periodFrom)} a ${formatDay(item.preview.periodTo)}` : "—"}</td>
          <td className="py-2 pr-3">{item.preview?.rowCount ?? "—"}</td><td className="py-2 pr-3">{item.preview?.newCount ?? "—"}</td>
          <td className="py-2 pr-3">{item.preview?.knownCount ?? "—"}</td><td className="py-2 pr-3">{item.preview?.updatedCount ?? "—"}</td>
          <td className="py-2 pr-3">{item.preview?.ambiguousCount ?? "—"}</td>
          <td className="py-2">{item.error ? <span className="text-[var(--g-status-danger)]">{item.error}</span>
            : item.result ? item.result
            : item.preview?.alreadyImported ? <span className="font-semibold">Arquivo já importado (nº {item.preview.alreadyImported.number}).</span>
            : item.preview && item.preview.errorCount > 0 ? <ul className="text-[var(--g-status-danger)]">{item.preview.errors.slice(0, 5).map((failure) => <li key={`${failure.line}-${failure.code}`}>{failure.line > 1 ? `Linha ${failure.line}: ` : ""}{errorLabels[failure.code] ?? failure.code}</li>)}</ul>
            : item.preview ? "Pronto para importar" : "—"}</td>
        </tr>)}</tbody>
      </table></div>}
      {files.length > 0 && <div className="mt-4"><Button type="button" loading={busy} disabled={busy || !importable} onClick={() => void importAll()}><FileUp className="size-4" />Importar arquivos</Button></div>}
    </section>
  </Card>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div><dt className="text-sm text-[var(--g-text-secondary)]">{label}</dt><dd className="g-money mt-1 text-xl font-bold">{value}</dd>{hint && <p className="text-xs text-[var(--g-text-muted)]">{hint}</p>}</div>;
}

function SummaryCards({ summary }: { summary: PicpaySummary }) {
  const byType = Object.entries(summary.exceptions.byType).sort(([, left], [, right]) => right - left);
  return <section aria-label="Resumo da conciliação" className="grid gap-4">
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="text-lg font-semibold">Período {formatDay(summary.period.from)} a {formatDay(summary.period.to)}</h2>
      <Badge tone={summary.status === "CONCILIADO" ? "success" : "warning"}>{summary.status === "CONCILIADO" ? "Conciliado" : "Com pendências"}</Badge>
      {summary.operatingSince && <span className="text-sm text-[var(--g-text-muted)]">Operação no Germinatura desde {formatDay(summary.operatingSince)}</span>}
    </div>
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="p-5"><h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">Vendas</h3><dl className="mt-3 grid grid-cols-2 gap-4">
        <Stat label="PDV" value={String(summary.pdvSales)} hint="pagamentos PicPay confirmados" />
        <Stat label="Minhas vendas" value={String(summary.picpay.transactions)} hint={`${summary.picpay.approved} aprovadas, ${summary.picpay.denied} negadas, ${summary.picpay.refunded} devolvidas`} />
        <Stat label="Vendas conciliadas" value={String(summary.picpay.linked)} hint={`${summary.picpay.historical} do histórico, sem venda no PDV`} />
        <Stat label="Taxa PicPay" value={formatMoney(summary.picpay.feeCents)} hint={`bruto ${formatMoney(summary.picpay.grossCents)} · líquido ${formatMoney(summary.picpay.netCents)}`} />
      </dl></Card>
      <Card className="p-5"><h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">Recebíveis</h3><dl className="mt-3 grid grid-cols-2 gap-4">
        <Stat label="A receber" value={formatMoney(summary.receivables.pendingCents)} hint={summary.receivables.overdueCents > 0 ? `${formatMoney(summary.receivables.overdueCents)} em atraso` : "nenhum em atraso"} />
        <Stat label="Liquidado no período" value={formatMoney(summary.receivables.settledCents)} />
        <Stat label="Último arquivo de Recebíveis" value={formatMoney(summary.receivables.snapshotCents)} hint="líquido listado no último snapshot" />
      </dl></Card>
      <Card className="p-5"><h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">Extrato</h3><dl className="mt-3 grid grid-cols-2 gap-4">
        <Stat label="Entradas" value={formatMoney(summary.statement.inflowCents)} />
        <Stat label="Saídas" value={formatMoney(summary.statement.outflowCents)} />
        <Stat label="Transferência interna" value={formatMoney(summary.statement.internalTransferCents)} hint="guardar e resgatar do Cofrinho" />
        <Stat label="Linhas a revisar" value={String(summary.statement.pendingLines)} />
      </dl></Card>
    </div>
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card className="p-5"><h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">Saldo em {formatDay(summary.balances.asOf)}</h3><dl className="mt-3 grid gap-4 sm:grid-cols-3">
        <Stat label="Saldo livre" value={formatMoney(summary.balances.freeBalanceCents)} />
        <Stat label="Cofrinho" value={formatMoney(summary.balances.vaultBalanceCents)} />
        <Stat label="Saldo financeiro total" value={formatMoney(summary.balances.availableBalanceCents)} hint="livre + Cofrinho; não é lucro" />
        <Stat label="A receber" value={formatMoney(summary.balances.receivablesBalanceCents)} hint="fora do saldo financeiro" />
        <Stat label="Pix em trânsito" value={formatMoney(summary.balances.pixClearingCents)} hint="vendas Pix ainda sem a entrada no Extrato" />
        <Stat label="Dinheiro físico" value={formatMoney(summary.balances.cashBalanceCents)} />
      </dl></Card>
      <Card className="p-5"><h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">Pendências</h3>
        {byType.length === 0 ? <p className="mt-3 text-sm text-[var(--g-text-secondary)]">Nenhuma pendência no período.</p>
          : <ul aria-label="Pendências por tipo" className="mt-3 grid gap-1 text-sm">{byType.map(([type, total]) => <li key={type} className="flex justify-between gap-3"><span>{exceptionLabels[type as PicpayExceptionType] ?? type}</span><strong>{total}</strong></li>)}</ul>}
      </Card>
    </div>
  </section>;
}

function describe(exception: PicpayException) {
  const details = exception.details;
  switch (exception.type) {
    case "VALOR_DIVERGENTE": return `PicPay ${formatMoney(Number(details.picpay_cents))} · PDV ${formatMoney(Number(details.pdv_cents))}`;
    case "LIQUIDACAO_SEM_EXPLICACAO": case "RECEBIVEL_EM_ATRASO":
      return `esperado ${formatMoney(Number(details.expected_cents))} · liquidado ${formatMoney(Number(details.settled_cents))}`;
    case "DUPLICIDADE": return `${details.observed_count} de ${details.known_count} movimentos idênticos no arquivo nº ${details.import_number}`;
    case "EXTRATO_NAO_CLASSIFICADO": return `${details.movement_label ?? ""} · arquivo nº ${details.import_number}, linha ${details.line_number}`;
    case "PICPAY_SEM_PDV": return `${details.method ?? ""}${details.terminal ? ` · terminal ${details.terminal}` : ""}`;
    default: return typeof details.transaction_ref === "string" ? `transação ${details.transaction_ref}` : "";
  }
}

function ExceptionsPanel({ exceptions, onChanged }: { exceptions: PicpayException[]; onChanged: () => void }) {
  const { showToast } = useToast();
  const [type, setType] = useState<PicpayExceptionType | "">("");
  const shown = exceptions.filter((exception) => !type || exception.type === type).slice(0, 200);
  const lonelyPayments = exceptions.filter((exception) => exception.type === "PDV_SEM_PICPAY" && exception.subjectId);
  async function resolve(exception: PicpayException, reason: string) {
    const response = await fetch("/api/v1/admin/finance/picpay/exceptions/resolve", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `picpay-exception:${crypto.randomUUID()}` },
      body: JSON.stringify({ key: exception.key, action: "RESOLVIDA", reason }),
    });
    if (!response.ok) { showToast(await messageFrom(response, "Não foi possível resolver a pendência."), "error"); return false; }
    showToast("Pendência resolvida.", "success"); onChanged(); return true;
  }
  async function link(exception: PicpayException, paymentAttemptId: string, reason: string) {
    const response = await fetch(`/api/v1/admin/finance/picpay/transactions/${exception.subjectId}/link`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `picpay-link:${crypto.randomUUID()}` },
      body: JSON.stringify({ paymentAttemptId, reason }),
    });
    if (!response.ok) { showToast(await messageFrom(response, "Não foi possível vincular."), "error"); return false; }
    showToast("Transação vinculada à venda do PDV.", "success"); onChanged(); return true;
  }
  return <Card className="overflow-hidden">
    <section aria-label="Pendências">
      <div className="flex flex-wrap items-end justify-between gap-3 p-5">
        <div><h2 className="font-semibold">Pendências</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">O que as evidências não explicam. Resolver exige motivo e fica auditado; nunca altera os arquivos.</p></div>
        <Field id="picpay-exception-type" label="Tipo"><select id="picpay-exception-type" className="g-input min-h-11" value={type} onChange={(event) => setType(event.target.value as PicpayExceptionType | "")}>
          <option value="">Todos</option>{Object.entries(exceptionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></Field>
      </div>
      {shown.length === 0 ? <p className="px-5 pb-5 text-sm text-[var(--g-text-secondary)]">Nenhuma pendência.</p>
        : <ul className="divide-y divide-[var(--g-border-subtle)] border-t border-[var(--g-border-subtle)]">{shown.map((exception) =>
          <ExceptionItem key={exception.key} exception={exception} lonelyPayments={lonelyPayments.filter((payment) => payment.occurredOn === exception.occurredOn)} onResolve={resolve} onLink={link} />)}</ul>}
    </section>
  </Card>;
}

function ExceptionItem({ exception, lonelyPayments, onResolve, onLink }: {
  exception: PicpayException; lonelyPayments: PicpayException[];
  onResolve: (exception: PicpayException, reason: string) => Promise<boolean>;
  onLink: (exception: PicpayException, paymentAttemptId: string, reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const [payment, setPayment] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<boolean>) => { setBusy(true); try { if (await action()) { setReason(""); setPayment(""); } } finally { setBusy(false); } };
  return <li aria-label={exceptionLabels[exception.type]} className="grid gap-2 p-5 text-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="font-semibold">{exceptionLabels[exception.type]}</p><p className="text-[var(--g-text-secondary)]">{formatDay(exception.occurredOn)}{describe(exception) ? ` · ${describe(exception)}` : ""}</p></div>
      <span className="g-money font-bold">{formatMoney(exception.amountCents)}</span>
    </div>
    {exception.type === "PICPAY_SEM_PDV" && lonelyPayments.length > 0 && <div className="flex flex-wrap items-end gap-2">
      <Field id={`link-${exception.key}`} label="Venda do PDV sem PicPay no mesmo dia"><select id={`link-${exception.key}`} className="g-input min-h-11" value={payment} onChange={(event) => setPayment(event.target.value)}>
        <option value="">Selecione</option>{lonelyPayments.map((item) => <option key={item.key} value={item.subjectId ?? ""}>{formatMoney(item.amountCents)} · {String(item.details.channel ?? "")}</option>)}
      </select></Field>
    </div>}
    <div className="flex flex-wrap items-end gap-2">
      <Field id={`reason-${exception.key}`} label="Motivo" className="min-w-64 flex-1"><Input id={`reason-${exception.key}`} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      {payment && <Button type="button" size="sm" disabled={busy || reason.trim().length < 8} onClick={() => void run(() => onLink(exception, payment, reason.trim()))}>Vincular à venda</Button>}
      <Button type="button" size="sm" variant="ghost" disabled={busy || reason.trim().length < 8} onClick={() => void run(() => onResolve(exception, reason.trim()))}>Resolver</Button>
    </div>
  </li>;
}

function SettlementsPanel({ settlements }: { settlements: PicpaySettlements }) {
  return <Card className="overflow-hidden">
    <section aria-label="Recebíveis e liquidações">
      <div className="p-5"><h2 className="font-semibold">Recebíveis e liquidações</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Por dia de pagamento: o líquido que Minhas vendas espera receber contra o que o Extrato liquidou em “Recebíveis de venda”. A liquidação do PicPay é agregada; o vínculo é pelo dia, nunca inventado por venda.</p></div>
      {settlements.days.length === 0 ? <p className="px-5 pb-5 text-sm text-[var(--g-text-secondary)]">Nenhum recebível no período.</p>
        : <div role="region" aria-label="Liquidações por dia" tabIndex={0} className="overflow-x-auto"><table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Liquidações por dia</caption>
          <thead className="border-y border-[var(--g-border-subtle)] text-[var(--g-text-muted)]"><tr><th className="p-3">Pagamento</th><th className="p-3">Situação</th><th className="p-3 text-right">Esperado</th><th className="p-3 text-right">Liquidado</th><th className="p-3 text-right">Último Recebíveis</th></tr></thead>
          <tbody className="divide-y divide-[var(--g-border-subtle)]">{settlements.days.map((day) => <tr key={day.paymentOn}>
            <td className="p-3">{formatDay(day.paymentOn)}</td><td className="p-3"><Badge tone={settlementLabels[day.status]?.tone ?? "info"}>{settlementLabels[day.status]?.label ?? day.status}</Badge></td>
            <td className="g-money p-3 text-right">{formatMoney(day.expectedNetCents)} <span className="text-xs text-[var(--g-text-muted)]">({day.expectedCount})</span></td>
            <td className="g-money p-3 text-right">{formatMoney(day.settledCents)} <span className="text-xs text-[var(--g-text-muted)]">({day.settledLines})</span></td>
            <td className="g-money p-3 text-right">{formatMoney(day.receivableSnapshotCents)}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </Card>;
}

function TransactionsPanel({ transactions }: { transactions: PicpayTransaction[] }) {
  return <Card className="overflow-hidden">
    <section aria-label="Minhas vendas">
      <div className="p-5"><h2 className="font-semibold">Minhas vendas</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Transações da adquirente no período, com a taxa real do PicPay e a venda do PDV vinculada.</p></div>
      {transactions.length === 0 ? <p className="px-5 pb-5 text-sm text-[var(--g-text-secondary)]">Nenhuma transação no período.</p>
        : <div role="region" aria-label="Transações de Minhas vendas" tabIndex={0} className="overflow-x-auto"><table className="w-full min-w-[56rem] text-left text-sm">
          <caption className="sr-only">Transações de Minhas vendas</caption>
          <thead className="border-y border-[var(--g-border-subtle)] text-[var(--g-text-muted)]"><tr><th className="p-3">Venda</th><th className="p-3">Forma</th><th className="p-3">Status</th><th className="p-3">Terminal</th><th className="p-3 text-right">Bruto</th><th className="p-3 text-right">Taxa PicPay</th><th className="p-3 text-right">Líquido</th><th className="p-3">PDV</th></tr></thead>
          <tbody className="divide-y divide-[var(--g-border-subtle)]">{transactions.slice(0, 150).map((transaction) => <tr key={transaction.id}>
            <td className="p-3 whitespace-nowrap">{formatTime(transaction.soldAt)}</td><td className="p-3">{transaction.method}{transaction.cardLast4 ? ` ·•••${transaction.cardLast4}` : ""}</td>
            <td className="p-3"><Badge tone={transaction.status === "APROVADA" ? "success" : transaction.status === "DEVOLVIDA" ? "warning" : "neutral"}>{transactionLabels[transaction.status]}</Badge></td>
            <td className="p-3">{transaction.terminal ?? "—"}</td>
            <td className="g-money p-3 text-right">{formatMoney(transaction.grossCents)}</td><td className="g-money p-3 text-right">{formatMoney(transaction.feeCents)}</td>
            <td className="g-money p-3 text-right">{formatMoney(transaction.netCents)}</td>
            <td className="p-3">{transaction.historical ? "Histórico" : transaction.paymentAttemptId ? <Badge tone="success">Venda conciliada</Badge> : <Badge tone="warning">Pendente</Badge>}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </Card>;
}

function PeriodsPanel({ periods, period, onChanged }: { periods: PicpayPeriod[]; period: { from: string; to: string }; onChanged: () => void }) {
  const { showToast } = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function close() {
    setBusy(true);
    try {
      const response = await fetch("/api/v1/admin/finance/picpay/periods", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `picpay-period:${crypto.randomUUID()}` },
        body: JSON.stringify({ from: period.from, to: period.to, note: note.trim() || null }),
      });
      if (!response.ok) { showToast(await messageFrom(response, "Não foi possível avaliar o período."), "error"); return; }
      const body = await response.json() as { data?: { status?: string } };
      showToast(body.data?.status === "CONCILIADO" ? "Período conciliado." : "Período avaliado com pendências.", body.data?.status === "CONCILIADO" ? "success" : "warning");
      setNote(""); onChanged();
    } finally { setBusy(false); }
  }
  return <Card className="p-5">
    <section aria-label="Fechamento da conciliação">
      <h2 className="font-semibold">Fechamento da conciliação</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Avalie o período escolhido. Importações posteriores continuam aceitas; se trouxerem nova evidência, o período volta para revisão.</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field id="picpay-period-note" label="Observação (opcional)" className="min-w-64 flex-1"><Input id="picpay-period-note" maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
        <Button type="button" loading={busy} disabled={busy} onClick={() => void close()}>Avaliar {formatDay(period.from)} a {formatDay(period.to)}</Button>
      </div>
      {periods.length > 0 && <ul aria-label="Períodos avaliados" className="mt-4 divide-y divide-[var(--g-border-subtle)] text-sm">{periods.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span>{formatDay(item.periodFrom)} a {formatDay(item.periodTo)} · {item.actorName} · {formatTime(item.createdAt)}{item.status === "REVISAR" ? ` · ${item.statusReason}` : ""}</span>
        <Badge tone={periodLabels[item.status]?.tone ?? "warning"}>{periodLabels[item.status]?.label ?? item.status}</Badge>
      </li>)}</ul>}
    </section>
  </Card>;
}

function ImportsPanel({ imports }: { imports: PicpayImport[] }) {
  return <Card className="p-5">
    <section aria-label="Arquivos importados">
      <h2 className="font-semibold">Arquivos importados</h2>
      {imports.length === 0 ? <p className="mt-3 text-sm text-[var(--g-text-secondary)]">Nenhum arquivo importado.</p>
        : <ul className="mt-3 divide-y divide-[var(--g-border-subtle)] text-sm">{imports.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span><strong>{sourceLabels[item.sourceType]}</strong> nº {item.number} · {formatDay(item.periodFrom)} a {formatDay(item.periodTo)} · {item.rowCount} linhas · {item.newCount} novas, {item.knownCount} já conhecidas{item.updatedCount ? `, ${item.updatedCount} atualizadas` : ""}{item.ambiguousCount ? `, ${item.ambiguousCount} ambíguas` : ""}</span>
          <span className="text-[var(--g-text-muted)]">{item.fileName} · {item.actorName} · {formatTime(item.createdAt)}</span>
        </li>)}</ul>}
    </section>
  </Card>;
}
