import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const shift = (day: string, days: number) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const reais = (cents: number) => `${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const brl = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
const typed = (cents: number) => (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Spec 5.8 (FIN-002, FIN-003, FIN-007). The opening position lives far in the past (400 days ago) so every other suite's
// statement lines stay native operation; only this suite's lines, dated on the opening day, are cutover history.
test("financeiro registra a abertura, revisa o histórico do extrato em lote e por vínculo e concilia o saldo", async ({ page }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const base = 100_000 + (Date.now() % 800_000);
  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  const zero = "00000000-0000-4000-8000-000000000000";
  for (const request of [
    page.request.get(`${portalUrl}/api/v1/admin/finance/balances`),
    page.request.get(`${portalUrl}/api/v1/admin/finance/opening-position`),
    page.request.get(`${portalUrl}/api/v1/admin/finance/balance-checks`),
    page.request.post(`${portalUrl}/api/v1/admin/finance/statement-imports/${zero}/bulk/preview`, { headers: { Origin: portalUrl } }),
    page.request.post(`${portalUrl}/api/v1/admin/finance/statement-imports/${zero}/bulk`, { headers: { Origin: portalUrl } }),
    page.request.get(`${portalUrl}/api/v1/admin/finance/statement-lines/${zero}/link-candidates`),
    page.request.post(`${portalUrl}/api/v1/admin/finance/statement-lines/${zero}/link`, { headers: { Origin: portalUrl } }),
  ]) expect((await request).status()).toBeLessThan(500);

  // Opening position, through the screen on a fresh database; a database that already has one keeps it.
  const existing = await (await page.request.get(`${portalUrl}/api/v1/admin/finance/opening-position`)).json() as {
    data: { current: { asOf: string; operatingSince: string } | null };
  };
  await page.goto(`${portalUrl}/admin/financeiro/saldo`);
  const opening = page.getByRole("region", { name: "Posição de abertura" });
  await expect(opening.getByRole("button", { name: /Registrar abertura|Corrigir abertura/ })).toBeVisible({ timeout: 90_000 });
  if (!existing.data.current) {
    await opening.getByRole("button", { name: "Registrar abertura" }).click();
    await opening.getByLabel("Dia da abertura").fill(shift(today(), -400));
    await opening.getByLabel("Operação no Germinatura desde").fill(shift(today(), -399));
    // A large free opening keeps this database's free balance positive whatever the other suites paid.
    await opening.getByLabel("Saldo livre (R$)").fill("50.000,00");
    await opening.getByLabel("Cofrinho (R$)").fill("111,78");
    await opening.getByRole("button", { name: "Registrar abertura" }).click();
    await expect(page.getByText("Posição de abertura registrada (versão 1).")).toBeVisible();
  }
  await expect(opening.getByText(brl(11_178)).first()).toBeVisible();
  const position = (await (await page.request.get(`${portalUrl}/api/v1/admin/finance/opening-position`)).json() as {
    data: { current: { asOf: string; operatingSince: string } };
  }).data.current;
  const historyDay = position.asOf;
  expect(historyDay < position.operatingSince).toBe(true);
  // A second opening is never recorded by accident.
  const duplicate = await page.request.post(`${portalUrl}/api/v1/admin/finance/opening-position`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-opening-again-${tag}` },
    data: { asOf: historyDay, operatingSince: position.operatingSince, freeCents: 0, vaultCents: 0, receivablesCents: 0, cashCents: 0,
      description: "Outra abertura", reason: null, supersedesId: null },
  });
  expect((await duplicate.json() as { code: string }).code).toBe("OPENING_POSITION_ALREADY_RECORDED");

  // A historical statement: two Pix received, one receivables settlement, two Pix sent (unique amounts per run).
  const line = (movement: string, description: string, cents: number) =>
    `${historyDay};${movement};${description};${cents > 0 ? "Entrada" : "Saída"};${cents < 0 ? "-" : ""}${reais(cents)};`;
  const csv = ["data;movimento;descrição;tipo;valor",
    line("Pix recebido", `Cliente ${tag} A`, base), line("Pix recebido", `Cliente ${tag} B`, base + 1),
    line("Recebíveis de venda", "Vendas maquininha", base + 2), line("Pix enviado", `Gráfica ${tag}`, -(base + 3)),
    line("Pix enviado", `Frete ${tag}`, -(base + 4))].join("\r\n");
  const imported = await page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/files?fileName=historico-${tag}.csv`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-cutover-import-${tag}`, "Content-Type": "text/csv" }, data: Buffer.from(csv),
  });
  expect(imported.status()).toBe(201);
  const importedFile = (await imported.json() as { data: { id: string; sourceType: string; newCount: number } }).data;
  expect(importedFile).toMatchObject({ sourceType: "PICPAY_STATEMENT", newCount: 5 });
  // Without Minhas vendas for that day nothing explains the lines: all five wait for review as cutover history.
  const statementImports = await (await page.request.get(`${portalUrl}/api/v1/admin/finance/statement-imports`)).json() as {
    data: Array<{ id: string; number: number; statusCounts: { PENDENTE_REVISAO: number; TRANSFERENCIA: number }; cutoverLines: number }>;
  };
  const statementImport = statementImports.data.find((item) => item.id === importedFile.id);
  expect(statementImport?.statusCounts).toMatchObject({ PENDENTE_REVISAO: 5, TRANSFERENCIA: 0 });
  expect(statementImport?.cutoverLines).toBe(5);
  // The Pix sent for the print shop was already paid through a manual entry.
  expect((await page.request.post(`${portalUrl}/api/v1/admin/finance/entries`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-cutover-entry-${tag}` },
    data: { kind: "EXPENSE", category: "MATERIAIS", account: "PICPAY_EMPRESAS", counterAccount: null, amountCents: base + 3,
      occurredOn: historyDay, description: `Impressão ${tag}`, reference: null },
  })).status()).toBe(201);

  await page.goto(`${portalUrl}/admin/financeiro/conciliacao-picpay`);
  const imports = page.getByRole("list", { name: "Importações" });
  await expect(imports).toBeVisible({ timeout: 90_000 });
  await imports.getByRole("listitem").filter({ hasText: `Importação nº ${statementImport?.number} ` }).getByRole("button", { name: "Ver linhas" }).click();

  // Bulk: the two historical Pix received become historical revenue after a preview and a strong confirmation.
  const bulk = page.getByRole("region", { name: "Classificação em lote" });
  await bulk.getByLabel("Movimento").selectOption("PIX_RECEBIDO");
  await bulk.getByLabel("Categoria").selectOption("RECEITA_HISTORICA");
  await bulk.getByRole("button", { name: "Ver prévia" }).click();
  const bulkPreview = bulk.getByLabel("Prévia do lote");
  await expect(bulkPreview.getByText("Quantidade")).toBeVisible();
  await expect(bulkPreview).toContainText(brl(2 * base + 1));
  await expect(bulk.getByRole("button", { name: "Classificar selecionadas" })).toBeDisabled();
  await bulk.getByLabel("Motivo do lote").fill(`Cutover: Pix históricos ${tag}`);
  await bulk.getByRole("checkbox").check();
  await bulk.getByRole("button", { name: "Classificar selecionadas" }).click();
  await expect(page.getByText("2 linha(s) classificadas como Receita histórica.")).toBeVisible();

  // Historical receivables are historical revenue, line by line.
  const receivables = page.getByRole("listitem", { name: "Linha 4" });
  await receivables.getByLabel("Categoria").selectOption("RECEITA_HISTORICA");
  await receivables.getByRole("button", { name: "Classificar" }).click();
  await expect(page.getByText("Linha 4 revisada.")).toBeVisible();

  // The print shop Pix is linked to the manual entry: no second expense.
  const printShop = page.getByRole("listitem", { name: "Linha 5" });
  await printShop.getByRole("button", { name: "Vincular a registro existente" }).click();
  await printShop.getByRole("list", { name: "Registros para a linha 5" }).getByRole("listitem").filter({ hasText: `Impressão ${tag}` })
    .getByRole("button", { name: "Vincular" }).click();
  await expect(page.getByText("Linha 5 vinculada ao registro existente.")).toBeVisible();

  // The freight Pix was recorded elsewhere: already recorded, with a reason.
  const freight = page.getByRole("listitem", { name: "Linha 6" });
  await freight.getByLabel("Já registrada em outro lugar (motivo)").fill("Frete pago pela tesouraria da comissão");
  await freight.getByRole("button", { name: "Marcar como já registrada" }).click();
  await expect(page.getByText("Linha 6 revisada.")).toBeVisible();
  await expect(page.getByText("Nenhuma linha aguardando revisão.")).toBeVisible();

  // The statement names each nature on the history day.
  await page.goto(`${portalUrl}/admin/financeiro/extrato`);
  // The period inputs are controlled by the client: wait for the first statement before changing them.
  await expect(page.getByLabel("Resumo do extrato")).toBeVisible({ timeout: 90_000 });
  await page.getByLabel("De", { exact: true }).fill(historyDay);
  await page.getByLabel("Até", { exact: true }).fill(historyDay);
  const rows = page.getByRole("table", { name: "Movimentos do extrato" });
  await expect(rows.getByText("Saldo de abertura").first()).toBeVisible({ timeout: 30_000 });
  await expect(rows.getByRole("row").filter({ hasText: `Impressão ${tag}` }).getByText("Despesa", { exact: true })).toBeVisible();
  await expect(rows.getByRole("row").filter({ hasText: "histórico do cutover" }).first().getByText("Receita", { exact: true })).toBeVisible();

  // Balance check: the observed position equal to the computed one is reconciled; one cent off is a difference, never an adjustment.
  const balances = (await (await page.request.get(`${portalUrl}/api/v1/admin/finance/balances`)).json() as {
    data: { freeBalanceCents: number; vaultBalanceCents: number; availableBalanceCents: number };
  }).data;
  expect(balances.availableBalanceCents).toBe(balances.freeBalanceCents + balances.vaultBalanceCents);
  await page.goto(`${portalUrl}/admin/financeiro/saldo`);
  const summary = page.getByRole("region", { name: "Saldo financeiro" });
  await expect(summary.getByText("Saldo livre", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(summary.getByText("Cofrinho", { exact: true })).toBeVisible();
  await expect(summary.getByText(brl(balances.availableBalanceCents))).toBeVisible();
  await expect(page.getByRole("region", { name: "A receber" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Dinheiro físico" })).toBeVisible();
  const check = page.getByRole("region", { name: "Conferência de saldo" });
  await check.getByLabel("Saldo livre real (R$)").fill(typed(balances.freeBalanceCents));
  await check.getByLabel("Cofrinho real (R$)").fill(typed(balances.vaultBalanceCents));
  await check.getByRole("button", { name: "Conferir saldo" }).click();
  await expect(check.getByText("Status: CONCILIADO")).toBeVisible();
  await check.getByLabel("Saldo livre real (R$)").fill(typed(balances.freeBalanceCents + 1));
  await check.getByRole("button", { name: "Conferir saldo" }).click();
  await expect(check.getByText("Status: DIVERGENTE")).toBeVisible();
  await expect(check.getByLabel("Resultado da conferência")).toContainText(brl(-1));

  // Indicators call the period flow by its name; the balances block stays apart from the result.
  await page.goto(`${portalUrl}/admin/financeiro/indicadores`);
  await expect(page.getByText("Fluxo de caixa do período")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("region", { name: "Saldo financeiro" })).toBeVisible();
});
