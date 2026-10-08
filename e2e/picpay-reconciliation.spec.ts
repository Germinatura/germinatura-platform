import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const shift = (day: string, days: number) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const br = (day: string) => day.split("-").reverse().join("/");
const brl = (cents: number) => `R$ ${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
const dot = (cents: number) => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

// Synthetic exports with the structure of PicPay Empresas; amounts and transaction ids are unique to the run.
const salesHeader = "Data e hora da venda;Previsão de pagamento;Bandeira;Número do cartão;Forma de pagamento;Solução de captura;Valor da venda;"
  + "Valor recebido comissão;Valor cancelado;Tarifa;Custo fixo;Taxa de parcelamento;Valor Líquido;Quantidade de parcelas;Status;NSU;"
  + "Número do terminal;TID;Código de autorização;Número do pedido;Número único da transação;Pagador Picpay;Nome do comprador;Documento;"
  + "Email;Telefone;Transação recorrente;Split;CNPJ parceiro;Valor bruto pago parceiro;Transação 3DS;ARN;";
const receivablesHeader = "Status;Tipo de Operação;Tipo de Lançamento;Pagador Picpay;Estabelecimento;Data de pagamento;Bandeira;Número da parcela;"
  + "Quantidade de parcelas;Número do cartão;Número único da transação;Código de autorização;NSU;Valor bruto;Valor descontado;Valor líquido;"
  + "Solução de captura;Número do terminal;TID;Número do pedido;Nome do comprador;Documento;Email;Telefone;Transação recorrente;"
  + "Transação 3DS;Split;Valor bruto pago parceiro;";
function sale(soldAt: string, forecast: string, method: "Pix" | "Crédito", gross: number, fee: number, status: "Aprovada" | "Devolvida", ref: string) {
  const cancelled = status === "Devolvida" ? gross : 0;
  return [soldAt, br(forecast), method === "Pix" ? "Pix" : "Elo", method === "Pix" ? "" : "509431******0001", method,
    method === "Pix" ? "QR Code PicPay" : "PicPay Mini", brl(gross), "", brl(cancelled), ` ${brl(fee)}`, " R$ 0,00", "",
    brl(gross - fee - cancelled), "1", status, method === "Pix" ? "" : "100001", method === "Pix" ? "" : "1000001", "", "", "", ref,
    "-", "Comprador Sintético", "000.000.000-00", "sintetico@example.com", "(00) 0000-0000", "-", "-", "-", "-", "-", "-"].join(";") + ";";
}

test("financeiro concilia Minhas vendas, Recebíveis e Extrato enviados juntos, sem duplicar o que já conhece", async ({ page }) => {
  test.slow();
  const tag = Date.now().toString(36);
  const base = 100_000 + (Date.now() % 800_000);
  const day = shift(today(), -20);
  const payDay = shift(today(), 10);
  const pixRef = `E${String(base).padStart(31, "0")}`;
  const refundedRef = `E${String(base + 1).padStart(31, "0")}`;
  const cardRef = `9${String(base).padStart(18, "0")}`;
  const sales = [salesHeader,
    sale(`${br(day)} 10:00:00`, day, "Pix", base, 0, "Aprovada", pixRef),
    sale(`${br(day)} 10:30:00`, day, "Pix", base + 1, 0, "Aprovada", refundedRef),
    sale(`${br(day)} 11:00:00`, payDay, "Crédito", base + 2, 300, "Aprovada", cardRef)].join("\n") + "\n";
  const receivables = [receivablesHeader, ["Pendente", "Crédito", "Crédito à vista", "-", "0000000", br(payDay), "Elo", "1", "1", "509431******0001",
    cardRef, "000000", "100001", brl(base + 2), brl(-300), brl(base + 2 - 300), "PicPay Mini", "1000001",
    "-", "-", "-", "-", "-", "-", "-", "-", "-"].join(";") + ";"].join("\n") + "\n";
  const statement = ["data;movimento;descrição;tipo;valor",
    `${day};Pix recebido;Cliente ${tag};Entrada;${dot(base)};`, `${day};Pix recebido;Cliente ${tag} B;Entrada;${dot(base + 1)};`].join("\r\n") + "\r\n";

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  const zero = "00000000-0000-4000-8000-000000000000";
  for (const request of [
    page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/summary?from=${day}&to=${day}`),
    page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/exceptions?from=${day}&to=${day}`),
    page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/settlements?from=${day}&to=${payDay}`),
    page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/transactions?from=${day}&to=${day}`),
    page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/periods`),
    page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/files/preview`, { headers: { Origin: portalUrl } }),
    page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/exceptions/resolve`, { headers: { Origin: portalUrl } }),
    page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/transactions/${zero}/link`, { headers: { Origin: portalUrl } }),
  ]) expect((await request).status()).toBeLessThan(500);
  // Validation: an inverted period and an unknown transaction never reach the database as commands.
  expect((await page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/summary?from=${day}&to=${shift(day, -1)}`)).status()).toBe(422);
  expect((await page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/transactions/${zero}/link`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-picpay-missing-${tag}` }, data: { paymentAttemptId: null, reason: "Transação inexistente" },
  })).status()).toBe(404);

  await page.goto(`${portalUrl}/admin/financeiro/conciliacao-picpay`);
  await expect(page.getByRole("region", { name: "Resumo da conciliação" })).toBeVisible({ timeout: 90_000 });
  await page.getByLabel("De", { exact: true }).fill(day);
  await page.getByLabel("Até", { exact: true }).fill(day);

  // Three exports and one unrelated file at once, in any order: the type comes from the header.
  const files = page.getByRole("region", { name: "Importar arquivos" });
  await page.getByLabel("Arquivos CSV").setInputFiles([
    { name: `extrato-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(statement) },
    { name: `recebiveis-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(receivables) },
    { name: `vendas-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(sales) },
    { name: `planilha-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from("nome;valor\nA;1\n") },
  ]);
  const row = (name: string) => files.getByRole("row").filter({ hasText: name });
  await expect(row(`vendas-${tag}.csv`).getByText("Minhas vendas", { exact: true })).toBeVisible();
  await expect(row(`recebiveis-${tag}.csv`).getByText("Recebíveis", { exact: true })).toBeVisible();
  await expect(row(`extrato-${tag}.csv`).getByText("Extrato", { exact: true })).toBeVisible();
  await expect(row(`planilha-${tag}.csv`).getByText(/Arquivo não reconhecido/)).toBeVisible();
  await files.getByRole("button", { name: "Importar arquivos" }).click();
  for (const name of [`extrato-${tag}.csv`, `recebiveis-${tag}.csv`, `vendas-${tag}.csv`]) {
    await expect(row(name).getByText(/Importado como arquivo nº \d+/)).toBeVisible();
  }

  // Pix of Minhas vendas are found in the statement by day and amount; the card sale waits for its settlement.
  const transactions = await (await page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/transactions?from=${day}&to=${day}`)).json() as {
    data: Array<{ transactionRef: string; status: string; feeCents: number; netCents: number; terminal: string | null }>;
  };
  const card = transactions.data.find((item) => item.transactionRef === cardRef);
  expect(card).toMatchObject({ status: "APROVADA", feeCents: 300, netCents: base + 2 - 300, terminal: "1000001" });
  const settlements = await (await page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/settlements?from=${payDay}&to=${payDay}`)).json() as {
    data: { days: Array<{ paymentOn: string; status: string; expectedNetCents: number }> };
  };
  expect(settlements.data.days.find((item) => item.paymentOn === payDay)?.status).toBe("A_RECEBER");

  // A later weekly export: one sale changed to Devolvida, nothing else is new; the same file again is refused.
  const weekly = sales.replace(`${brl(base + 1)};;${brl(0)};`, `${brl(base + 1)};;${brl(base + 1)};`)
    .replace(`${brl(base + 1)};1;Aprovada;`, `${brl(0)};1;Devolvida;`);
  const preview = await (await page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/files/preview`, {
    headers: { Origin: portalUrl, "Content-Type": "text/csv" }, data: Buffer.from(weekly),
  })).json() as { data: { sourceType: string; newCount: number; knownCount: number; updatedCount: number; errorCount: number } };
  expect(preview.data).toMatchObject({ sourceType: "PICPAY_SALES", newCount: 0, knownCount: 2, updatedCount: 1, errorCount: 0 });
  await page.getByLabel("Arquivos CSV").setInputFiles([
    { name: `vendas-semana-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(weekly) },
    { name: `vendas-de-novo-${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(sales) },
  ]);
  await expect(row(`vendas-de-novo-${tag}.csv`).getByText(/Arquivo já importado \(nº \d+\)\./)).toBeVisible();
  await files.getByRole("button", { name: "Importar arquivos" }).click();
  await expect(row(`vendas-semana-${tag}.csv`).getByText(/0 novas, 2 já conhecidas, 1 atualizadas/)).toBeVisible();
  const again = await page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/files?fileName=de-novo.csv`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-picpay-again-${tag}`, "Content-Type": "text/csv" }, data: Buffer.from(sales),
  });
  expect(again.status()).toBe(409);
  const refunded = await (await page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/transactions?from=${day}&to=${day}&status=DEVOLVIDA`)).json() as {
    data: Array<{ transactionRef: string; observations: number }>;
  };
  expect(refunded.data.find((item) => item.transactionRef === refundedRef)?.observations).toBe(2);

  // Pending items show with their reason; resolving one needs a reason and is audited.
  const exceptions = page.getByRole("region", { name: "Pendências" });
  await expect(page.getByRole("region", { name: "Resumo da conciliação" })).toContainText(br(day));
  await exceptions.getByLabel("Tipo").selectOption("PICPAY_SEM_PDV");
  const pending = exceptions.getByRole("listitem").filter({ hasText: new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(base / 100) }).first();
  await expect(pending).toBeVisible({ timeout: 30_000 });
  // The minimum is written next to the field and counted while too short; the button never explains alone.
  await pending.getByLabel("Motivo").fill("Troco");
  await expect(pending.getByText("Mínimo de 8 caracteres.")).toBeVisible();
  await expect(pending.getByText("5/8 caracteres")).toBeVisible();
  await expect(pending.getByRole("button", { name: "Resolver" })).toBeDisabled();
  await pending.getByLabel("Motivo").fill(`Venda avulsa sem PDV ${tag}`);
  await pending.getByRole("button", { name: "Resolver" }).click();
  await expect(page.getByText("Pendência resolvida.")).toBeVisible();

  // An unclassified statement line is reviewed in the line itself, never silenced: no "Resolver", and the API refuses.
  const lineItems = await (await page.request.get(`${portalUrl}/api/v1/admin/finance/picpay/exceptions?from=${day}&to=${day}&type=EXTRATO_NAO_CLASSIFICADO`)).json() as {
    data: Array<{ key: string; amountCents: number; subjectId: string }>;
  };
  const unclassified = lineItems.data.find((item) => item.amountCents === base);
  expect(unclassified).toBeTruthy();
  const silenced = await page.request.post(`${portalUrl}/api/v1/admin/finance/picpay/exceptions/resolve`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-silence-${tag}` }, data: { key: unclassified?.key, action: "RESOLVIDA", reason: "Silenciar a linha do extrato" },
  });
  expect(silenced.status()).toBe(409);
  expect((await silenced.json() as { code: string }).code).toBe("PICPAY_EXCEPTION_REQUIRES_LINE_REVIEW");
  await exceptions.getByLabel("Tipo").selectOption("EXTRATO_NAO_CLASSIFICADO");
  const lineItem = exceptions.getByRole("listitem").filter({ hasText: new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(base / 100) }).first();
  await expect(lineItem.getByRole("button", { name: "Revisar linha" })).toBeVisible();
  await expect(lineItem.getByRole("button", { name: "Resolver" })).toHaveCount(0);
  await lineItem.getByRole("button", { name: "Revisar linha" }).click();
  await expect(page.locator(`#statement-line-${unclassified?.subjectId}`)).toBeFocused({ timeout: 30_000 });

  // Treasury before classification: the line is already in the balance; classifying it does not move the balance.
  const free = async () => (await (await page.request.get(`${portalUrl}/api/v1/admin/finance/balances`)).json() as { data: { freeBalanceCents: number } }).data.freeBalanceCents;
  const before = await free();
  const statementLine = page.locator(`#statement-line-${unclassified?.subjectId}`);
  await statementLine.getByLabel("Classificar", { exact: true }).selectOption("MENSALIDADES");
  await statementLine.getByRole("button", { name: "Classificar" }).click();
  await expect(page.getByText(/Linha \d+ revisada\./)).toBeVisible();
  expect(await free()).toBe(before);

  // Items outside the selected period are never hidden.
  await page.getByLabel("De", { exact: true }).fill(today());
  await page.getByLabel("Até", { exact: true }).fill(today());
  const outside = page.getByRole("status").filter({ hasText: "fora do período selecionado" });
  await expect(outside).toBeVisible({ timeout: 30_000 });
  await outside.getByRole("button", { name: "Ver todas" }).click();
  await expect(page.getByLabel("De", { exact: true })).not.toHaveValue(today());
  await page.getByLabel("De", { exact: true }).fill(day);
  await page.getByLabel("Até", { exact: true }).fill(day);

  // The period is evaluated, never locked: later files bring it back for review when they add evidence.
  const close = page.getByRole("region", { name: "Fechamento da conciliação" });
  await close.getByRole("button", { name: `Avaliar ${br(day)} a ${br(day)}` }).click();
  await expect(page.getByText(/Período (conciliado|avaliado com pendências)\./)).toBeVisible();
  await expect(close.getByRole("list", { name: "Períodos avaliados" })).toContainText(`${br(day)} a ${br(day)}`);
});
