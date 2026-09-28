import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";

test("financeiro registra uma despesa auditada e a estorna sem apagar o original", async ({ page }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const description = `Frete do evento ${tag}`;
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  await page.goto(`${portalUrl}/admin/financeiro/lancamentos`);

  const form = page.getByRole("form", { name: "Novo lançamento" });
  await form.getByLabel("Categoria").selectOption("TRANSPORTE");
  await form.getByLabel("Valor (R$)").fill("150,00");
  await form.getByLabel("Descrição").fill(description);
  await form.getByLabel("Referência (opcional)").fill(`NF-${tag}`);
  await form.getByRole("button", { name: "Registrar" }).click();
  await expect(page.getByText("Lançamento registrado.")).toBeVisible();
  const entry = page.getByRole("listitem", { name: `Lançamento ${description}` });
  await expect(entry).toBeVisible();
  await expect(entry.getByText("−R$ 150,00")).toBeVisible();

  // Sale revenue never comes from a manual entry, even through the API.
  const blocked = await page.request.post(`${portalUrl}/api/v1/admin/finance/entries`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-entry-sale-${tag}` },
    data: { kind: "INCOME", category: "VENDA_PDV", account: "DINHEIRO_FISICO", counterAccount: null, amountCents: 2_590,
      occurredOn: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()), description: "Venda avulsa", reference: null },
  });
  expect(blocked.status()).toBe(422);

  await entry.getByRole("button", { name: "Estornar" }).click();
  await entry.getByLabel("Motivo do estorno").fill("Frete lançado em duplicidade");
  await entry.getByRole("button", { name: "Confirmar estorno" }).click();
  await expect(page.getByText("Lançamento estornado.")).toBeVisible();
  await expect(entry.getByText("Estornado.")).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Lançamento Frete lançado em duplicidade" }).first()).toBeVisible();
});
