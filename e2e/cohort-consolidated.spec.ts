import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";

// ADR 0011 (PR 4): the consolidated view of ADMIN_MASTER and the user ↔ cohort memberships. Turma 2026 (A) and a cohort
// created here (B); a person who ends up ADMIN in A and VENDEDOR in B; an ADMIN of A who never reaches B.
const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const cohortA = "c0000000-0000-4000-8000-000000002026";
const COHORT = "x-germinatura-cohort";
const suffix = Date.now().toString(36).slice(-7);
const password = "Turmas123!";
const joao = { username: `e2e.joao.${suffix}`, email: `e2e.joao.${suffix}@institutojef.org.br`, displayName: `João E2E ${suffix}` };
const adminA = { username: `e2e.adma4.${suffix}`, email: `e2e.adma4.${suffix}@institutojef.org.br`, displayName: `Admin A E2E ${suffix}` };
let joaoId = "";
let adminAId = "";
let cohortB = "";
let cohortBName = "";
let pendingSaleId = "";
let stockMovementId = "";
const productId = "33f00000-0000-4000-8000-000000000001";
const locationId = "50000000-0000-4000-8000-000000000001";

// ADMIN_MASTER through the Data API inside Turma 2026: stock for one sale of this spec, and its reversal at the end.
async function masterRpc(name: string, body: Record<string, unknown>) {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "master.teste@institutojef.org.br", password: "Master123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", [COHORT]: cohortA }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function signIn(browser: Browser, identifier: string, secret: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: portalUrl });
  const login = await context.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier, password: secret } });
  expect(login.status(), identifier).toBe(200);
  return context;
}
const inCohort = (cohort: string, extra: Record<string, string> = {}) => ({ Origin: portalUrl, [COHORT]: cohort, ...extra });

test.describe.serial("visão consolidada e vínculos (ADR 0011, PR 4)", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const master = await signIn(browser, "master.teste", "Master123!");
    for (let attempt = 0; attempt < 5 && !cohortB; attempt += 1) {
      cohortBName = `Turma Consolidada ${suffix}${attempt || ""}`;
      const created = await master.request.post("/api/v1/admin/cohorts", { headers: inCohort("all", { "Idempotency-Key": `e2e-pr4-${suffix}-${attempt}` }),
        data: { name: cohortBName, year: 2040 + Math.floor(Math.random() * 60), slug: `pr4-${suffix}-${attempt}`, status: "ACTIVE" } });
      if (created.status() === 409) continue;
      expect(created.status()).toBe(201);
      cohortB = (await created.json() as { data: { id: string } }).data.id;
    }
    for (const [person, roles] of [[joao, ["CONSUMIDOR"]], [adminA, ["CONSUMIDOR"]]] as const) {
      const created = await master.request.post("/api/v1/admin/users", { headers: inCohort(cohortA), data: { ...person, password, roles, active: true } });
      expect(created.status()).toBe(201);
      const id = (await created.json() as { data: { user_id: string } }).data.user_id;
      if (person === joao) joaoId = id; else adminAId = id;
    }
    expect((await master.request.patch(`/api/v1/admin/users/${adminAId}/roles`, { headers: inCohort(cohortA), data: { roles: ["ADMIN", "CONSUMIDOR"], active: true } })).status()).toBe(200);
    // One pending sale in Turma 2026, so the consolidated list has a row to label (cancelled at the end).
    const stock = await masterRpc("adjust_stock", { p_location_id: locationId, p_product_id: productId, p_quantity_delta: 1,
      p_reason: "Venda do teste consolidado", p_idempotency_key: `e2e-pr4-stock-${suffix}`, p_correlation_id: crypto.randomUUID() });
    stockMovementId = String(stock.movement_id);
    const checkout = await master.request.post("/api/v1/sales/checkout", { headers: inCohort(cohortA, { "Idempotency-Key": `e2e-pr4-sale-${suffix}` }),
      data: { channel: "PDV", locationId, items: [{ productId, quantity: 1 }] } });
    expect(checkout.status()).toBe(201);
    pendingSaleId = (await checkout.json() as { data: { saleId: string } }).data.saleId;
    await master.close();
  });

  test.afterAll(async ({ browser }) => {
    const master = await signIn(browser, "master.teste", "Master123!");
    if (pendingSaleId) await master.request.post(`/api/v1/sales/${pendingSaleId}/cancel`, { headers: inCohort(cohortA, { "Idempotency-Key": `e2e-pr4-cancel-${suffix}` }) });
    if (stockMovementId) await masterRpc("reverse_stock_movement", { p_movement_id: stockMovementId, p_reason: "Limpar estoque do teste consolidado",
      p_idempotency_key: `e2e-pr4-unstock-${suffix}`, p_correlation_id: crypto.randomUUID() }).catch(() => undefined);
    if (adminAId) await master.request.patch(`/api/v1/admin/users/${adminAId}/roles`, { headers: inCohort(cohortA), data: { roles: ["CONSUMIDOR"], active: false } });
    if (joaoId) await master.request.patch(`/api/v1/admin/users/${joaoId}/roles`, { headers: inCohort(cohortA), data: { roles: ["CONSUMIDOR"], active: false } });
    if (joaoId && cohortB) await master.request.patch(`/api/v1/admin/users/${joaoId}/roles`, { headers: inCohort(cohortB), data: { roles: ["CONSUMIDOR"], active: false } });
    if (cohortB) await master.request.patch(`/api/v1/admin/cohorts/${cohortB}`, { headers: inCohort("all"), data: { name: cohortBName, status: "ARCHIVED", reason: "Fim do teste consolidado" } });
    await master.close();
  });

  test("ADMIN_MASTER gerencia os vínculos de João: ADMIN em 2026 e VENDEDOR na outra turma, com histórico", async ({ browser }) => {
    test.slow();
    const master = await signIn(browser, "master.teste", "Master123!");
    expect((await master.request.post("/api/v1/session/cohort", { headers: { Origin: portalUrl }, data: { cohort: "all" } })).status()).toBe(200);
    const page = await master.newPage();
    await page.goto("/admin/usuarios");
    const main = page.getByRole("main");
    await main.getByPlaceholder("Nome, usuário ou e-mail").fill(joao.username);
    await expect(main.getByText(/^1 de \d+ usuários$/)).toBeVisible();
    await main.getByRole("button", { name: `Turmas de ${joao.displayName}` }).click();
    const dialog = page.getByRole("dialog", { name: "Turmas e papéis" });
    await dialog.getByLabel("Motivo das alterações").fill("Organização das turmas");

    // Turma 2026 → ADMIN (roles of that cohort only).
    const rowA = dialog.getByRole("listitem", { name: "Turma 2026" });
    await rowA.getByLabel("Administrador").check();
    await rowA.getByRole("button", { name: "Salvar papéis" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Papéis em Turma 2026 atualizados.");
    // The other cohort → VENDEDOR, by adding the membership with that role.
    const rowB = dialog.getByRole("listitem", { name: cohortBName });
    await expect(rowB.getByText("Sem vínculo")).toBeVisible();
    await rowB.getByLabel("Vendedor").check();
    await rowB.getByRole("button", { name: "Adicionar à turma" }).click();
    await expect(dialog.getByRole("status")).toHaveText(`Adicionada a ${cohortBName}.`);
    await expect(rowB.getByText("Papéis nesta turma: Consumidor, Vendedor")).toBeVisible();
    await expect(rowA.getByText("Papéis nesta turma: Administrador, Consumidor")).toBeVisible();

    // Inactivate and reactivate: the membership row and its roles stay (history), the audit lists each change.
    await rowB.getByRole("button", { name: "Inativar vínculo" }).click();
    await expect(rowB.getByText("Vínculo inativo")).toBeVisible();
    await rowB.getByRole("button", { name: "Reativar vínculo" }).click();
    await expect(rowB.getByText("Vínculo ativo")).toBeVisible();
    await expect(rowB.getByText("Papéis nesta turma: Consumidor, Vendedor")).toBeVisible();
    const history = dialog.getByRole("region", { name: "Histórico de vínculos" });
    await expect(history.getByText("Vínculo alterado").first()).toBeVisible();
    await expect(history.getByText(cohortBName).first()).toBeVisible();

    // The consolidated list shows each cohort with its roles, never merged.
    await dialog.getByRole("button", { name: "Fechar" }).first().click();
    await expect(main.getByText(/Turma 2026:/).first()).toBeVisible();
    await expect(main.getByText(new RegExp(`${cohortBName}:`)).first()).toBeVisible();

    // The database agrees: roles per cohort.
    const memberships = await master.request.get(`/api/v1/admin/users/${joaoId}/cohorts`);
    const rows = (await memberships.json() as { data: { cohortId: string; membership: string; roles: string[] }[] }).data;
    expect(rows.find((row) => row.cohortId === cohortA)).toMatchObject({ membership: "ACTIVE", roles: ["ADMIN", "CONSUMIDOR"] });
    expect(rows.find((row) => row.cohortId === cohortB)).toMatchObject({ membership: "ACTIVE", roles: ["CONSUMIDOR", "VENDEDOR"] });
    await master.close();
  });

  test("um ADMIN comum não lista turmas, não vê vínculos e não gerencia vínculo de outra turma", async ({ browser }) => {
    const admin = await signIn(browser, adminA.username, password);
    expect((await admin.request.get("/api/v1/admin/cohorts")).status()).toBe(403);
    expect((await admin.request.get(`/api/v1/admin/users/${joaoId}/cohorts`)).status()).toBe(403);
    const other = await admin.request.put(`/api/v1/admin/users/${joaoId}/membership`, { headers: inCohort(cohortB), data: { active: false, reason: "Tentativa cruzada" } });
    expect(other.status()).toBe(403);
    const inAll = await admin.request.put(`/api/v1/admin/users/${joaoId}/membership`, { headers: inCohort("all"), data: { active: false, reason: "Tentativa em todas" } });
    expect(inAll.status()).toBe(403);
    const page = await admin.newPage();
    await page.goto("/admin/usuarios");
    await expect(page.getByRole("main").getByRole("button", { name: /^Turmas de / })).toHaveCount(0);
    await admin.close();
  });

  test("Todas as turmas: visão geral comparada, indicadores lado a lado, vendas e auditoria com a turma, telas por turma pedem a turma", async ({ browser }) => {
    test.slow();
    const master = await signIn(browser, "master.teste", "Master123!");
    expect((await master.request.post("/api/v1/session/cohort", { headers: { Origin: portalUrl }, data: { cohort: "all" } })).status()).toBe(200);
    const page = await master.newPage();

    await page.goto("/");
    const comparison = page.getByRole("region", { name: "Comparação das turmas" });
    await expect(comparison.getByRole("heading", { name: "Turma 2026" })).toBeVisible();
    await expect(comparison.getByRole("heading", { name: cohortBName })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Conta PicPay Empresas: evidência global" })).toBeVisible();

    await page.goto("/admin/financeiro/indicadores");
    const table = page.getByRole("table", { name: "Indicadores por turma" });
    await expect(table.getByRole("columnheader", { name: "Turma 2026" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: cohortBName })).toBeVisible();
    await expect(table.getByRole("row", { name: /Caixa do livro da turma/ }).getByRole("cell").last()).toHaveText("—");

    await page.goto("/admin/financeiro/vendas");
    const sales = page.getByRole("list", { name: "Vendas" });
    await expect(sales.getByText("Turma 2026").first()).toBeVisible();
    await page.getByLabel("Turma").last().selectOption(cohortB);
    await expect(page.getByText("Nenhuma venda com estes filtros.")).toBeVisible();

    await page.goto("/admin/auditoria");
    await expect(page.getByRole("list", { name: "Registros de auditoria" }).getByText(/Global|Turma 2026/).first()).toBeVisible();

    // A cohort-only screen asks for the cohort explicitly and opens after choosing it.
    await page.goto("/admin/financeiro/contas-a-pagar");
    await expect(page).toHaveURL(/\/selecionar-turma\?next=%2Fadmin%2Ffinanceiro%2Fcontas-a-pagar/);
    await expect(page.getByText(/livro de uma turma/)).toBeVisible();
    await page.getByRole("list", { name: "Turmas" }).getByRole("button", { name: "Turma 2026" }).click();
    await expect(page).toHaveURL(`${portalUrl}/admin/financeiro/contas-a-pagar`);
    await expect(page.getByRole("main").getByRole("heading", { name: "Contas a pagar" })).toBeVisible();

    // Back in "all", writes of cohort data stay refused and reads not declared consolidated ask for a cohort.
    expect((await master.request.post("/api/v1/session/cohort", { headers: { Origin: portalUrl }, data: { cohort: "all" } })).status()).toBe(200);
    expect((await master.request.get("/api/v1/admin/finance/payables")).status()).toBe(409);
    expect((await master.request.get("/api/v1/admin/finance/balances")).status()).toBe(409);
    await master.close();
  });

  test("/admin/turmas mostra vínculos e papéis por turma", async ({ browser }) => {
    const master = await signIn(browser, "master.teste", "Master123!");
    const page = await master.newPage();
    await page.goto("/admin/turmas");
    const list = page.getByRole("list", { name: "Turmas" });
    const row = list.getByRole("listitem").filter({ hasText: cohortBName });
    await expect(row.getByText(/1 vínculo ativo/)).toBeVisible();
    await expect(row.getByText(/Vendas: 1/)).toBeVisible();
    const overview = await master.request.get("/api/v1/admin/cohorts");
    const cohort = (await overview.json() as { data: { id: string; membersActive: number; roles: Record<string, number> }[] }).data.find((item) => item.id === cohortB);
    expect(cohort).toMatchObject({ membersActive: 1, roles: { VENDEDOR: 1 } });
    await master.close();
  });
});
