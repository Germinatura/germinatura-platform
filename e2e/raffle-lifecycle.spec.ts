import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";

test("a gestão leva a rifa do rascunho ao cancelamento pelo ciclo de vida", async ({ page }) => {
  test.slow();
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl }, data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/rifas`);
  const name = `Rifa ciclo ${Date.now().toString(36)}`;
  await page.getByText("Nova campanha", { exact: true }).click();
  await page.getByLabel("Nome da campanha").first().fill(name);
  await page.getByLabel("Quantidade de números").first().fill("10");
  await page.getByLabel("Produto vinculado").first().selectOption({ label: "Item público A" });
  await page.getByLabel("Localização central").first().selectOption({ label: "Estoque central" });
  await page.getByLabel("Início (horário deste dispositivo)").first().fill("2026-01-01T10:00");
  await page.getByLabel("Encerramento (horário deste dispositivo)").first().fill("2030-09-02T10:00");
  await page.getByRole("button", { name: "Criar campanha" }).click();
  await expect(page.getByRole("status")).toHaveText("Campanha criada e auditada.");
  await page.getByLabel("Buscar campanha").fill(name);
  const card = page.getByRole("heading", { name }).locator("xpath=ancestor::div[contains(@class,'space-y-4')][1]");
  await expect(card.getByText("Rascunho", { exact: true })).toBeVisible();

  // The draft can still change its structure.
  await card.getByRole("button", { name: "Editar rascunho" }).click();
  const edit = page.getByRole("form", { name: `Editar ${name}` });
  await edit.getByLabel("Quantidade de números").fill("25");
  await edit.getByLabel("Descrição para os compradores (opcional)").fill("Concorra a uma cesta de doces.");
  await edit.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(page.getByRole("status")).toHaveText("Rascunho atualizado.");
  await expect(card.getByText(/25 números/)).toBeVisible();

  await card.getByRole("button", { name: "Publicar" }).click();
  await card.getByRole("button", { name: "Confirmar publicação" }).click();
  await expect(page.getByRole("status")).toHaveText("Rifa publicada. As vendas estão abertas.");
  await expect(card.getByText("Aberta", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Editar rascunho" })).toHaveCount(0);
  await expect(card.getByLabel(`Ocupação de ${name}`).getByText("25")).toBeVisible();

  await card.getByRole("button", { name: "Pausar vendas" }).click();
  await card.getByRole("button", { name: "Confirmar pausa" }).click();
  await expect(card.getByText("Pausada", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Retomar vendas" }).click();
  await card.getByRole("button", { name: "Confirmar retomada" }).click();
  await expect(card.getByText("Aberta", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Cancelar rifa" }).click();
  await expect(card.getByRole("button", { name: "Confirmar cancelamento" })).toBeDisabled();
  await card.getByLabel("Motivo do cancelamento").fill("Prêmio indisponível");
  await card.getByRole("button", { name: "Confirmar cancelamento" }).click();
  await expect(page.getByRole("status")).toHaveText("Rifa cancelada. Reservas pendentes foram liberadas.");
  await expect(card.getByText("Cancelada: Prêmio indisponível")).toBeVisible();
});
