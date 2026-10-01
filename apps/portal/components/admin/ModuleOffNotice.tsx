import Link from "next/link";
import { Info } from "lucide-react";

/** Shown on a module screen whose flag is off: the history stays readable, new operations are refused. */
export function ModuleOffNotice({ flag, children }: { flag: string; children: React.ReactNode }) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-[var(--g-radius-card)] border border-[var(--g-border-default)] bg-[var(--g-surface-subtle)] p-4 text-sm">
      <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-[var(--g-brand-primary)]" />
      <div>
        <p className="font-semibold">Módulo desligado em Configurações (<code>{flag}</code>)</p>
        <p className="mt-1 text-[var(--g-text-secondary)]">{children} <Link href="/admin/configuracoes" className="font-semibold text-[var(--g-brand-primary)]">Ver chaves funcionais</Link></p>
      </div>
    </div>
  );
}
