"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SidebarUser } from "./Sidebar";

/**
 * ADR 0011: the cohort the Portal works in, always visible. A selector appears for people with more than one cohort
 * (ADMIN_MASTER: every cohort and "Todas as turmas"). In "Todas" the Portal only reads: writes need a cohort.
 * The selection is validated by the server (POST /api/v1/session/cohort and the proxy on every request).
 */
export function CohortBar({ user, onChanged }: { user: SidebarUser; onChanged: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cohorts = user.cohorts ?? [];
  const canSelect = Boolean(user.adminMaster) || cohorts.length > 1;
  const current = user.cohortMode === "ALL" ? "all" : user.cohort?.id ?? "";
  if (!user.cohort && user.cohortMode !== "ALL" && !canSelect) return null;

  async function select(value: string) {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/v1/session/cohort", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cohort: value }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? "Não foi possível trocar de turma.");
      }
      onChanged();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível trocar de turma.");
    } finally { setBusy(false); }
  }

  return (
    <div className="border-b border-[var(--g-border-subtle)] bg-[var(--g-surface-default)] px-4 py-2 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {canSelect ? (
          <label className="flex items-center gap-2 font-semibold">Turma
            <select aria-label="Turma" disabled={busy} value={current} onChange={(event) => void select(event.target.value)}
              className="min-h-10 rounded-[var(--g-radius-control)] border border-[var(--g-border-default)] bg-[var(--g-surface-default)] px-3 font-normal">
              {current === "" && <option value="" disabled>Selecione uma turma</option>}
              {user.adminMaster && <option value="all">Todas as turmas</option>}
              {cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.name}{cohort.status === "ARCHIVED" ? " (arquivada)" : ""}</option>)}
            </select>
          </label>
        ) : <span className="font-semibold">{user.cohort?.name}</span>}
        {user.cohortMode === "ALL" && <p role="status" className="text-[var(--g-text-secondary)]">Visão de todas as turmas: somente consulta. Selecione uma turma para criar ou alterar dados.</p>}
        {user.cohortMode === "NONE" && <p role="status" className="text-[var(--g-status-warning-foreground)]">Selecione uma turma para continuar.</p>}
        {error && <p role="alert" className="text-[var(--g-status-danger-foreground)]">{error}</p>}
      </div>
    </div>
  );
}
