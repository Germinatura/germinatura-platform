import { expect, test, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";

// ADR 0011 (PR 3): cohort context end to end — two cohorts (A = Turma 2026, B created here), ADMIN of each, a seller of
// B and a seller of both. ADMIN of A never reaches B; ADMIN_MASTER reads everything in "Todas as turmas" and writes cohort
// data only inside one cohort; the Portal → PDV handoff keeps the cohort; the PDV never runs in "all".
const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const pdvUrl = process.env.PDV_URL ?? "http://127.0.0.1:3001";
const cohortA = "c0000000-0000-4000-8000-000000002026";
const COHORT = "x-germinatura-cohort";
const suffix = Date.now().toString(36).slice(-7);
const password = "Turmas123!";
const person = (key: string) => ({ username: `e2e.${key}.${suffix}`, email: `e2e.${key}.${suffix}@institutojef.org.br`, displayName: `E2E ${key.toUpperCase()} ${suffix}` });
const people = { adminA: person("adma"), adminB: person("admb"), sellerB: person("vendb"), sellerAB: person("vendab") };
const ids: Record<keyof typeof people, string> = { adminA: "", adminB: "", sellerB: "", sellerAB: "" };
let cohortB = "";
let cohortBName = "";

async function signIn(browser: Browser, identifier: string, secret: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: portalUrl });
  const login = await context.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier, password: secret } });
  expect(login.status(), identifier).toBe(200);
  return context;
}
const inCohort = (cohort: string, extra: Record<string, string> = {}) => ({ Origin: portalUrl, [COHORT]: cohort, ...extra });

// ADMIN_MASTER through the Data API, only to give one person a second cohort (no Portal screen does that in PR 3).
async function masterRpc(name: string, body: Record<string, unknown>, cohort: string) {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key) throw new Error("Supabase local indisponível");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", [COHORT]: cohort }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function provision(request: APIRequestContext, cohort: string, who: keyof typeof people, roles: string[]) {
  const created = await request.post("/api/v1/admin/users", { headers: inCohort(cohort),
    data: { ...people[who], password, roles: roles.includes("ADMIN") ? ["CONSUMIDOR"] : roles, active: true } });
  expect(created.status(), `provision ${who}`).toBe(201);
  ids[who] = (await created.json() as { data: { user_id: string } }).data.user_id;
  if (roles.includes("ADMIN")) {
    const access = await request.patch(`/api/v1/admin/users/${ids[who]}/roles`, { headers: inCohort(cohort), data: { roles: [...roles, "CONSUMIDOR"], active: true } });
    expect(access.status(), `roles ${who}`).toBe(200);
  }
}

test.describe.serial("turmas A/B (ADR 0011)", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const master = await signIn(browser, "admin.teste", "Admin123!");
    // Creating a cohort is global: allowed in "Todas as turmas".
    for (let attempt = 0; attempt < 5 && !cohortB; attempt += 1) {
      const year = 2040 + Math.floor(Math.random() * 60);
      cohortBName = `Turma E2E ${suffix}${attempt || ""}`;
      const created = await master.request.post("/api/v1/admin/cohorts", { headers: inCohort("all", { "Idempotency-Key": `e2e-cohort-${suffix}-${attempt}` }),
        data: { name: cohortBName, year, slug: `e2e-${suffix}-${attempt}`, status: "ACTIVE" } });
      if (created.status() === 409) continue;
      expect(created.status()).toBe(201);
      cohortB = (await created.json() as { data: { id: string } }).data.id;
    }
    expect(cohortB).not.toBe("");
    await provision(master.request, cohortA, "adminA", ["ADMIN"]);
    await provision(master.request, cohortB, "adminB", ["ADMIN"]);
    await provision(master.request, cohortB, "sellerB", ["VENDEDOR"]);
    await provision(master.request, cohortA, "sellerAB", ["VENDEDOR"]);
    await masterRpc("set_cohort_membership", { p_user_id: ids.sellerAB, p_active: true, p_reason: "Vendedora das duas turmas", p_correlation_id: crypto.randomUUID() }, cohortB);
    await masterRpc("set_user_access", { p_user_id: ids.sellerAB, p_roles: ["VENDEDOR", "CONSUMIDOR"], p_active: true, p_correlation_id: crypto.randomUUID() }, cohortB);
    await master.close();
  });

  // The people stay (identities are never deleted); they leave A and B is archived, so later journeys see one cohort.
  test.afterAll(async ({ browser }) => {
    const master = await signIn(browser, "admin.teste", "Admin123!");
    for (const who of ["adminA", "sellerAB"] as const) {
      if (ids[who]) await master.request.patch(`/api/v1/admin/users/${ids[who]}/roles`, { headers: inCohort(cohortA), data: { roles: ["CONSUMIDOR"], active: false } });
    }
    if (cohortB) {
      const archived = await master.request.patch(`/api/v1/admin/cohorts/${cohortB}`, { headers: inCohort("all"),
        data: { name: cohortBName, status: "ARCHIVED", reason: "Fim do teste de turmas" } });
      expect(archived.status()).toBe(200);
    }
    await master.close();
  });

  test("ADMIN de A não consulta, não altera e não alcança a turma B", async ({ browser }) => {
    const adminA = await signIn(browser, people.adminA.username, password);
    const search = await adminA.request.get(`/api/v1/admin/users?q=${encodeURIComponent(people.sellerB.username)}`, { headers: { [COHORT]: cohortA } });
    expect(search.status()).toBe(200);
    expect((await search.json() as { page: { matched: number } }).page.matched).toBe(0);
    const ownCohort = await adminA.request.get(`/api/v1/admin/users?q=${encodeURIComponent(people.sellerAB.username)}`);
    expect((await ownCohort.json() as { data: { id: string }[] }).data.map((user) => user.id)).toEqual([ids.sellerAB]);

    // Altering a role of a person of B, by id: the person does not exist for A.
    const alter = await adminA.request.patch(`/api/v1/admin/users/${ids.sellerB}/roles`, { headers: inCohort(cohortA), data: { roles: ["ADMIN", "CONSUMIDOR"], active: true } });
    expect(alter.status()).toBe(404);
    // Forcing the context of B, in the header, in the cookie or as a listing filter.
    const forced = await adminA.request.get("/api/v1/admin/users", { headers: { [COHORT]: cohortB } });
    expect(forced.status()).toBe(403);
    expect((await forced.json() as { code: string }).code).toBe("COHORT_FORBIDDEN");
    expect((await adminA.request.post("/api/v1/session/cohort", { headers: { Origin: portalUrl }, data: { cohort: cohortB } })).status()).toBe(403);
    expect((await adminA.request.get(`/api/v1/admin/users?cohort=${cohortB}`, { headers: { [COHORT]: cohortA } })).status()).toBe(403);
    // Cohort administration and "Todas as turmas" are ADMIN_MASTER only.
    expect((await adminA.request.get("/api/v1/admin/users", { headers: { [COHORT]: "all" } })).status()).toBe(403);
    expect((await adminA.request.get("/api/v1/admin/cohorts")).status()).toBe(403);
    await adminA.close();
  });

  test("vendedor forçando outra turma, contexto adulterado e maquininha/flag de outra turma", async ({ browser }) => {
    const seller = await signIn(browser, "vendedor.teste", "Vendedor123!");
    const forced = await seller.request.post("/api/v1/pdv/handoff", { headers: inCohort(cohortB) });
    expect(forced.status()).toBe(403);
    expect((await forced.json() as { code: string }).code).toBe("COHORT_FORBIDDEN");
    for (const tampered of ["all", "2026", `${cohortA}'--`]) {
      const response = await seller.request.get("/api/v1/feature-flags", { headers: { [COHORT]: tampered } });
      expect(response.status(), tampered).toBe(tampered === "all" ? 403 : 400);
    }

    // A terminal authorized for B and a flag changed in B stay in B.
    const code = `MAQ-${suffix}`.toUpperCase();
    await masterRpc("save_payment_terminal", { p_terminal_id: null, p_code: code, p_label: "Maquininha da turma B", p_active: true,
      p_idempotency_key: `e2e-terminal-${suffix}`, p_correlation_id: crypto.randomUUID() }, cohortB);
    const terminalsA = await seller.request.get("/api/v1/pdv/terminals");
    expect(JSON.stringify(await terminalsA.json())).not.toContain(code);
    const sellerB = await signIn(browser, people.sellerB.username, password);
    expect(JSON.stringify(await (await sellerB.request.get("/api/v1/pdv/terminals")).json())).toContain(code);

    const master = await signIn(browser, "admin.teste", "Admin123!");
    expect((await master.request.patch("/api/v1/admin/feature-flags/raffles", { headers: inCohort(cohortB), data: { enabled: false, reason: "Rifas pausadas só na turma B" } })).status()).toBe(200);
    const flag = async (context: BrowserContext) => ((await (await context.request.get("/api/v1/feature-flags")).json()) as { data: { key: string; enabled: boolean }[] })
      .data.find((item) => item.key === "raffles")?.enabled;
    expect(await flag(sellerB)).toBe(false);
    expect(await flag(seller)).toBe(true);
    await Promise.all([seller.close(), sellerB.close(), master.close()]);
  });

  test("ADMIN_MASTER em Todas as turmas consulta e filtra, mas só escreve dado de turma dentro de uma turma", async ({ browser }) => {
    const master = await signIn(browser, "admin.teste", "Admin123!");
    expect((await master.request.post("/api/v1/session/cohort", { headers: { Origin: portalUrl }, data: { cohort: "all" } })).status()).toBe(200);
    const write = await master.request.post("/api/v1/admin/catalog/categories", { headers: { Origin: portalUrl },
      data: { name: "Categoria em todas", slug: `todas-${suffix}`, active: true, sortOrder: 1, description: "Não deve existir" } });
    expect(write.status()).toBe(409);
    expect((await write.json() as { code: string }).code).toBe("COHORT_REQUIRED");
    expect((await master.request.post("/api/v1/pdv/handoff", { headers: { Origin: portalUrl } })).status()).toBe(409);

    const page = await master.newPage();
    await page.goto("/admin/usuarios");
    await expect(page.getByRole("status").filter({ hasText: "Visão de todas as turmas: somente consulta" })).toBeVisible();
    const main = page.getByRole("main");
    await expect(main.getByRole("button", { name: "Adicionar usuário" })).toBeDisabled();
    await expect(main.getByText(/\d+ de \d+ usuários/)).toBeVisible();
    await main.getByRole("combobox", { name: "Turma", exact: true }).selectOption(cohortB);
    await expect(main.getByRole("button", { name: `Remover filtro Turma: ${cohortBName}` })).toBeVisible();
    await expect(main.getByText(people.adminB.email).first()).toBeVisible();
    await expect(main.getByText(people.adminA.email)).toHaveCount(0);

    // Global operations stay available in "Todas": renaming a cohort.
    await page.goto("/admin/turmas");
    await main.getByRole("button", { name: `Alterar ${cohortBName}` }).click();
    const dialog = page.getByRole("dialog");
    cohortBName = `${cohortBName} (renomeada)`;
    await dialog.getByLabel("Nome").fill(cohortBName);
    await dialog.getByLabel("Motivo").fill("Nome oficial da turma");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Turma ${cohortBName} atualizada.` })).toBeVisible();
    await master.close();
  });

  test("filtros, chips e paginação da gestão de usuários pelo ADMIN da turma B", async ({ browser }) => {
    const adminB = await signIn(browser, people.adminB.username, password);
    const first = await adminB.request.get("/api/v1/admin/users?limit=1&offset=0");
    const second = await adminB.request.get("/api/v1/admin/users?limit=1&offset=1");
    const firstBody = await first.json() as { data: { id: string }[]; page: { total: number; matched: number; offset: number; limit: number } };
    const secondBody = await second.json() as { data: { id: string }[] };
    expect(firstBody.page).toMatchObject({ offset: 0, limit: 1 });
    expect(firstBody.page.total).toBeGreaterThanOrEqual(3);
    expect(firstBody.data[0]?.id).not.toBe(secondBody.data[0]?.id);
    expect((await adminB.request.get("/api/v1/admin/users?limit=101")).status()).toBe(422);

    const page = await adminB.newPage();
    await page.goto("/admin/usuarios");
    const main = page.getByRole("main");
    await expect(main.getByText(new RegExp(`^${firstBody.page.total} de ${firstBody.page.total} usuários$`))).toBeVisible();
    await expect(main.getByText("consumidor.teste")).toHaveCount(0);
    await main.getByPlaceholder("Nome, usuário ou e-mail").fill(people.sellerB.username);
    await expect(main.getByText(new RegExp(`^1 de ${firstBody.page.total} usuários$`))).toBeVisible();
    await expect(main.getByRole("button", { name: `Remover filtro Busca: ${people.sellerB.username}` })).toBeVisible();
    await main.getByRole("button", { name: "Limpar filtros" }).click();
    await main.getByRole("group", { name: "Papéis" }).getByLabel("Administrador").check();
    await expect(main.getByRole("button", { name: "Remover filtro Qualquer: Administrador" })).toBeVisible();
    await expect(main.getByText(people.adminB.email).first()).toBeVisible();
    await expect(main.getByText(people.sellerB.email)).toHaveCount(0);
    await main.getByLabel("Situação").selectOption("INACTIVE");
    await expect(main.getByText("Nenhum usuário encontrado")).toBeVisible();
    await main.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(main.getByText(new RegExp(`^${firstBody.page.total} de ${firstBody.page.total} usuários$`))).toBeVisible();
    await adminB.close();
  });

  test("o handoff Portal → PDV preserva a turma escolhida no Portal", async ({ browser }) => {
    test.slow();
    const context = await signIn(browser, people.sellerAB.username, password);
    const page = await context.newPage();
    await page.goto("/inicio");
    const selected = page.waitForResponse((response) => response.url().endsWith("/api/v1/session/cohort") && response.request().method() === "POST");
    await page.getByRole("combobox", { name: "Turma" }).selectOption(cohortB);
    expect((await selected).status()).toBe(200);
    await expect(page.getByRole("combobox", { name: "Turma" })).toHaveValue(cohortB);
    const cohortCall = page.waitForRequest((request) => request.url().startsWith(`${pdvUrl}/api/v1/`) && request.headers()[COHORT] === cohortB, { timeout: 60_000 });
    await page.getByRole("button", { name: "Abrir PDV" }).click();
    await page.waitForURL(`${pdvUrl}/`, { timeout: 60_000 });
    await cohortCall;
    // The PDV header names the cohort before the location: "<cohort> · <location>".
    await expect(page.getByText(`${cohortBName} · `, { exact: false })).toBeVisible();
    expect((await context.cookies(pdvUrl)).find((cookie) => cookie.name === "germinatura_pdv_cohort")?.value).toBe(cohortB);
    // The catalog is the one of B (empty), never the catalog of Turma 2026.
    await expect(page.getByRole("region", { name: "Catálogo" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Item público A" })).toHaveCount(0);

    // Switching inside the PDV lists only the cohorts the database confirms for the PDV.
    await page.goto(`${pdvUrl}/turma`);
    const options = page.getByRole("list", { name: "Turmas disponíveis" });
    await expect(options.getByRole("button")).toHaveCount(2);
    await options.getByRole("button", { name: /Turma 2026/ }).click();
    await page.waitForURL(`${pdvUrl}/`);
    await expect(page.getByText("Turma 2026 · ", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Item público A" })).toBeVisible();
    await context.close();
  });

  test("no PDV quem tem duas turmas escolhe uma, e Todas as turmas nunca é contexto", async ({ browser }) => {
    test.slow();
    const context = await browser.newContext({ baseURL: pdvUrl });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Usuário ou e-mail").fill(people.sellerAB.username);
    await page.getByLabel("Senha").fill(password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForURL(`${pdvUrl}/turma`, { timeout: 60_000 });
    await expect(page.getByRole("list", { name: "Turmas disponíveis" }).getByRole("button")).toHaveCount(2);

    expect((await context.request.post("/api/auth/cohort", { headers: { Origin: pdvUrl }, data: { cohort: "all" } })).status()).toBe(422);
    expect((await context.request.post("/api/auth/cohort", { headers: { Origin: pdvUrl }, data: { cohort: crypto.randomUUID() } })).status()).toBe(403);
    await context.addCookies([{ name: "germinatura_pdv_cohort", value: "all", url: pdvUrl }]);
    await page.goto("/");
    await page.waitForURL(`${pdvUrl}/turma`);
    expect((await context.cookies(pdvUrl)).find((cookie) => cookie.name === "germinatura_pdv_cohort")?.value ?? "").toBe("");

    // A single-cohort seller is placed in that cohort without choosing.
    const single = await browser.newContext({ baseURL: pdvUrl });
    const singlePage = await single.newPage();
    await singlePage.goto("/login");
    await singlePage.getByLabel("Usuário ou e-mail").fill(people.sellerB.username);
    await singlePage.getByLabel("Senha").fill(password);
    await singlePage.getByRole("button", { name: "Entrar" }).click();
    await singlePage.waitForURL(`${pdvUrl}/`, { timeout: 60_000 });
    expect((await single.cookies(pdvUrl)).find((cookie) => cookie.name === "germinatura_pdv_cohort")?.value).toBe(cohortB);
    await Promise.all([context.close(), single.close()]);
  });
});
