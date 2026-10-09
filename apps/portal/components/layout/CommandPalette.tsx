"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { searchNavigation, type NavigationMatch, type NavigationSection } from "@/lib/navigation";

interface CommandPaletteProps {
  sections: NavigationSection[];
  onClose: () => void;
}

/** Screen search over the navigation the current user can reach. It never searches system data. */
export function CommandPalette({ sections, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const baseId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const matches = useMemo(() => searchNavigation(sections, query), [sections, query]);
  const selected = Math.min(activeIndex, Math.max(matches.length - 1, 0));

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function go(match: NavigationMatch | undefined) {
    if (!match) return;
    onClose();
    if (match.item.external) window.location.assign(match.item.href);
    else router.push(match.item.href);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex(matches.length ? (selected + 1) % matches.length : 0); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex(matches.length ? (selected - 1 + matches.length) % matches.length : 0); }
    else if (event.key === "Home" && event.ctrlKey) { event.preventDefault(); setActiveIndex(0); }
    else if (event.key === "End" && event.ctrlKey) { event.preventDefault(); setActiveIndex(Math.max(matches.length - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); go(matches[selected]); }
    else if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "Tab") event.preventDefault();
  }

  const listId = `${baseId}-results`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-[var(--g-surface-overlay)] px-4 pt-[12vh]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Pesquisar no menu" className="w-full max-w-lg overflow-hidden rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)] bg-[var(--g-surface-raised)] shadow-[var(--g-shadow-raised)]">
        <div className="flex items-center gap-3 border-b border-[var(--g-border-subtle)] px-4">
          <Search aria-hidden className="size-5 shrink-0 text-[var(--g-text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-label="Pesquisar telas"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={matches.length ? optionId(selected) : undefined}
            placeholder="Pesquisar telas e ações…"
            className="min-h-14 w-full bg-transparent text-base text-[var(--g-text-primary)] outline-none placeholder:text-[var(--g-text-muted)]"
          />
          <kbd className="rounded border border-[var(--g-border-default)] px-1.5 text-xs font-semibold text-[var(--g-text-muted)]">Esc</kbd>
        </div>
        <ul ref={listRef} id={listId} role="listbox" aria-label="Telas encontradas" className="max-h-[50vh] overflow-y-auto p-2">
          {matches.map((match, index) => {
            const Icon = match.item.icon;
            return (
              <li
                key={match.item.id}
                id={optionId(index)}
                data-index={index}
                role="option"
                aria-selected={index === selected}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => go(match)}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--g-radius-control)] px-3 text-sm ${index === selected ? "bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]" : "text-[var(--g-text-secondary)]"}`}
              >
                <Icon aria-hidden className="size-5 shrink-0" />
                <span className="flex-1 font-semibold">{match.item.label}</span>
                {match.item.cohortOnly && <span className="text-xs text-[var(--g-text-muted)]">por turma</span>}
                <span className="text-xs text-[var(--g-text-muted)]">{match.sectionLabel}</span>
              </li>
            );
          })}
        </ul>
        {matches.length === 0 && <p role="status" className="px-4 pb-5 pt-2 text-sm text-[var(--g-text-secondary)]">Nenhuma tela encontrada para “{query}”.</p>}
        <p className="border-t border-[var(--g-border-subtle)] px-4 py-2 text-xs text-[var(--g-text-muted)]">↑ ↓ para escolher · Enter para abrir · Busca só telas do menu, não dados.</p>
      </div>
    </div>
  );
}
