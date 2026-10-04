"use client";

import { useEffect } from "react";

export function OfflineRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
        await navigator.serviceWorker.ready;
        if (!disposed && navigator.onLine) registration.active?.postMessage({ type: "REFRESH_PUBLIC_CATALOG" });
      } catch {
        // Online operations remain available; the offline screen reports a missing snapshot.
        console.warn("A consulta offline não pôde ser preparada neste navegador.");
      }
    };
    void refresh();
    window.addEventListener("online", refresh);
    return () => { disposed = true; window.removeEventListener("online", refresh); };
  }, []);
  return null;
}
