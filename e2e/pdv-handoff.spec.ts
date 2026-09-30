import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";

test("o vendedor abre o PDV pelo Portal sem digitar a senha; o código vale uma única vez", async ({ page, browser }) => {
  test.slow();
  // Consumers never receive a code.
  const consumer = await browser.newContext({ baseURL: portalUrl });
  expect((await consumer.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "consumidor.teste", password: "Consumidor123!" } })).status()).toBe(200);
  expect((await consumer.request.post("/api/v1/pdv/handoff", { headers: { Origin: portalUrl } })).status()).toBe(403);
  await consumer.close();

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier: "vendedor.teste", password: "Vendedor123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/inicio`);
  await page.waitForLoadState("networkidle");
  // The page navigates right after the answer, so keep a copy of its body on the way through.
  let issued: { data: { url: string } } | null = null;
  await page.route("**/api/v1/pdv/handoff", async (route) => {
    const response = await route.fetch();
    issued = await response.json() as { data: { url: string } };
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Abrir PDV" }).click();
  await expect.poll(() => issued).not.toBeNull();
  if (!issued) throw new Error("handoff not issued");
  expect((issued as { data: { url: string } }).data.url).toMatch(new RegExp(`^${pdvUrl.replace(/[.]/g, "\\.")}/acesso#handoff=[A-Za-z0-9_-]{43}$`));
  await page.waitForURL(`${pdvUrl}/`, { timeout: 60_000 });
  await expect(page.getByRole("navigation", { name: "Operação do PDV" })).toBeVisible();

  // The same code, replayed in another browser, opens nothing.
  const other = await browser.newContext();
  const replay = await other.newPage();
  await replay.goto((issued as { data: { url: string } }).data.url);
  await expect(replay.getByText(/expirou|inválido/)).toBeVisible();
  await expect(replay.getByRole("link", { name: "Entrar com usuário e senha" })).toBeVisible();
  await other.close();
});
