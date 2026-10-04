"use client";

import { useState } from "react";
import { AuditExplorer } from "@/components/admin/AuditExplorer";
import { SecurityEventsView } from "@/components/admin/SecurityEventsView";

/** AUD-001: the audit trail of actions and the security log of logins and denials. */
export function AuditTabs() {
  const [tab, setTab] = useState<"actions" | "security">("actions");
  const tabClass = (active: boolean) => `min-h-11 border-b-2 px-4 text-sm font-semibold ${active ? "border-[var(--g-brand-primary)] text-[var(--g-text-primary)]" : "border-transparent text-[var(--g-text-secondary)]"}`;
  return <div className="grid gap-6">
    <div role="tablist" aria-label="Tipo de registro" className="flex gap-1 border-b border-[var(--g-border-subtle)]">
      <button type="button" role="tab" aria-selected={tab === "actions"} className={tabClass(tab === "actions")} onClick={() => setTab("actions")}>Ações</button>
      <button type="button" role="tab" aria-selected={tab === "security"} className={tabClass(tab === "security")} onClick={() => setTab("security")}>Segurança</button>
    </div>
    {tab === "actions" ? <AuditExplorer /> : <SecurityEventsView />}
  </div>;
}
