"use client";

import { pdvHandoffResponseSchema } from "@germinatura/contracts";
import { ArrowRight } from "lucide-react";
import { useState } from "react";

/** Spec 6.1: "Abrir PDV" with the Portal session — a single-use code carries the identity to the PDV. */
export function OpenPdvButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/pdv/handoff", { method: "POST", cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error((body as { message?: string } | null)?.message ?? "Não foi possível abrir o PDV agora.");
      const parsed = pdvHandoffResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("Não foi possível abrir o PDV agora.");
      window.location.assign(parsed.data.data.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível abrir o PDV agora."); setBusy(false); }
  }
  return <>
    <button type="button" onClick={() => void open()} disabled={busy} className="mt-5 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--g-brand-primary)] disabled:opacity-60">{busy ? "Abrindo…" : "Abrir PDV"} <ArrowRight className="size-4" /></button>
    {error && <p role="alert" className="mt-2 text-sm text-[var(--g-status-danger)]">{error}</p>}
  </>;
}
