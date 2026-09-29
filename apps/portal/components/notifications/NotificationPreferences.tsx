"use client";

import { notificationPreferencesResponseSchema, type NotificationCategory } from "@germinatura/contracts";
import { Card } from "@germinatura/ui";
import { useEffect, useState } from "react";

// Only categories that already produce notices are offered; the others arrive with their sources.
const offered: Array<{ category: NotificationCategory; label: string; description: string }> = [
  { category: "COMUNICADOS", label: "Comunicados da comissão", description: "Avisos enviados pela comunicação." },
  { category: "ESTOQUE_DE_VOLTA", label: "Produto de volta", description: "Quando um produto que você pediu para acompanhar voltar ao estoque." },
];

/** NOTIF-004: optional categories; notices about your own reservations, payments and raffles always arrive. */
export function NotificationPreferences() {
  const [enabled, setEnabled] = useState<Partial<Record<NotificationCategory, boolean>>>({});
  const [saving, setSaving] = useState<NotificationCategory | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/v1/notifications/preferences", { cache: "no-store" }).then(async (response) => {
      const parsed = notificationPreferencesResponseSchema.safeParse(await response.json().catch(() => null));
      if (response.ok && parsed.success) setEnabled(Object.fromEntries(parsed.data.data.map((item) => [item.category, item.enabled])));
      else setError("Não foi possível carregar suas preferências.");
    }, () => setError("Não foi possível carregar suas preferências."));
  }, []);

  async function toggle(category: NotificationCategory, value: boolean) {
    const previous = enabled[category];
    setEnabled((current) => ({ ...current, [category]: value }));
    setSaving(category); setError("");
    try {
      const response = await fetch("/api/v1/notifications/preferences", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category, enabled: value }),
      });
      const parsed = notificationPreferencesResponseSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) throw new Error();
      setEnabled(Object.fromEntries(parsed.data.data.map((item) => [item.category, item.enabled])));
    } catch {
      setEnabled((current) => ({ ...current, [category]: previous }));
      setError("Não foi possível salvar a preferência.");
    }
    finally { setSaving(null); }
  }

  return <Card className="p-5" aria-label="Preferências de notificação">
    <h2 className="font-semibold">Preferências</h2>
    <p className="mt-1 text-sm text-[var(--g-text-secondary)]">Avisos sobre suas reservas, pagamentos e números de rifa sempre chegam.</p>
    <ul className="mt-4 space-y-3">{offered.map((item) => <li key={item.category}>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1" checked={enabled[item.category] ?? true} disabled={saving === item.category || enabled[item.category] === undefined}
          onChange={(event) => void toggle(item.category, event.target.checked)} />
        <span><span className="font-semibold">{item.label}</span><span className="block text-[var(--g-text-secondary)]">{item.description}</span></span>
      </label>
    </li>)}</ul>
    {error && <p role="alert" className="mt-3 text-sm text-[var(--g-status-danger)]">{error}</p>}
  </Card>;
}
