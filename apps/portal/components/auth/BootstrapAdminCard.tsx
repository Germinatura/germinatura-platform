"use client";

import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@germinatura/ui";

export function BootstrapAdminCard() {
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  async function bootstrap() {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/admin/bootstrap", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Bootstrap indisponível");
      showToast("Administrador inicial ativado", "success");
      window.location.reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Bootstrap indisponível", "error");
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-[var(--g-radius-card)] border border-[var(--g-status-warning)] bg-[var(--g-status-warning-soft)] p-6 md:flex-row md:items-center md:justify-between">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--g-status-warning-foreground)]"><ShieldCheck className="size-5" aria-hidden="true" />Ativar primeiro administrador</h2>
        <p className="mt-1 text-sm text-[var(--g-status-warning-foreground)]">Esta operação é única, idempotente e será registrada na auditoria.</p>
      </div>
      <Button type="button" variant="secondary" disabled={loading} onClick={bootstrap}>
        {loading && <Loader2 aria-hidden="true" className="size-5 animate-spin" />}
        Ativar administração
      </Button>
    </section>
  );
}
