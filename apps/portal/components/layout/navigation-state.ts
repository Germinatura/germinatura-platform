"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { NavigationSectionId } from "@/lib/navigation";

// Collapsed sections are a per-browser convenience; losing them only reopens every section.
const storageKey = "germinatura:nav-collapsed-sections";
const changeEvent = "germinatura:nav-sections-changed";

function read(): string {
  try { return localStorage.getItem(storageKey) ?? "[]"; } catch { return "[]"; }
}

function subscribe(callback: () => void) {
  window.addEventListener(changeEvent, callback);
  window.addEventListener("storage", callback);
  return () => { window.removeEventListener(changeEvent, callback); window.removeEventListener("storage", callback); };
}

function write(collapsed: NavigationSectionId[]) {
  try { localStorage.setItem(storageKey, JSON.stringify(collapsed)); } catch { /* storage unavailable: keep the session default */ }
  window.dispatchEvent(new Event(changeEvent));
}

export function useCollapsedSections() {
  const raw = useSyncExternalStore(subscribe, read, () => "[]");
  const collapsed = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((value): value is NavigationSectionId => typeof value === "string") : []);
    } catch {
      return new Set<NavigationSectionId>();
    }
  }, [raw]);
  const setCollapsed = useCallback((id: NavigationSectionId, value: boolean) => {
    const next = new Set(collapsed);
    if (value) next.add(id); else next.delete(id);
    write([...next]);
  }, [collapsed]);
  return { collapsed, setCollapsed };
}
