import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
// Anonymized fixture with the structure of the real PicPay Empresas export; never the original file.
const fixture = readFileSync(join(__dirname, "fixtures", "picpay-statement-anonymized.csv"), "utf8");

test("financeiro importa o extrato PicPay com prévia, recusa o mesmo arquivo e classifica uma linha pendente", async ({ page }) => {
  test.slow();
  const tag = Date.now().toString(36);
  // A run-specific description keeps the file new on a shared database; everything else is the fixture.
  const content = fixture.replace("Papelaria Exemplo", `Papelaria ${tag}`);
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  // The dev server compiles each route on its first request: warm the statement routes before the journey.
  const zero = "00000000-0000-4000-8000-000000000000";
  for (const request of [
    page.request.get(`${portalUrl}/api/v1/admin/finance/statement-imports`),
    page.request.post(`${portalUrl}/api/v1/admin/finance/statement-imports/preview`, { headers: { Origin: portalUrl } }),
    page.request.get(`${portalUrl}/api/v1/admin/finance/statement-imports/${zero}/lines`),
    page.request.post(`${portalUrl}/api/v1/admin/finance/statement-lines/${zero}/resolve`, { headers: { Origin: portalUrl } }),
  ]) expect((await request).status()).toBeLessThan(500);
  await page.goto(`${portalUrl}/admin/financeiro/importar-extrato`);
  // The import list is loaded by the client: once it shows, the file input has its handler.
  await expect(page.getByText(/aguardando revisão em todas as importações|Nenhum extrato importado/).first()).toBeVisible({ timeout: 90_000 });

  // A partially invalid file shows each problem and cannot be imported.
  const broken = content.replace("2026-09-01;Pix recebido;Cliente Exemplo Dois", "2026-02-30;Pix recebido;Cliente Exemplo Dois");
  await page.getByLabel("Arquivo CSV").setInputFiles({ name: `invalido-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(broken) });
  const preview = page.getByRole("region", { name: "Prévia da importação" });
  await expect(preview.getByText("Linha 4: Data inválida")).toBeVisible();
  await expect(preview.getByRole("button", { name: "Importar extrato" })).toBeDisabled();

  await page.getByLabel("Arquivo CSV").setInputFiles({ name: `extrato-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(content) });
  await expect(preview.getByText("Transferências automáticas (Cofrinho e recebíveis):")).toContainText("3");
  await expect(preview.getByText(/linhas têm data, descrição e valor iguais/)).toBeVisible();
  // Earlier runs on the same database used the same dates: confirm the overlap when it is reported.
  const overlap = preview.getByRole("checkbox");
  if (await overlap.isVisible()) await overlap.check();
  await preview.getByRole("button", { name: "Importar extrato" }).click();
  await expect(page.getByText(/Extrato importado como importação nº \d+\./)).toBeVisible();

  const line = page.getByRole("listitem", { name: "Linha 7" });
  await expect(line).toContainText(`Papelaria ${tag}`);
  await expect(line.getByText("A revisar")).toBeVisible();
  await line.getByLabel("Categoria").selectOption("MATERIAIS");
  await line.getByRole("button", { name: "Classificar" }).click();
  await expect(page.getByText("Linha 7 revisada.")).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Linha 7" })).toHaveCount(0);

  // The same file is refused, through the screen and through the API.
  await page.getByLabel("Arquivo CSV").setInputFiles({ name: `de-novo-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(content) });
  await expect(preview.getByText(/Este arquivo já foi importado/)).toBeVisible();
  const again = await page.request.post(`${portalUrl}/api/v1/admin/finance/statement-imports?fileName=de-novo.csv&acceptOverlap=true`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-statement-again-${tag}`, "Content-Type": "text/csv" }, data: Buffer.from(content),
  });
  expect(again.status()).toBe(409);
  expect((await again.json() as { code: string }).code).toBe("STATEMENT_ALREADY_IMPORTED");
});
