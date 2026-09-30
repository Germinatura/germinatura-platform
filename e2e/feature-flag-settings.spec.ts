import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";

test("o administrador liga e desliga uma chave com motivo; chaves com condição pedem confirmação", async ({ page, browser }) => {
  test.slow();
  // Without a session nobody changes a switch.
  const anonymous = await browser.newContext({ baseURL: portalUrl });
  expect((await anonymous.request.patch("/api/v1/admin/feature-flags/comments", { headers: { Origin: portalUrl }, data: { enabled: true, reason: "Tentativa sem permissão" } })).status()).toBe(401);
  await anonymous.close();

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/configuracoes`);
  const flags = page.getByRole("list", { name: "Chaves funcionais" });
  const comments = flags.getByRole("listitem", { name: "Chave comments" });
  await expect(comments.getByText("Desligada")).toBeVisible();

  await comments.getByRole("button", { name: "Ligar" }).click();
  const confirm = comments.getByRole("button", { name: "Confirmar ligação" });
  await expect(confirm).toBeDisabled();
  await comments.getByLabel("Motivo").fill("Teste da configuração");
  await confirm.click();
  await expect(comments.getByText("Ligada", { exact: true })).toBeVisible();

  await comments.getByRole("button", { name: "Desligar" }).click();
  await comments.getByLabel("Motivo").fill("Fim do teste da configuração");
  await comments.getByRole("button", { name: "Confirmar desligamento" }).click();
  await expect(comments.getByText("Desligada", { exact: true })).toBeVisible();

  // payment_link must stay off: the form demands confirming its precondition, and the test cancels.
  const paymentLink = flags.getByRole("listitem", { name: "Chave payment_link" });
  await paymentLink.getByRole("button", { name: "Ligar" }).click();
  await expect(paymentLink.getByText(/Esta chave tem uma condição/)).toBeVisible();
  await paymentLink.getByLabel("Motivo").fill("Somente verificando a confirmação");
  await expect(paymentLink.getByRole("button", { name: "Confirmar ligação" })).toBeDisabled();
  await paymentLink.getByRole("button", { name: "Cancelar" }).click();
  await expect(paymentLink.getByText("Desligada", { exact: true })).toBeVisible();
});
