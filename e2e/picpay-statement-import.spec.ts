import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
// Anonymized fixture with the structure of the real PicPay Empresas export; never the original file.
const fixture = readFileSync(join(__dirname, "fixtures", "picpay-statement-anonymized.csv"), "utf8");

test("financeiro importa o extrato PicPay na conciliação, recusa o mesmo arquivo e classifica uma linha pendente", async ({ page }) => {
  test.slow();
  const tag = Date.now().toString(36);
  // A run-specific description keeps the file new on a shared database; everything else is the fixture.
  const content = fixture.replace("Papelaria Exemplo", `Papelaria ${tag}`);
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  // The dev server compiles each route on its first request: warm the reconciliation routes before the journey.
  const zero = "00000000-0000-4000-8000-000000000000";
  for (const request of [
    page.request.get(`${portalUrl}/api/v1/admin/finance/statement-imports`),
    page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/files/preview`, { headers: { Origin: portalUrl } }),
    page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/files`),
    page.request.get(`${portalUrl}/api/v1/admin/finance/statement-imports/${zero}/lines`),
    page.request.post(`${portalUrl}/api/v1/admin/finance/statement-lines/${zero}/resolve`, { headers: { Origin: portalUrl } }),
  ]) expect((await request).status()).toBeLessThan(500);
  // The old address of the screen leads to the reconciliation.
  await page.goto(`${portalUrl}/admin/financeiro/importar-extrato`);
  await expect(page).toHaveURL(/\/admin\/financeiro\/conciliacao-picpay$/);
  await expect(page.getByRole("main").getByRole("heading", { name: "Conciliação PicPay", level: 1 })).toBeVisible();
  // The import list is loaded by the client: once it shows, the file input has its handler.
  await expect(page.getByText(/aguardando revisão em todas as importações|Nenhum extrato importado/).first()).toBeVisible({ timeout: 90_000 });

  // A partially invalid file shows each problem and cannot be imported.
  const files = page.getByRole("region", { name: "Importar arquivos" });
  const broken = content.replace("2026-09-01;Pix recebido;Cliente Exemplo Dois", "2026-02-30;Pix recebido;Cliente Exemplo Dois");
  await page.getByLabel("Arquivos CSV").setInputFiles({ name: `invalido-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(broken) });
  await expect(files.getByText("Linha 4: Data inválida")).toBeVisible();
  await expect(files.getByRole("button", { name: "Importar arquivos" })).toBeDisabled();

  await page.getByLabel("Arquivos CSV").setInputFiles({ name: `extrato-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(content) });
  const row = files.getByRole("row").filter({ hasText: `extrato-${tag}.csv` });
  await expect(row.getByText("Extrato", { exact: true })).toBeVisible();
  await expect(row.getByText("Pronto para importar")).toBeVisible();
  await files.getByRole("button", { name: "Importar arquivos" }).click();
  await expect(row.getByText(/Importado como arquivo nº \d+: \d+ novas/)).toBeVisible();
  const number = Number((await row.getByText(/Importado como arquivo nº/).textContent())?.match(/nº (\d+)/)?.[1]);

  const imports = page.getByRole("list", { name: "Importações" });
  await imports.getByRole("listitem").filter({ hasText: `Importação nº ${number} ` }).getByRole("button", { name: "Ver linhas" }).click();
  const line = page.getByRole("listitem", { name: "Linha 7" });
  await expect(line).toContainText(`Papelaria ${tag}`);
  await expect(line.getByText("A revisar")).toBeVisible();
  await line.getByLabel("Classificar", { exact: true }).selectOption("MATERIAIS");
  await line.getByRole("button", { name: "Classificar" }).click();
  await expect(page.getByText("Linha 7 revisada.")).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Linha 7" })).toHaveCount(0);

  // The same file is refused, through the screen and through the API; the old import endpoint is gone.
  await page.getByLabel("Arquivos CSV").setInputFiles({ name: `de-novo-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(content) });
  await expect(files.getByText(`Arquivo já importado (nº ${number}).`)).toBeVisible();
  const again = await page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/files?fileName=de-novo.csv`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-statement-again-${tag}`, "Content-Type": "text/csv" }, data: Buffer.from(content),
  });
  expect(again.status()).toBe(409);
  expect((await again.json() as { code: string }).code).toBe("PICPAY_FILE_ALREADY_IMPORTED");
  const legacy = await page.request.post(`${portalUrl}/api/v1/admin/finance/statement-imports?fileName=legado.csv&acceptOverlap=true`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-statement-legacy-${tag}`, "Content-Type": "text/csv" }, data: Buffer.from(content),
  });
  expect(legacy.status()).toBeGreaterThanOrEqual(400);
  expect(legacy.status()).toBeLessThan(500);
});
