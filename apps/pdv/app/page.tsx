"use client";

import { BrandMark } from "@germinatura/ui";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { SaleWorkspace } from "@/components/operations/SaleWorkspace";
import { apiFetch } from "@/lib/api";

export interface PdvSessionUser {
  nome: string;
  email: string;
  perfil: "ADMIN" | "FINANCEIRO" | "VENDEDOR" | "CONSUMIDOR";
  roles: string[];
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
