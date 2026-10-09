import { expect, test, type Browser, type BrowserContext } from "@playwright/test";

// ADR 0011: one rule for a cohort's public slug (1 to 32 characters) in the API, the admin form and ?turma=.
const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const COHORT = "x-germinatura-cohort";
const suffix = Date.now().toString(36).slice(-7);
const slug32 = `s${suffix}`.padEnd(31, "x") + "z";
const slug33 = `${slug32}z`;

async function signIn(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: portalUrl });
  const login = await context.request.post("/api/auth/login", { headers: { Origin: portalUrl }, data: { identifier: "master.teste", password: "Master123!" } });
  expect(login.status()).toBe(200);
  return context;
}
const global = (key?: string) => ({ Origin: portalUrl, [COHORT]: "all", ...(key ? { "Idempotency-Key": key } : {}) });

test("identificador de turma: até 32 caracteres, mesmo formato na API, no formulário e no ?turma= público", async ({ browser, request }) => {
  test.slow();
  expect(slug32).toHaveLength(32);
  const master = await signIn(browser);
  const create = (slug: string, year: number, key: string) => master.request.post("/api/v1/admin/cohorts", { headers: global(`e2e-slug-${suffix}-${key}`),
    data: { name: `Turma Slug ${suffix}`, year, slug, status: "ACTIVE" } });

  // 32 characters: created (a 409 here can only be a year already taken by an earlier run: try another year).
  let cohortId = "";
  let year = 0;
  for (let attempt = 0; attempt < 5 && !cohortId; attempt += 1) {
    year = 2040 + Math.floor(Math.random() * 60);
    const created = await create(slug32, year, `ok-${attempt}`);
    if (created.status() === 409) continue;
    expect(created.status()).toBe(201);
    cohortId = (await created.json() as { data: { id: string } }).data.id;
  }
  expect(cohortId).not.toBe("");

  try {
    // 33 characters and invalid formats: 422.
    for (const [key, slug] of [["33", slug33], ["hyphen", `-${suffix}`], ["underscore", `t_${suffix}`], ["space", `t ${suffix}`]] as const) {
      const refused = await create(slug, year === 2099 ? 2098 : year + 1, key);
      expect(refused.status(), slug).toBe(422);
      expect((await refused.json() as { code: string }).code).toBe("INVALID_COHORT");
    }
    // Duplicate slug: 409.
    const duplicate = await create(slug32, year === 2099 ? 2098 : year + 1, "dup");
    expect(duplicate.status()).toBe(409);
    expect((await duplicate.json() as { code: string }).code).toBe("COHORT_ALREADY_EXISTS");
    // The slug is never edited.
    expect((await master.request.patch(`/api/v1/admin/cohorts/${cohortId}`, { headers: global(),
      data: { name: `Turma Slug ${suffix}`, status: "ACTIVE", reason: "Trocar identificador", slug: "outro" } })).status()).toBe(422);

    // Public ?turma=: the 32-character slug resolves to its cohort; 33 characters do not.
    const publicCatalog = await request.get(`/api/v1/catalog/products?limit=1&turma=${slug32}`);
    expect(publicCatalog.status()).toBe(200);
    expect(publicCatalog.headers()[COHORT]).toBe(cohortId);
    expect((await request.get(`/api/v1/catalog/products?limit=1&turma=${slug33}`)).status()).toBe(404);

    // The admin form holds the same rule.
    const page = await master.newPage();
    await page.goto("/admin/turmas");
    await page.getByRole("button", { name: "Nova turma" }).click();
    const field = page.getByRole("dialog").getByLabel("Identificador");
    await field.fill("a".repeat(40));
    await expect(field).toHaveValue("a".repeat(32));
    for (const [value, valid] of [[slug32, true], [`-${suffix}`, false], [`t_${suffix}`, false], [`${suffix}-`, false]] as const) {
      await field.fill(value);
      expect(await field.evaluate((input: HTMLInputElement) => input.validity.valid), value).toBe(valid);
    }
    await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click();
    await page.getByRole("button", { name: `Alterar Turma Slug ${suffix}` }).click();
    await expect(page.getByRole("dialog").getByLabel("Identificador")).toHaveCount(0);
  } finally {
    // Archived: the public slug no longer resolves (404, never the default cohort).
    const archived = await master.request.patch(`/api/v1/admin/cohorts/${cohortId}`, { headers: global(),
      data: { name: `Turma Slug ${suffix}`, status: "ARCHIVED", reason: "Fim do teste de identificador" } });
    expect(archived.status()).toBe(200);
    await master.close();
  }
  expect((await request.get(`/api/v1/catalog/products?limit=1&turma=${slug32}`)).status()).toBe(404);
});
