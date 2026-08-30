"use client";

import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/ui/Toast";

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
    <section className="flex flex-col gap-4 rounded-3xl border border-amber-200 bg-amber-50 p-7 md:flex-row md:items-center md:justify-between">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-black text-amber-950"><ShieldCheck className="size-5" aria-hidden="true" />Ativar primeiro administrador</h2>
        <p className="mt-1 text-sm text-amber-900">Esta operação é única, idempotente e será registrada na auditoria.</p>
      </div>
      <button type="button" disabled={loading} onClick={bootstrap} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-amber-900 px-5 py-3 font-black text-white disabled:opacity-60">
        {loading && <Loader2 aria-hidden="true" className="size-5 animate-spin" />}
        Ativar administração
      </button>
    </section>
  );
}
