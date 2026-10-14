import { expect, test, type Page } from "@playwright/test";

const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const cohortA = "c0000000-0000-4000-8000-000000002026";
const catalogA = `germinatura-pdv-catalog-v2:${cohortA}`;

const catalogCaches = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((name) => name.startsWith("germinatura-pdv-catalog-")));

test("PDV reloads its cohort's session-free public catalog offline without queuing operations", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${pdvUrl}/login`);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  // ADR 0011: before a cohort is chosen there is no copy at all (no anonymous or default-cohort snapshot).
  expect(await catalogCaches(page)).toEqual([]);

  await page.getByLabel("Usuário ou e-mail").fill("vendedor.teste");
  await page.getByLabel("Senha").fill("Vendedor123!");
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(`${pdvUrl}/`, { timeout: 60_000 });
  await expect.poll(() => page.evaluate(async (name) => Boolean(await (await caches.open(name)).match("/offline/catalog-snapshot")), catalogA), { timeout: 30_000 }).toBe(true);
  expect(await catalogCaches(page)).toEqual([catalogA]);
  const snapshot = await page.evaluate(async (name) => (await (await caches.open(name)).match("/offline/catalog-snapshot"))?.json() as Promise<{ cohortId: string; cohortName: string; products: Array<{ name: string; amountCents: number }> }>, catalogA);
  expect(snapshot.cohortId).toBe(cohortA);
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
  await expect(page.getByText(`Turma: ${snapshot.cohortName}`)).toBeVisible();
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
  await page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const response = await cache.match("/offline/catalog-snapshot");
    const data = await response?.json();
    await cache.put("/offline/catalog-snapshot", Response.json({ ...data, savedAt: Date.now() - 86400001 }));
  }, catalogA);
  await page.reload();
  await expect(page.getByText("Nenhuma cópia válida disponível.", { exact: false })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.getByRole("button", { name: "Apagar catálogos salvos" }).click();
  await expect(page.getByText("Catálogos salvos apagados deste dispositivo.")).toBeVisible();
  expect(await catalogCaches(page)).toEqual([]);
  await context.setOffline(false);
  await page.getByRole("link", { name: "Voltar ao PDV online" }).click();
  await expect(page).toHaveURL(`${pdvUrl}/`);
});
