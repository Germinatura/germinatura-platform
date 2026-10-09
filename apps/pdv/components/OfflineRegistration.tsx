"use client";

import { useEffect } from "react";
import { browserPdvCohort } from "@/lib/pdv-cohort";

export function OfflineRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Without a PDV cohort (visitor, login) the snapshot is the anonymous public catalog; with one, the PDV home decides.
    const refreshPublic = () => { if (!browserPdvCohort()) refreshOfflineCatalog(true); };
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then(refreshPublic, () => {
      // Online operations remain available; the offline screen reports a missing snapshot.
      console.warn("A consulta offline não pôde ser preparada neste navegador.");
    });
    window.addEventListener("online", refreshPublic);
    return () => window.removeEventListener("online", refreshPublic);
  }, []);
  return null;
}

/**
 * Refreshes the offline catalog snapshot while the PDV operates in the default cohort, whose catalog is the anonymous
 * public one. In any other cohort the snapshot is dropped, so the offline screen never shows another cohort's prices.
 */
export function refreshOfflineCatalog(defaultCohort: boolean) {
  if (!("serviceWorker" in navigator) || !navigator.onLine) return;
  void navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage({ type: "REFRESH_PUBLIC_CATALOG", defaultCohort }))
    .catch(() => undefined);
}
