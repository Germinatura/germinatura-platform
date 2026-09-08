import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:3000";
const headers = { Origin: origin, "Sec-Fetch-Site": "same-origin" };
test("Admin switches experience and shell has independent scroll regions", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  expect((await page.request.post("/api/auth/login", { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto("/admin/estoque");
  const sidebar = page.locator("aside");
  await expect(sidebar.getByRole("link", { name: "Visão do consumidor" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  const nav = sidebar.getByTestId("sidebar-scroll-container");
  await nav.evaluate((element) => { element.scrollTop = 300; });
  expect(await nav.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await sidebar.getByRole("link", { name: "Visão do consumidor" }).click();
  await expect(page).toHaveURL(/\/inicio$/);
  await expect(sidebar.getByRole("link", { name: "Catálogo", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Usuários e vendedores" })).toHaveCount(0);
  await page.getByRole("button", { name: "Abrir menu da conta" }).click();
  await page.getByRole("link", { name: "Perfil", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Meu perfil" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Visão administrativa" })).toBeVisible();
  const content = page.getByTestId("dashboard-scroll-container");
  await content.evaluate((element) => { element.scrollTop = 400; });
  expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await sidebar.getByRole("link", { name: "Visão administrativa" }).click();
  await expect(page).toHaveURL(origin + "/");
  await expect(sidebar.getByRole("link", { name: "Usuários e vendedores" })).toBeVisible();
});

test("Consumer edits private preferences and photo with revision protection", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await page.request.post("/api/auth/login", { headers, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
  const original = await (await page.request.get("/api/v1/profile")).json() as { data: { revision: number; displayName: string; avatarPath: string | null; bio: string; className: string; sweetPreferences: string[] } };
  await page.goto("/perfil");
  await page.getByLabel("Apresentação curta").fill("Gosto de experimentar novos doces.");
  await page.getByLabel("Turma ou grupo").fill("Turma de teste");
  await page.getByRole("checkbox", { name: "Cookie", exact: true }).check();
  // A real PNG is uploaded to local Storage; it is never a mocked persistence result.
  await page.getByLabel("Foto de perfil", { exact: true }).setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNkENnCgA0wYRUdtBIAoQQA2C9kUJoAAAAASUVORK5CYII=", "base64") });
  await page.getByRole("button", { name: "Salvar perfil" }).click();
  await expect(page.getByRole("status")).toHaveText("Perfil atualizado.");
  await page.reload();
  await expect(page.getByLabel("Apresentação curta")).toHaveValue("Gosto de experimentar novos doces.");
  await expect(page.getByRole("checkbox", { name: "Cookie", exact: true })).toBeChecked();
  const image = page.getByRole("img", { name: "Sua foto de perfil" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const saved = await (await page.request.get("/api/v1/profile")).json() as { data: { revision: number; avatarUrl: string; avatarPath: string } };
  expect(saved.data.avatarUrl).toContain("/object/sign/profile-photos/");
  expect((await page.request.get(saved.data.avatarUrl.replace("/object/sign/", "/object/public/").split("?")[0]!)).status()).not.toBe(200);
  const input = { expectedRevision: original.data.revision, displayName: original.data.displayName, avatarPath: null, bio: "", className: "", sweetPreferences: [] };
  expect((await page.request.patch("/api/v1/profile", { headers: { ...headers, "Idempotency-Key": `stale:${crypto.randomUUID()}` }, data: input })).status()).toBe(409);
  expect((await page.request.patch("/api/v1/profile", { headers: { ...headers, "Idempotency-Key": `roles:${crypto.randomUUID()}` }, data: { ...input, roles: ["ADMIN"] } })).status()).toBe(422);
  expect((await page.request.patch("/api/v1/profile", { headers: { Origin: "https://invalid.example", "Idempotency-Key": `origin:${crypto.randomUUID()}` }, data: input })).status()).toBe(403);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("profile-mobile.png") });
  // Restore shared fixture identity; retain isolated uploaded test object only in local storage.
  expect((await page.request.patch("/api/v1/profile", { headers: { ...headers, "Idempotency-Key": `restore:${crypto.randomUUID()}` }, data: { ...input, expectedRevision: saved.data.revision, bio: original.data.bio, className: original.data.className, sweetPreferences: original.data.sweetPreferences, avatarPath: original.data.avatarPath } })).status()).toBe(200);
});

test("Seller has a visible return to Portal without signing out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await page.request.post("/api/auth/login", { headers, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  await page.goto("http://127.0.0.1:3001/");
  await page.getByRole("link", { name: "Voltar ao Portal" }).click();
  await expect(page).toHaveURL(origin + "/");
  await expect(page.getByRole("button", { name: "Abrir menu da conta" })).toBeVisible();
});
