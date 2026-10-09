"use client";

import { useState } from "react";
import { GraduationCap } from "lucide-react";
import type { CohortSummary } from "@germinatura/contracts";
import { Button, Card } from "@germinatura/ui";

/** Explicit cohort choice before a cohort-only screen or action (the server validates it again). */
export function CohortChooser({ cohorts, next }: { cohorts: CohortSummary[]; next: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(id: string) {
    setBusy(id); setError(null);
    try {
      const response = await fetch("/api/v1/session/cohort", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cohort: id }) });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? "Não foi possível selecionar a turma.");
      }
      window.location.assign(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível selecionar a turma.");
      setBusy(null);
    }
  }

  return (
    <Card className="p-5">
      {error && <p role="alert" className="mb-4 text-sm text-[var(--g-status-danger-foreground)]">{error}</p>}
      {cohorts.length === 0
        ? <p className="text-sm">Nenhuma turma aberta disponível.</p>
        : <ul aria-label="Turmas" className="grid gap-3 sm:grid-cols-2">
            {cohorts.map((cohort) => <li key={cohort.id}>
              <Button type="button" variant="secondary" size="lg" className="w-full justify-start" loading={busy === cohort.id} disabled={busy !== null}
                onClick={() => void choose(cohort.id)}>
                <GraduationCap className="size-5" /> {cohort.name}
              </Button>
            </li>)}
          </ul>}
    </Card>
  );
}
