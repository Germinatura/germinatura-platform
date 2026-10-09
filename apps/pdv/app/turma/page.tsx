"use client";

import { BrandMark, Button, Card } from "@germinatura/ui";
import { GraduationCap, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

interface CohortOption {
  id: string;
  name: string;
  year: number;
  status: "PREPARING" | "ACTIVE" | "ARCHIVED";
}

/**
 * ADR 0011: the PDV always operates inside one cohort. This page lists only the cohorts in which the database
 * confirms the PDV role and selects one on the PDV server; "Todas as turmas" never exists here.
 */
export default function CohortSelectionPage() {
  const [cohorts, setCohorts] = useState<CohortOption[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000";

  useEffect(() => {
    void fetch("/api/auth/cohort", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) { window.location.assign("/login"); return; }
        if (!response.ok) throw new Error();
        const body = await response.json() as { cohort: string | null; cohorts: CohortOption[] };
        setCohorts(body.cohorts); setCurrent(body.cohort);
      })
      .catch(() => { setCohorts([]); setError("Não foi possível carregar suas turmas. Tente novamente."); });
  }, []);

  async function choose(id: string) {
    setChoosing(id); setError("");
    try {
      const response = await fetch("/api/auth/cohort", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cohort: id }) });
      const body = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "Não foi possível selecionar a turma.");
      window.location.replace("/");
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : "Não foi possível selecionar a turma.");
      setChoosing(null);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--g-surface-canvas)] p-4">
      <Card className="w-full max-w-md p-6 sm:p-8">
        <BrandMark title="Germinatura" tone="inverse" className="mx-auto size-12 text-white" />
        <h1 className="mt-5 text-center text-2xl font-bold tracking-tight">Escolha a turma</h1>
        <p className="mt-2 text-center text-sm text-[var(--g-text-secondary)]">O PDV opera dentro de uma turma: estoque, catálogo, vendas e caixa são dela.</p>
        {error && <p role="alert" className="mt-5 rounded-[var(--g-radius-control)] border border-[var(--g-status-danger)]/50 px-4 py-3 text-sm font-semibold text-[var(--g-status-danger)]">{error}</p>}
        {cohorts === null
          ? <div className="mt-6 flex justify-center"><Loader2 aria-label="Carregando turmas" className="size-6 animate-spin text-[var(--g-operation-primary)]" /></div>
          : cohorts.length === 0
            ? <div className="mt-6 text-center text-sm">
                <p>Sua conta não tem acesso ao PDV em nenhuma turma ativa.</p>
                <a href={portalUrl} className="mt-4 inline-flex min-h-11 items-center font-semibold text-[var(--g-brand-primary)]">Voltar ao Portal</a>
              </div>
            : <ul aria-label="Turmas disponíveis" className="mt-6 grid gap-3">
                {cohorts.map((cohort) => <li key={cohort.id}>
                  <Button type="button" variant={cohort.id === current ? "brand" : "secondary"} size="lg" className="w-full justify-start"
                    loading={choosing === cohort.id} disabled={choosing !== null} onClick={() => void choose(cohort.id)}>
                    <GraduationCap className="size-5" /> {cohort.name}{cohort.id === current ? " (atual)" : ""}
                  </Button>
                </li>)}
              </ul>}
      </Card>
    </main>
  );
}
