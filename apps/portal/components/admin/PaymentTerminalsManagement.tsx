"use client";

import { paymentTerminalResponseSchema, paymentTerminalsResponseSchema, savePaymentTerminalRequestSchema, type PaymentTerminal } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";

async function messageFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? fallback;
}

/** Spec 6.7: finance keeps the internal registry of the establishment's Maquininhas. */
export function PaymentTerminalsManagement() {
  const { showToast } = useToast();
  const [terminals, setTerminals] = useState<PaymentTerminal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState<{ id: string; code: string; label: string } | null>(null);
  const keys = useRef(new Map<string, string>());
  const keyFor = (scope: string, payload: unknown) => {
    const fingerprint = `${scope}:${JSON.stringify(payload)}`;
    const existing = keys.current.get(fingerprint);
    if (existing) return existing;
    const created = `terminal-${scope}:${crypto.randomUUID()}`;
    keys.current.set(fingerprint, created);
    return created;
  };

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/v1/admin/finance/terminals", { cache: "no-store" });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível carregar as maquininhas."));
      const parsed = paymentTerminalsResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("A consulta retornou dados inválidos.");
      setTerminals(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar as maquininhas."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function save(id: string | null, payload: { code: string; label: string; active: boolean }, success: string) {
    const parsed = savePaymentTerminalRequestSchema.safeParse(payload);
    if (!parsed.success) { setError("Use um código com letras, números e hífen e um nome com pelo menos 2 caracteres."); return false; }
    const scope = id ?? "new";
    setBusy(scope); setError("");
    try {
      const response = await fetch(id ? `/api/v1/admin/finance/terminals/${id}` : "/api/v1/admin/finance/terminals", {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor(scope, parsed.data) },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) throw new Error(await messageFrom(response, "Não foi possível salvar a maquininha."));
      if (!paymentTerminalResponseSchema.safeParse(await response.json()).success) throw new Error("A maquininha retornou dados inválidos.");
      showToast(success, "success");
      await load();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar a maquininha."); return false; }
    finally { setBusy(null); }
  }

  async function submitNew(event: React.FormEvent) {
    event.preventDefault();
    if (await save(null, { code, label, active: true }, "Maquininha cadastrada.")) { setCode(""); setLabel(""); }
  }

  return <div className="grid gap-6">
    <Card className="p-5">
      <h2 className="font-semibold">Cadastrar maquininha</h2>
      <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Use um código interno (por exemplo, MAQ-01). Com pelo menos uma maquininha ativa, o vendedor precisa informar qual usou em cada pagamento com cartão.</p>
      <form aria-label="Cadastrar maquininha" onSubmit={submitNew} className="mt-4 grid gap-4 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
        <Field id="terminal-code" label="Código"><Input id="terminal-code" required maxLength={32} value={code} onChange={(event) => setCode(event.target.value)} /></Field>
        <Field id="terminal-label" label="Nome"><Input id="terminal-label" required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} /></Field>
        <Button type="submit" loading={busy === "new"} disabled={busy !== null}><Plus className="size-4" />Cadastrar</Button>
      </form>
    </Card>
    {error && <div role="alert" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-status-danger)]/50 p-4 text-sm"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--g-status-danger)]" /><p>{error}</p></div>}
    <Card className="overflow-hidden">
      {loading ? <p role="status" className="flex items-center gap-2 p-5 text-sm text-[var(--g-text-secondary)]"><Loader2 className="size-4 animate-spin" />Carregando maquininhas…</p>
        : terminals.length === 0 ? <p className="p-5 text-sm text-[var(--g-text-secondary)]">Nenhuma maquininha cadastrada. Enquanto isso, o PDV registra só o método do cartão.</p>
        : <ul aria-label="Maquininhas" className="divide-y divide-[var(--g-border-subtle)]">
          {terminals.map((terminal) => <li key={terminal.id} aria-label={`Maquininha ${terminal.code}`} className="p-5">
            {editing?.id === terminal.id
              ? <form aria-label={`Editar ${terminal.code}`} className="grid gap-3 sm:grid-cols-[10rem_1fr_auto_auto] sm:items-end" onSubmit={async (event) => {
                event.preventDefault();
                if (await save(terminal.id, { code: editing.code, label: editing.label, active: terminal.active }, "Maquininha atualizada.")) setEditing(null);
              }}>
                <Field id={`terminal-code-${terminal.id}`} label="Código"><Input id={`terminal-code-${terminal.id}`} required value={editing.code} onChange={(event) => setEditing({ ...editing, code: event.target.value })} /></Field>
                <Field id={`terminal-label-${terminal.id}`} label="Nome"><Input id={`terminal-label-${terminal.id}`} required value={editing.label} onChange={(event) => setEditing({ ...editing, label: event.target.value })} /></Field>
                <Button type="submit" size="sm" loading={busy === terminal.id} disabled={busy !== null}>Salvar</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setEditing(null)}>Cancelar</Button>
              </form>
              : <div className="flex flex-wrap items-center justify-between gap-3">
                <div><p className="font-mono font-semibold">{terminal.code}</p><p className="text-sm text-[var(--g-text-secondary)]">{terminal.label}</p></div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={terminal.active ? "success" : "neutral"}>{terminal.active ? "Ativa" : "Inativa"}</Badge>
                  <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setEditing({ id: terminal.id, code: terminal.code, label: terminal.label })}>Editar</Button>
                  <Button type="button" size="sm" variant="secondary" loading={busy === terminal.id} disabled={busy !== null}
                    onClick={() => void save(terminal.id, { code: terminal.code, label: terminal.label, active: !terminal.active }, terminal.active ? "Maquininha desativada." : "Maquininha reativada.")}>
                    {terminal.active ? "Desativar" : "Reativar"}
                  </Button>
                </div>
              </div>}
          </li>)}
        </ul>}
    </Card>
  </div>;
}
