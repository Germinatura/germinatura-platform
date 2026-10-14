import { expect, test } from "@playwright/test";

const portalUrl = process.env.PORTAL_URL ?? "http://127.0.0.1:3000";
const COHORT = "x-germinatura-cohort";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const shift = (day: string, days: number) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };

// PR E: a cutover counterpart designated and revoked through the screen (presentation only), the overview showing the
// memo, the preserved originals and a bridge with no residual, and a historical adjustment recorded and reversed.
test("financeiro designa uma contrapartida técnica, confere a visão financeira e reverte um ajuste histórico", async ({ page, browser }) => {
  test.slow();
  const tag = Date.now().toString(36);

  // A cohort without an opening position: the overview is a known domain state there (409), never an outage (503).
  const master = await browser.newContext({ baseURL: portalUrl });
  expect((await master.request.post("/api/auth/login", { headers: { Origin: portalUrl },
    data: { identifier: "master.teste", password: "Master123!" } })).status()).toBe(200);
  let empty = "";
  let emptyName = "";
  for (let attempt = 0; attempt < 5 && !empty; attempt += 1) {
    const year = 2040 + Math.floor(Math.random() * 60);
    emptyName = `Turma sem abertura ${tag}${attempt || ""}`;
    const created = await master.request.post("/api/v1/admin/cohorts", { headers: { Origin: portalUrl, [COHORT]: "all", "Idempotency-Key": `e2e-historical-cohort-${tag}-${attempt}` },
      data: { name: emptyName, year, slug: `e2e-historical-${tag}-${attempt}`, status: "ACTIVE" } });
    if (created.status() === 409) continue;
    expect(created.status()).toBe(201);
    empty = (await created.json() as { data: { id: string } }).data.id;
  }
  expect(empty).not.toBe("");
  const withoutOpening = await master.request.get(`/api/v1/admin/finance/overview?from=${today()}&to=${today()}`, { headers: { [COHORT]: empty } });
  expect(withoutOpening.status()).toBe(409);
  expect(await withoutOpening.json()).toMatchObject({ code: "OPENING_POSITION_REQUIRED" });
  expect((await master.request.patch(`/api/v1/admin/cohorts/${empty}`, { headers: { Origin: portalUrl, [COHORT]: "all" },
    data: { name: emptyName, status: "ARCHIVED", reason: "Fim do teste da visão financeira" } })).status()).toBe(200);
  await master.close();

  expect((await page.request.post(`${portalUrl}/api/auth/login`, { headers: { Origin: portalUrl },
    data: { identifier: "admin.teste", password: "Admin123!" } })).status()).toBe(200);
  for (const request of [
    page.request.get(`${portalUrl}/api/v1/admin/finance/historical-adjustments`),
    page.request.get(`${portalUrl}/api/v1/admin/finance/cutover-counterparts`),
  ]) expect((await request).status()).toBe(200);

  // History needs an opening position; an absent one is recorded as the cutover suite records it (400 days ago).
  let opening = (await (await page.request.get(`${portalUrl}/api/v1/admin/finance/opening-position`)).json() as {
    data: { current: { asOf: string; operatingSince: string } | null } }).data.current;
  if (!opening) {
    expect((await page.request.post(`${portalUrl}/api/v1/admin/finance/opening-position`, {
      headers: { Origin: portalUrl, "Idempotency-Key": `e2e-historical-opening-${tag}` },
      data: { asOf: shift(today(), -400), operatingSince: shift(today(), -399), freeCents: 5_000_000, vaultCents: 11_178, receivablesCents: 0, cashCents: 0,
        description: "Abertura do teste histórico", reason: null, supersedesId: null },
    })).status()).toBe(201);
    opening = (await (await page.request.get(`${portalUrl}/api/v1/admin/finance/opening-position`)).json() as {
      data: { current: { asOf: string; operatingSince: string } } }).data.current;
  }
  const historyDay = shift(opening.operatingSince, -1);
  // With the opening, the overview answers with the whole contract.
  const resolved = await page.request.get(`${portalUrl}/api/v1/admin/finance/overview?from=${today()}&to=${today()}`);
  expect(resolved.status()).toBe(200);
  expect((await resolved.json() as { data: unknown }).data).toMatchObject({
    period: { from: today(), to: today(), operatingSince: opening.operatingSince },
    position: { freeCents: expect.any(Number), vaultCents: expect.any(Number), cashCents: expect.any(Number), receivablesCents: expect.any(Number) },
    payables: { openCents: expect.any(Number), openCount: expect.any(Number) },
    result: { officialCents: expect.any(Number), presentation: { operatingResultCents: expect.any(Number) }, costVisibility: { status: expect.any(String) } },
    counterparts: expect.any(Array),
    bridge: { partA: { residualCents: expect.any(Number) } },
  });
  const entry = async (kind: "INCOME" | "EXPENSE", cents: number, reference: string) => expect((await page.request.post(`${portalUrl}/api/v1/admin/finance/entries`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-historical-${reference}` },
    data: { kind, category: kind === "INCOME" ? "AJUSTE" : "MATERIAIS", account: "PICPAY_EMPRESAS", counterAccount: null, amountCents: cents,
      occurredOn: historyDay, description: `Teste histórico ${reference}`, reference },
  })).status()).toBe(201);
  await entry("EXPENSE", 1000, `DESPESA-${tag}`);
  await entry("INCOME", 600, `CUTOVER-${tag}`);
  const overview = async () => (await (await page.request.get(`${portalUrl}/api/v1/admin/finance/overview?from=${historyDay}&to=${historyDay}`)).json() as {
    data: { result: { officialCents: number; presentation: { technicalCutoverCounterpartsCents: number; operatingResultCents: number } };
      bridge: { partA: { residualCents: number } } } }).data;
  const before = await overview();

  // Designation through the screen: the counterpart is consumed whole; nothing in the books changes.
  await page.goto(`${portalUrl}/admin/financeiro/ajustes-historicos`);
  const counterparts = page.getByRole("region", { name: "Contrapartidas técnicas de cutover" });
  await expect(counterparts.getByRole("heading", { name: "Designar contrapartida" })).toBeVisible({ timeout: 90_000 });
  const counterpartSelect = counterparts.getByLabel("Contrapartida (receita manual anterior à operação)");
  await counterpartSelect.selectOption((await counterpartSelect.locator("option", { hasText: `CUTOVER-${tag}` }).getAttribute("value")) ?? "");
  const targetSelect = counterparts.getByLabel("Despesa neutralizada");
  await targetSelect.selectOption((await targetSelect.locator("option", { hasText: `DESPESA-${tag}` }).getAttribute("value")) ?? "");
  await expect(counterparts.getByText(/Valor neutralizado: R\$\s6,00/)).toBeVisible();
  await counterparts.getByLabel("Justificativa").fill(`Contrapartida técnica do teste ${tag}`);
  await counterparts.getByRole("button", { name: "Designar" }).click();
  await expect(page.getByText("Contrapartida designada. Resultado oficial e lançamentos não mudaram.")).toBeVisible();
  const designation = counterparts.getByRole("listitem").filter({ hasText: `CUTOVER-${tag}` });
  await expect(designation.getByText("Ativa", { exact: true })).toBeVisible();

  const after = await overview();
  expect(after.result.officialCents).toBe(before.result.officialCents);
  expect(after.result.presentation.technicalCutoverCounterpartsCents - before.result.presentation.technicalCutoverCounterpartsCents).toBe(600);
  expect(after.result.presentation.operatingResultCents).toBe(after.result.officialCents);
  expect(after.bridge.partA.residualCents).toBe(0);

  // The overview shows the memo and the preserved originals.
  await page.goto(`${portalUrl}/admin/financeiro/visao-geral`);
  await expect(page.getByRole("region", { name: "Posição financeira" })).toBeVisible({ timeout: 90_000 });
  await page.getByLabel("De", { exact: true }).fill(historyDay);
  await page.getByLabel("Até", { exact: true }).fill(historyDay);
  const detail = page.getByRole("region", { name: "Contrapartidas técnicas do período" });
  await expect(detail.getByRole("listitem").filter({ hasText: `CUTOVER-${tag}` }).getByText("classificação gerencial; lançamentos originais preservados")).toBeVisible();
  await expect(page.getByRole("region", { name: "Resultado do período" }).getByText("Ajustes técnicos de cutover")).toBeVisible();
  await expect(page.getByRole("region", { name: "Ponte resultado e caixa" }).getByRole("cell", { name: "Resíduo", exact: true }).first()).toBeVisible();

  // Revocation through the screen.
  await page.goto(`${portalUrl}/admin/financeiro/ajustes-historicos`);
  const again = page.getByRole("region", { name: "Contrapartidas técnicas de cutover" }).getByRole("listitem").filter({ hasText: `CUTOVER-${tag}` });
  await again.getByRole("button", { name: "Revogar" }).click();
  await page.getByLabel("Motivo da revogação").fill(`Revogação do teste ${tag}`);
  await page.getByRole("button", { name: "Confirmar revogação" }).click();
  await expect(again.getByText("Revogada", { exact: true })).toBeVisible();
  expect((await overview()).result.presentation.technicalCutoverCounterpartsCents).toBe(before.result.presentation.technicalCutoverCounterpartsCents);

  // A historical adjustment (no cash), then its reversal through the screen.
  const recorded = await page.request.post(`${portalUrl}/api/v1/admin/finance/historical-adjustments`, {
    headers: { Origin: portalUrl, "Idempotency-Key": `e2e-historical-adjustment-${tag}` },
    data: { component: "DESPESA_OPERACIONAL", direction: "ACRESCIMO", amountCents: 250, competenceOn: historyDay, category: "OUTROS",
      justification: `Despesa histórica comprovada do teste ${tag}`, reference: `AJ-${tag}`, provenance: "HISTORICO_RECONSTRUIDO", stockMovementIds: [] },
  });
  expect(recorded.status()).toBe(201);
  expect((await overview()).result.officialCents).toBe(before.result.officialCents - 250);
  await page.reload();
  const adjustment = page.getByRole("region", { name: "Ajustes históricos sem caixa" }).getByRole("listitem").filter({ hasText: `AJ-${tag}` }).first();
  await expect(adjustment.getByText("Sem impacto no caixa")).toBeVisible({ timeout: 90_000 });
  await adjustment.getByRole("button", { name: "Reverter" }).click();
  await page.getByLabel("Motivo da reversão").fill(`Reversão do teste ${tag}`);
  await page.getByRole("button", { name: "Confirmar reversão" }).click();
  await expect(page.getByText("Ajuste revertido por um novo lançamento; o original continua no histórico.")).toBeVisible();
  expect((await overview()).result.officialCents).toBe(before.result.officialCents);
});
