"use client";

import { featureFlagSchema, featureFlagsResponseSchema, featureFlagUpdateResponseSchema } from "@germinatura/contracts";
import { Badge, Button, Card, Field, Input } from "@germinatura/ui";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { useToast } from "@/components/ui/Toast";

type FeatureFlag = z.infer<typeof featureFlagSchema>;

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
// Flags whose description warns about a precondition get an explicit confirmation before turning on.
const needsCare = (flag: FeatureFlag) => /somente|homolog/i.test(flag.description);

/** Spec 5.17: functional switches (reservations, online sale, community, payment methods...), changed with a reason and audited. */
export function FeatureFlagsSettings() {
  const { showToast } = useToast();
  const [flags, setFlags] = useState<FeatureFlag[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<FeatureFlag | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/v1/feature-flags", { cache: "no-store" }).then(async (response) => {
      const parsed = featureFlagsResponseSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) throw new Error("Não foi possível carregar as chaves funcionais.");
      setFlags(parsed.data.data);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Não foi possível carregar as chaves funcionais."));
  }, []);

  function start(flag: FeatureFlag) { setEditing(flag); setReason(""); setConfirmed(false); setError(""); }

  async function apply() {
    if (!editing) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/admin/feature-flags/${editing.key}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !editing.enabled, reason: reason.trim() }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error((body as { message?: string } | null)?.message ?? "Não foi possível alterar a chave.");
      const parsed = featureFlagUpdateResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("A chave retornou dados inválidos.");
      setFlags((current) => current?.map((flag) => flag.key === parsed.data.data.key ? parsed.data.data : flag) ?? null);
      showToast(parsed.data.data.enabled ? "Chave ligada." : "Chave desligada.", "success");
      setEditing(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar a chave."); }
    finally { setBusy(false); }
  }

  const turningOnWithCare = editing !== null && !editing.enabled && needsCare(editing);
  const ready = reason.trim().length >= 4 && (!turningOnWithCare || confirmed);
  return <Card className="grid gap-4 p-5">
    <div><h2 className="text-lg font-semibold">Chaves funcionais</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Ligam ou desligam recursos para todos. Cada mudança exige motivo e fica na auditoria; as regras de permissão continuam valendo.</p></div>
    {error && <p role="alert" className="text-sm text-[var(--g-status-danger)]">{error}</p>}
    {flags === null ? !error && <p role="status" className="text-sm">Carregando…</p>
      : <ul aria-label="Chaves funcionais" className="divide-y divide-[var(--g-border-subtle)]">{flags.map((flag) => <li key={flag.key} aria-label={`Chave ${flag.key}`} className="grid gap-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="font-semibold"><code>{flag.key}</code></p><p className="text-sm text-[var(--g-text-secondary)]">{flag.description}</p><p className="text-xs text-[var(--g-text-muted)]">Alterada em {dateTime.format(new Date(flag.updatedAt))}</p></div>
          <div className="flex items-center gap-2"><Badge tone={flag.enabled ? "success" : "neutral"}>{flag.enabled ? "Ligada" : "Desligada"}</Badge>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => start(flag)}>{flag.enabled ? "Desligar" : "Ligar"}</Button></div>
        </div>
        {editing?.key === flag.key && <form aria-label={`${flag.enabled ? "Desligar" : "Ligar"} ${flag.key}`} className="grid gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-surface-subtle)] p-3" onSubmit={(event) => { event.preventDefault(); if (ready) void apply(); }}>
          {turningOnWithCare && <div className="flex items-start gap-2 text-sm text-[var(--g-status-warning-foreground)]"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><p>Esta chave tem uma condição: “{flag.description}”. Ligue só se ela já foi cumprida.</p></div>}
          <Field id={`flag-reason-${flag.key}`} label="Motivo"><Input id={`flag-reason-${flag.key}`} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></Field>
          {turningOnWithCare && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>Confirmo que a condição acima foi cumprida</span></label>}
          <div className="flex gap-2"><Button type="submit" size="sm" variant={flag.enabled ? "danger" : "brand"} loading={busy} disabled={!ready || busy}>{flag.enabled ? "Confirmar desligamento" : "Confirmar ligação"}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancelar</Button></div>
        </form>}
      </li>)}</ul>}
  </Card>;
}
