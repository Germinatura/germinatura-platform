import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";

test("o administrador desbloqueia a recuperação de senha bloqueada por excesso de pedidos", async ({ page, browser }) => {
  test.slow();
  // A visitor exhausts the recovery requests of the consumer account.
  const visitor = await browser.newContext({ baseURL: portalUrl });
  const requestRecovery = () => visitor.request.post("/api/v1/auth/password-recovery/request", { headers: { Origin: portalUrl }, data: { identifier: "consumidor.teste" } });
  let status = 0;
  for (let attempt = 0; attempt < 5 && status !== 429; attempt += 1) status = (await requestRecovery()).status();
  expect(status).toBe(429);

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/usuarios`);
  const row = page.getByRole("row").filter({ hasText: "consumidor.teste" });
  await expect(row.getByText("Recuperação de senha bloqueada")).toBeVisible();
  await row.getByRole("button", { name: /Editar acesso de/ }).click();
  const unlock = page.getByRole("dialog").getByRole("region", { name: "Desbloqueios" });
  const button = unlock.getByRole("button", { name: "Desbloquear recuperação de senha" });
  await expect(button).toBeDisabled();
  await unlock.getByLabel("Motivo do desbloqueio").fill("Identidade confirmada pela comissão");
  const unlocked = page.waitForResponse((response) => response.url().endsWith("/password-recovery") && response.request().method() === "POST");
  await button.click();
  expect((await unlocked).status()).toBe(200);
  await expect(page.getByRole("row").filter({ hasText: "consumidor.teste" }).getByText("Recuperação de senha bloqueada")).toHaveCount(0);

  // The account can ask for recovery again.
  expect((await requestRecovery()).status()).toBe(202);
  await visitor.close();
});
