"use client";

import { accountSessionsResponseSchema, endAccountSessionsResponseSchema, type AccountSession } from "@germinatura/contracts";
import { Badge, Button, Card } from "@germinatura/ui";
import { MonitorSmartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui/Toast";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

/** A short, human label for a browser user agent; the raw value stays available on hover. */
function deviceLabel(userAgent: string | null) {
  if (!userAgent) return "Dispositivo desconhecido";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "Navegador";
  const system = /Android/.test(userAgent) ? "Android" : /iPhone|iPad/.test(userAgent) ? "iOS" : /Windows/.test(userAgent) ? "Windows" : /Mac OS/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : "";
  return system ? `${browser} no ${system}` : browser;
}

/** Spec 4.8: the person's own sessions; unrecognized ones can be ended here, the current one by logging out. */
export function AccountSessions() {
  const { showToast } = useToast();
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/account/sessions", { cache: "no-store" });
      const parsed = accountSessionsResponseSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) throw new Error("Não foi possível carregar suas sessões.");
      setSessions(parsed.data.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar suas sessões."); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function end(id: string | null) {
    setBusy(id ?? "others"); setError("");
    try {
      const response = await fetch(id ? `/api/v1/account/sessions/${id}` : "/api/v1/account/sessions", { method: "DELETE" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error((body as { message?: string } | null)?.message ?? "Não foi possível encerrar a sessão.");
      const parsed = endAccountSessionsResponseSchema.safeParse(body);
      showToast(parsed.success && parsed.data.data.ended > 1 ? `${parsed.data.data.ended} sessões encerradas.` : "Sessão encerrada.", "success");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível encerrar a sessão."); }
    finally { setBusy(null); }
  }

  const others = sessions?.filter((session) => !session.current) ?? [];
  return <div className="px-4 pb-10 sm:px-6 lg:px-8"><div className="mx-auto max-w-[var(--g-content-standard)]">
    <Card className="grid gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Sessões ativas</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Onde sua conta está conectada. Encerre o que você não reconhece e troque a senha se desconfiar de acesso indevido.</p></div>
        {others.length > 0 && <Button type="button" variant="secondary" size="sm" loading={busy === "others"} disabled={busy !== null} onClick={() => void end(null)}>Encerrar as outras sessões</Button>}
      </div>
      {error && <p role="alert" className="text-sm text-[var(--g-status-danger)]">{error}</p>}
      {sessions === null ? !error && <p role="status" className="text-sm">Carregando…</p>
        : <ul aria-label="Sessões ativas" className="divide-y divide-[var(--g-border-subtle)]">{sessions.map((session) => <li key={session.id} aria-label={session.current ? "Sessão atual" : `Sessão ${deviceLabel(session.userAgent)}`} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
          <div className="flex items-start gap-3"><MonitorSmartphone className="mt-0.5 size-5 shrink-0 text-[var(--g-text-muted)]" /><div>
            <p className="font-semibold" title={session.userAgent ?? undefined}>{deviceLabel(session.userAgent)}{session.current && <Badge tone="success" className="ml-2">Esta sessão</Badge>}</p>
            <p className="text-[var(--g-text-secondary)]">Ativa em {dateTime.format(new Date(session.lastActiveAt))} · iniciada em {dateTime.format(new Date(session.createdAt))}</p>
          </div></div>
          {!session.current && <Button type="button" variant="ghost" size="sm" loading={busy === session.id} disabled={busy !== null} onClick={() => void end(session.id)}>Encerrar</Button>}
        </li>)}</ul>}
    </Card>
  </div></div>;
}
