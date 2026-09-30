import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const credentials = { identifier: "consumidor.teste", password: "Consumidor123!" };

test("a pessoa vê as próprias sessões e encerra a que não reconhece", async ({ page, browser }) => {
  test.slow();
  // Another device signed in as the same person.
  const other = await browser.newContext({ baseURL: portalUrl });
  expect((await other.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: credentials })).status()).toBe(200);
  const otherSessions = await (await other.request.get("/api/v1/account/sessions")).json() as { data: Array<{ id: string; current: boolean }> };
  const otherId = otherSessions.data.find((session) => session.current)?.id;
  expect(otherId).toBeTruthy();

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: credentials })).status()).toBe(200);
  // The current session cannot be ended from the list: that is what logging out is for.
  const mine = await (await page.request.get(`${portalUrl}/api/v1/account/sessions`)).json() as { data: Array<{ id: string; current: boolean }> };
  const myId = mine.data.find((session) => session.current)?.id;
  expect((await page.request.delete(`${portalUrl}/api/v1/account/sessions/${myId}`, { headers: { Origin: portalUrl } })).status()).toBe(409);

  expect((await page.request.delete(`${portalUrl}/api/v1/account/sessions/${otherId}`, { headers: { Origin: portalUrl } })).status()).toBe(200);
  expect((await other.request.get("/api/v1/account/sessions")).status()).toBe(401);
  await other.close();

  await page.goto(`${portalUrl}/perfil`);
  const sessions = page.getByRole("list", { name: "Sessões ativas" });
  await expect(sessions.getByRole("listitem", { name: "Sessão atual" }).getByText("Esta sessão")).toBeVisible();
  const endOthers = page.getByRole("button", { name: "Encerrar as outras sessões" });
  if (await endOthers.isVisible()) {
    await endOthers.click();
    await expect(sessions.getByRole("listitem")).toHaveCount(1);
  }
  await expect(sessions.getByRole("listitem")).toHaveCount(1);
});
