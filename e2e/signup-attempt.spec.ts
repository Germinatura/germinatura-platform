import { expect, test } from "@playwright/test";
import { latestEmailCode } from "./support/mailbox";

const portal = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const headers = { Origin: portal, "Sec-Fetch-Site": "same-origin" };

// A1: a sign-up attempt is not a user. It is invisible to user management until the code is validated, and a blocked
// attempt is released by e-mail, with the same answer whether or not it was blocked.
test("uma tentativa de cadastro não confirmada não aparece na Gestão de Usuários; o código válido cria a pessoa", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const email = `tentativa.e2e.${Date.now().toString(36)}@institutojef.org.br`;
  const attempt = await browser.newContext({ baseURL: portal });
  expect((await attempt.request.post("/api/v1/auth/signup/request", { headers, data: { email } })).status()).toBe(202);

  expect((await page.request.post("/api/auth/login", { headers, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  const search = async () => (await (await page.request.get(`/api/v1/admin/users?q=${encodeURIComponent(email)}`)).json()) as { page: { matched: number; total: number } };
  const before = await search();
  expect(before.page.matched).toBe(0);

  await page.goto("/admin/usuarios");
  await page.getByLabel("E-mail institucional").fill(email);
  await page.getByLabel("Motivo", { exact: true }).fill("Pessoa confirmada presencialmente");
  await page.getByRole("button", { name: "Liberar novos códigos" }).click();
  await expect(page.getByRole("status").filter({ hasText: "novos códigos de cadastro já podem ser solicitados" })).toContainText(email);

  // The same person validates the code: now, and only now, a consumer of the default cohort exists.
  const token = await latestEmailCode(attempt.request, email);
  expect((await attempt.request.post("/api/v1/auth/signup/verify", { headers, data: { email, token } })).status()).toBe(200);
  const after = await search();
  expect(after.page.matched).toBe(1);
  expect(after.page.total).toBe(before.page.total + 1);
  await attempt.close();
});
