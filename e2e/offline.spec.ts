import { expect, test } from "@playwright/test";

const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";

test("PDV reloads a session-free public catalog offline without queuing operations", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${pdvUrl}/login`);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect.poll(() => page.evaluate(async () => Boolean(await (await caches.open("germinatura-pdv-catalog-v1")).match("/offline/catalog-snapshot")))).toBe(true);
  const snapshot = await page.evaluate(async () => (await (await caches.open("germinatura-pdv-catalog-v1")).match("/offline/catalog-snapshot"))?.json() as Promise<{ products: Array<{ name: string; amountCents: number }> }>);
  expect(snapshot.products.length).toBeGreaterThan(0);
  const keys = await page.evaluate(async () => {
    const all = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) all.push(new URL(request.url).pathname);
    }
    return all.sort();
  });
  expect(keys).toEqual(["/manifest.webmanifest", "/offline", "/offline.css", "/offline.js", "/offline/brand.svg", "/offline/catalog-snapshot"].sort());
  await context.setOffline(true);
  await page.goto(`${pdvUrl}/`);
  await expect(page.getByRole("heading", { name: "Catálogo salvo" })).toBeVisible();
  await expect(page.getByText("Esta tela não mantém", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: snapshot.products[0].name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Cobrar|Confirmar|Finalizar/ })).toHaveCount(0);
  expect(await page.evaluate(async () => {
    try { await fetch("/api/v1/sales/checkout", { method: "POST", body: "{}" }); return "sent"; } catch { return "blocked"; }
  })).toBe("blocked");
  await page.getByLabel("Buscar na cópia salva").fill("produto-inexistente");
  await expect(page.getByText("Nenhum produto encontrado nesta cópia.")).toBeVisible();
  await page.getByLabel("Buscar na cópia salva").fill("");
  await page.screenshot({ path: "test-results/pdv-offline-mobile.png", fullPage: true });
  for (const viewport of [{ width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel("Buscar na cópia salva").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Voltar ao PDV online" })).toBeFocused();
  }
  await page.evaluate(async () => {
    const cache = await caches.open("germinatura-pdv-catalog-v1");
    const response = await cache.match("/offline/catalog-snapshot");
    const data = await response?.json();
    await cache.put("/offline/catalog-snapshot", Response.json({ ...data, savedAt: Date.now() - 86400001 }));
  });
  await page.reload();
  await expect(page.getByText("Nenhuma cópia válida disponível.", { exact: false })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.getByRole("button", { name: "Apagar catálogo salvo" }).click();
  await expect(page.getByText("Catálogo salvo apagado deste dispositivo.")).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("link", { name: "Voltar ao PDV online" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
