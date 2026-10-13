"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "./index";

/** From this width the filters sit inline in the page; below it they open in a bottom sheet (same cut as `.g-field-action`). */
export const FILTER_INLINE_QUERY = "(min-width: 48rem)";

export interface ActiveFilter {
  key: string;
  /** What the chip says, for example "Turma: 3º B". Its button is named "Remover filtro <label>". */
  label: string;
  onRemove: () => void;
}

function subscribeToWidth(callback: () => void) {
  const media = window.matchMedia(FILTER_INLINE_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
const inlineSnapshot = () => window.matchMedia(FILTER_INLINE_QUERY).matches;
// The server does not know the width: neither layout is assumed until the browser says (the inline panel is also hidden
// on narrow screens by CSS, so a phone never flashes it).
const unknownWidth = () => null;

/**
 * Text of the filters button. Inline and open it collapses the panel; otherwise it opens the panel or the sheet and says
 * how many filters are in effect.
 */
export function filterTriggerLabel({ inline, expanded, count }: { inline: boolean | null; expanded: boolean; count: number }) {
  if (inline === true && expanded) return "Recolher filtros";
  return count > 0 ? `Filtros (${count})` : "Filtros";
}

interface FilterShellProps<T> {
  /** The filters in effect. */
  value: T;
  /** Puts new filters in effect: inline on every change, in the sheet only on "Aplicar". */
  onChange: (next: T) => void;
  /** The values without any filter; "Limpar" in the sheet goes back to them before applying. */
  emptyValue: T;
  /** Filters in effect, shown as removable chips next to the button. May include filters outside the panel (search). */
  activeFilters: ActiveFilter[];
  /** The number in "Filtros (n)": filters set inside the panel. Defaults to the number of chips. */
  activeCount?: number;
  /** "Limpar filtros": clears every filter of the screen, including those outside the panel. */
  onClearAll: () => void;
  /** The fields, bound to the filters in effect (inline) or to the sheet's draft (narrow screens). */
  children: (value: T, update: (patch: Partial<T>) => void) => ReactNode;
  /** Whether the inline panel starts open. Collapsing never clears values. */
  defaultExpanded?: boolean;
  /** Accessible name of the panel and title of the sheet. */
  title?: string;
  className?: string;
}

/**
 * One filter pattern for every screen with several filters. Wide screens: an inline panel that can be collapsed
 * ("Recolher filtros" / "Filtros (n)") and applies each change at once. Narrow screens: a "Filtros (n)" button opens a
 * bottom sheet with its own draft, "Limpar" and "Aplicar"; closing it any other way keeps the filters in effect.
 * Chips and "Limpar filtros" stay visible in both. A main text search that is useful all the time stays outside.
 */
export function FilterShell<T>({
  value, onChange, emptyValue, activeFilters, activeCount = activeFilters.length, onClearAll, children,
  defaultExpanded = true, title = "Filtros", className,
}: FilterShellProps<T>) {
  const id = useId();
  const panelId = `${id}-panel`;
  const titleId = `${id}-title`;
  const inline = useSyncExternalStore<boolean | null>(subscribeToWidth, inlineSnapshot, unknownWidth);
  const [expanded, setExpanded] = useState(defaultExpanded);
  // The sheet's own copy of the filters while it is open; null when closed.
  const [draft, setDraft] = useState<T | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The latest filters, so two inline changes before the next render build on each other instead of on a stale copy.
  const latest = useRef(value);
  useEffect(() => { latest.current = value; }, [value]);
  function updateInline(patch: Partial<T>) {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    onChange(next);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (draft === null || !dialog) return;
    // Growing past the breakpoint with the sheet open: the inline panel takes over, the draft is dropped.
    if (inline) dialog.close();
    else if (!dialog.open) dialog.showModal();
  }, [draft, inline]);

  function closeSheet() { dialogRef.current?.close(); }
  function sheetClosed() {
    setDraft(null);
    triggerRef.current?.focus();
  }
  function apply() {
    if (draft !== null) onChange(draft);
    closeSheet();
  }

  const label = filterTriggerLabel({ inline, expanded, count: activeCount });
  const sheet = inline === false;
  return (
    <div className={["g-filter-shell", className].filter(Boolean).join(" ")}>
      <div className="g-filter-shell__bar">
        <button
          ref={triggerRef}
          type="button"
          className="g-button g-button--secondary g-button--sm g-filter-shell__trigger"
          aria-expanded={sheet ? draft !== null : expanded}
          aria-controls={sheet ? undefined : panelId}
          aria-haspopup={sheet ? "dialog" : undefined}
          onClick={() => (sheet ? setDraft(value) : setExpanded((open) => !open))}
        >
          <FilterIcon />
          {label}
        </button>
        {activeFilters.length > 0 && (
          <ul className="g-filter-shell__chips" aria-label="Filtros ativos">
            {activeFilters.map((filter) => (
              <li key={filter.key}>
                <button type="button" className="g-filter-chip" onClick={filter.onRemove} aria-label={`Remover filtro ${filter.label}`}>
                  <span>{filter.label}</span>
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
        {activeFilters.length > 0 && <Button type="button" variant="ghost" size="sm" onClick={onClearAll}>Limpar filtros</Button>}
      </div>

      {inline !== false && (
        <div id={panelId} role="group" aria-label={title} className="g-filter-shell__panel" hidden={!expanded}>
          {children(value, updateInline)}
        </div>
      )}

      {draft !== null && (
        <dialog
          ref={dialogRef}
          className="g-filter-sheet"
          aria-labelledby={titleId}
          onClose={sheetClosed}
          // A tap on the backdrop lands on the dialog itself (the frame fills it): close without applying.
          onClick={(event) => { if (event.target === event.currentTarget) closeSheet(); }}
        >
          <form
            className="g-filter-sheet__frame"
            onSubmit={(event) => { event.preventDefault(); apply(); }}
          >
            <header className="g-filter-sheet__header">
              <h2 id={titleId} className="g-filter-sheet__title">{title}</h2>
              <button type="button" className="g-filter-sheet__close" onClick={closeSheet} aria-label="Fechar filtros"><CloseIcon /></button>
            </header>
            <div className="g-filter-sheet__body">
              {children(draft, (patch) => setDraft((current) => (current === null ? current : { ...current, ...patch })))}
            </div>
            <footer className="g-filter-sheet__footer">
              <Button type="button" variant="secondary" onClick={() => setDraft(emptyValue)}>Limpar</Button>
              <Button type="submit">Aplicar</Button>
            </footer>
          </form>
        </dialog>
      )}
    </div>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h18M6 12h12M10 19h4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
