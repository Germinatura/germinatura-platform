"use client";

import { BrandMark, Card } from "@germinatura/ui";
import { useEffect, useState } from "react";
import { clearOfflineCatalogs } from "@/components/OfflineRegistration";

/**
 * Spec 6.1: landing page of "Abrir PDV". The single-use code arrives in the URL fragment (never sent to servers or
 * logs), is removed from the address bar at once and redeemed by the PDV server, which opens the session.
 */
export default function HandoffPage() {
  const [message, setMessage] = useState("Abrindo o PDV…");
  const [failed, setFailed] = useState(false);

  useEffect(() => { const timer = window.setTimeout(() => {
    const match = /^#handoff=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
    window.history.replaceState(null, "", window.location.pathname);
    if (!match) { setFailed(true); setMessage("Link de acesso inválido. Abra o PDV pelo Portal ou entre com usuário e senha."); return; }
    void fetch("/api/auth/handoff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: match[1] }) })
      .then(async (response) => {
        // ADR 0011: the handoff may open another person or cohort; no previous offline copy survives it.
        if (response.ok) { await clearOfflineCatalogs(); window.location.replace("/"); return; }
        const body = await response.json().catch(() => null) as { message?: string } | null;
        setFailed(true); setMessage(body?.message ?? "Não foi possível abrir o PDV.");
      }, () => { setFailed(true); setMessage("Sem conexão. Tente abrir o PDV de novo pelo Portal."); });
  }, 0); return () => window.clearTimeout(timer); }, []);

  return <main className="flex min-h-dvh items-center justify-center bg-[var(--g-surface-canvas)] p-6">
    <Card className="w-full max-w-sm p-6 text-center">
      <BrandMark title="Germinatura" className="mx-auto size-12" />
      <p role={failed ? "alert" : "status"} className="mt-5 text-sm">{message}</p>
      {failed && <a href="/login" className="mt-4 inline-flex min-h-11 items-center font-semibold text-[var(--g-brand-primary)]">Entrar com usuário e senha</a>}
    </Card>
  </main>;
}
