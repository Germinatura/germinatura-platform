import { expect, test, type Browser, type BrowserContext } from "@playwright/test";

// ADR 0011 (PR 5): no implicit cohort. Visitors and share links resolve the cohort on the server; ADMIN_MASTER always
// names the cohort; the default cohort is an explicit choice; the menu says which screens need a cohort; revoking
// access names what remains for another ADMIN to take over.
const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const cohortA = "c0000000-0000-4000-8000-000000002026";
const COHORT = "x-germinatura-cohort";
const suffix = Date.now().toString(36).slice(-7);
let cohortB = "";
let slugB = "";
let cohortBName = "";

async function signIn(browser: Browser, identifier: string, secret: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: portalUrl });
  const login = await context.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier, password: secret } });
  expect(login.status(), identifier).toBe(200);
  return context;
}
const inCohort = (cohort: string, extra: Record<string, string> = {}) => ({ Origin: portalUrl, [COHORT]: cohort, ...extra });

test.describe.serial("fechamento do multi-turma (ADR 0011, PR 5)", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const master = await signIn(browser, "master.teste", "Master123!");
    for (let attempt = 0; attempt < 5 && !cohortB; attempt += 1) {
      cohortBName = `Turma Fechamento ${suffix}${attempt || ""}`;
      slugB = `fech-${suffix}-${attempt}`;
      const created = await master.request.post("/api/v1/admin/cohorts", { headers: inCohort("all", { "Idempotency-Key": `e2e-pr5-${suffix}-${attempt}` }),
        data: { name: cohortBName, year: 2040 + Math.floor(Math.random() * 60), slug: slugB, status: "ACTIVE" } });
      if (created.status() === 409) continue;
      expect(created.status()).toBe(201);
      cohortB = (await created.json() as { data: { id: string } }).data.id;
    }
    await master.close();
  });

  test.afterAll(async ({ browser }) => {
    const master = await signIn(browser, "master.teste", "Master123!");
    await master.request.put(`/api/v1/admin/cohorts/${cohortA}/default`, { headers: inCohort("all"), data: { reason: "Fim do teste de fechamento" } });
    if (cohortB) await master.request.patch(`/api/v1/admin/cohorts/${cohortB}`, { headers: inCohort("all"), data: { name: cohortBName, status: "ARCHIVED", reason: "Fim do teste de fechamento" } });
    await master.close();
  });

  test("visitante: catálogo da turma padrão, de uma turma pelo slug, nunca de turma inválida ou arquivada", async ({ request }) => {
    const byDefault = await request.get("/api/v1/catalog/products?limit=50");
    expect(byDefault.status()).toBe(200);
    expect(JSON.stringify(await byDefault.json())).toContain("Item público A");
    const ofB = await request.get(`/api/v1/catalog/products?limit=50&turma=${slugB}`);
    expect(ofB.status()).toBe(200);
    expect((await ofB.json() as { data: unknown[] }).data).toEqual([]);
    expect((await request.get("/api/v1/catalog/products?turma=2026")).status()).toBe(200);
    for (const slug of ["nao-existe", "../2026", "all", cohortA]) {
      const response = await request.get(`/api/v1/catalog/products?turma=${encodeURIComponent(slug)}`);
      expect(response.status(), slug).toBe(404);
    }
    const items = [{ productId: "33f00000-0000-4000-8000-000000000001", quantity: 1 }];
    expect((await request.post("/api/v1/pricing/quote?turma=nao-existe", { headers: { Origin: portalUrl }, data: { channel: "PORTAL", items } })).status()).toBe(404);
    expect((await request.post("/api/v1/pricing/quote?turma=2026", { headers: { Origin: portalUrl }, data: { channel: "PORTAL", items } })).status()).toBe(200);
  });

  test("links de divulgação resolvem a turma do próprio link no servidor", async ({ browser, request }) => {
    const master = await signIn(browser, "master.teste", "Master123!");
    const linkB = await master.request.post("/api/v1/admin/share-campaigns", { headers: inCohort(cohortB, { "Idempotency-Key": `e2e-pr5-link-b-${suffix}` }),
      data: { title: "Campanha da outra turma", channel: "OUTRO", productIds: [] } });
    expect(linkB.status()).toBe(201);
    const codeB = (await linkB.json() as { data: { code: string } }).data.code;
    const linkA = await master.request.post("/api/v1/admin/share-campaigns", { headers: inCohort(cohortA, { "Idempotency-Key": `e2e-pr5-link-a-${suffix}` }),
      data: { title: "Campanha da turma 2026", channel: "OUTRO", productIds: [] } });
    const codeA = (await linkA.json() as { data: { code: string } }).data.code;
    await master.close();

    const visitB = await request.get(`/d/${codeB}`, { maxRedirects: 0 });
    expect(visitB.status()).toBe(307);
    expect(visitB.headers().location).toContain(`/catalogo?turma=${slugB}`);
    const visitA = await request.get(`/d/${codeA}`, { maxRedirects: 0 });
    expect(new URL(visitA.headers().location ?? "", portalUrl).search).toBe("");
    const unknown = await request.get("/d/zzzzzzzz", { maxRedirects: 0 });
    expect(unknown.headers()["set-cookie"] ?? "").not.toContain("germinatura_origin");
  });

  test("ADMIN_MASTER sem turma escolhe explicitamente; o menu em Todas marca as telas por turma", async ({ browser }) => {
    const master = await signIn(browser, "master.teste", "Master123!");
    const page = await master.newPage();
    await page.goto("/admin/usuarios");
    await expect(page).toHaveURL(/\/selecionar-turma\?next=%2Fadmin%2Fusuarios/);
    await expect(page.getByText("Nenhuma turma está selecionada.")).toBeVisible();
    await page.getByRole("list", { name: "Turmas" }).getByRole("button", { name: "Todas as turmas (consulta)" }).click();
    await expect(page).toHaveURL(`${portalUrl}/admin/usuarios`);
    const navigation = page.getByRole("navigation", { name: "Navegação principal" }).first();
    const inventory = navigation.getByRole("link", { name: /Estoque/ }).first();
    await expect(inventory).toContainText("por turma");
    await expect(navigation.getByRole("link", { name: /Usuários e vendedores/ })).not.toContainText("por turma");
    await master.close();
  });

  test("ADMIN_MASTER define a turma padrão: visitantes passam a ver a nova padrão", async ({ browser, request }) => {
    const master = await signIn(browser, "master.teste", "Master123!");
    const page = await master.newPage();
    await page.goto("/admin/turmas");
    await page.getByRole("button", { name: `Tornar ${cohortBName} a turma padrão` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Motivo").fill("Nova geração no ar");
    await dialog.getByRole("button", { name: "Tornar padrão" }).click();
    await expect(page.getByRole("status").filter({ hasText: `${cohortBName} agora é a turma padrão.` })).toBeVisible();
    const catalog = await request.get("/api/v1/catalog/products?limit=50");
    expect(JSON.stringify(await catalog.json())).not.toContain("Item público A");
    expect((await master.request.put(`/api/v1/admin/cohorts/${cohortA}/default`, { headers: inCohort("all"), data: { reason: "Volta da turma 2026" } })).status()).toBe(200);
    expect(JSON.stringify(await (await request.get("/api/v1/catalog/products?limit=50")).json())).toContain("Item público A");
    // An ADMIN cannot change it.
    const admin = await signIn(browser, "admin.teste", "Admin123!");
    expect((await admin.request.put(`/api/v1/admin/cohorts/${cohortB}/default`, { headers: { Origin: portalUrl }, data: { reason: "Tentativa" } })).status()).toBe(403);
    await Promise.all([master.close(), admin.close()]);
  });
});
