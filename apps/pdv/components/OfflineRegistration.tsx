"use client";

import { useEffect } from "react";

export function OfflineRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // The offline copy is saved by the PDV home, for the cohort it operates in; there is no anonymous or default copy.
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // Online operations remain available; the offline screen reports a missing snapshot.
      console.warn("A consulta offline não pôde ser preparada neste navegador.");
    });
  }, []);
  return null;
}

export interface OfflineCohort {
  id: string;
  slug: string;
  name: string;
}

function postToWorker(message: Record<string, unknown>) {
  if (!("serviceWorker" in navigator)) return Promise.resolve();
  return navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage(message))
    .catch(() => undefined);
}

/**
 * ADR 0011: refreshes the offline copy of the public catalog of the cohort the PDV operates in, stored under that
 * cohort only. The offline screen opens the copy of the selected cohort and nothing else.
 */
export function refreshOfflineCatalog(cohort: OfflineCohort) {
  if (!navigator.onLine) return;
  void postToWorker({ type: "REFRESH_COHORT_CATALOG", cohortId: cohort.id, slug: cohort.slug, name: cohort.name });
}

/**
 * Logout, the sign-in page or a new sign-in: every cohort's offline copy leaves this device. Never blocks the caller for
 * long (a browser without an active worker has no copy to clear).
 */
export function clearOfflineCatalogs(): Promise<void> {
  return Promise.race([postToWorker({ type: "CLEAR_OFFLINE_CATALOGS" }), new Promise<void>((resolve) => { window.setTimeout(resolve, 1500); })]);
}
