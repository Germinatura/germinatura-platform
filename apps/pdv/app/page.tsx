"use client";

import { BrandMark } from "@germinatura/ui";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { refreshOfflineCatalog } from "@/components/OfflineRegistration";
import { SaleWorkspace } from "@/components/operations/SaleWorkspace";
import { apiFetch } from "@/lib/api";

export interface PdvCohort {
  id: string;
  name: string;
  slug?: string;
  isDefault?: boolean;
}

export interface PdvSessionUser {
  nome: string;
  email: string;
  perfil: "ADMIN_MASTER" | "ADMIN" | "FINANCEIRO" | "VENDEDOR" | "CONSUMIDOR";
  roles: string[];
  cohort: PdvCohort | null;
  cohorts: PdvCohort[];
}

export default function PdvHome() {
  const [user, setUser] = useState<PdvSessionUser | null>(null);

  useEffect(() => {
    apiFetch("/api/v1/auth/session")
      .then(async (response) => {
        if (!response.ok) throw new Error("Sessão inválida");
        return response.json() as Promise<{ user: PdvSessionUser }>;
      })
      .then((data) => setUser(data.user))
      .catch(() => window.location.assign("/login"));
  }, []);

  // ADR 0011: the offline copy is the public catalog of the cohort this session operates in, saved under that cohort.
  const cohortId = user?.cohort?.id ?? null;
  const cohortSlug = user?.cohort?.slug ?? null;
  const cohortName = user?.cohort?.name ?? null;
  useEffect(() => {
    if (!cohortId || !cohortSlug || !cohortName) return;
    const refresh = () => refreshOfflineCatalog({ id: cohortId, slug: cohortSlug, name: cohortName });
    refresh();
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, [cohortId, cohortSlug, cohortName]);

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--g-surface-canvas)]">
        <div className="grid justify-items-center gap-4 text-[var(--g-text-secondary)]">
          <BrandMark className="size-12 text-white" title="Germinatura" tone="inverse" />
          <Loader2 aria-label="Carregando o PDV" className="size-7 animate-spin text-[var(--g-operation-primary)]" />
        </div>
      </main>
    );
  }

  return <SaleWorkspace user={user} />;
}
