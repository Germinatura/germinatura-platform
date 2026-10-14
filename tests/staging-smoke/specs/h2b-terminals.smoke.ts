import { expect, test } from "@playwright/test";
import { checkout, confirmManual, fixture, key, kinder, reference, sellerA, sellerB, session, target } from "../support";

// H2b: with whom each terminal is (finance, audited) and the server-side preselection: assigned > last used > only
// active > none. Assignment is never exclusivity. Runs before the other PDV smokes touch terminals (file order).
test("H2b: atribuída, troca livre, última usada, única ativa, inativa ignorada e auditoria", async ({ browser }) => {
  const admin = await session(browser, "portal", fixture.admin.username);
  const a = await session(browser, "pdv", sellerA.username);
  const b = await session(browser, "pdv", sellerB.username);
  const { a: terminalA, b: terminalB } = fixture.terminals;
  const preference = async (request: typeof a.request) =>
    (await (await request.get("/api/v1/pdv/terminals")).json() as { preference: { terminalId: string | null; source: string | null } }).preference;
  const assign = (terminalId: string, assigneeId: string | null) => admin.request.post(`/api/v1/admin/finance/terminals/${terminalId}/assignment`,
    { headers: { "Idempotency-Key": key(`assign-${terminalId}-${assigneeId}`) }, data: { assigneeId, reason: "Smoke automatizado do PDV" } });
  const setActive = (terminal: { id: string; code: string; label: string }, active: boolean) => admin.request.patch(`/api/v1/admin/finance/terminals/${terminal.id}`,
    { headers: { "Idempotency-Key": key(`active-${terminal.id}-${active}`) }, data: { code: terminal.code, label: terminal.label, active } });
  try {
    // Two active terminals, no assignment, no history: nothing preselected.
    expect(await preference(b.request)).toEqual({ terminalId: null, source: null });

    // Finance gives Romeu (A) to seller A; a seller cannot manage assignments.
    expect((await assign(terminalA.id, sellerA.id)).status()).toBe(200);
    const sellerOnPortal = await session(browser, "portal", sellerA.username);
    expect((await sellerOnPortal.request.post(`/api/v1/admin/finance/terminals/${terminalA.id}/assignment`, { headers: { "Idempotency-Key": key("seller-assign-portal") },
      data: { assigneeId: null, reason: "Tentativa indevida" } })).status()).toBe(403);
    await sellerOnPortal.context.close();
    expect(await preference(a.request)).toEqual({ terminalId: terminalA.id, source: "ASSIGNED" });

    // The screen preselects it and says with whom it is.
    const page = await a.context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: `Adicionar uma unidade de ${kinder.name}` }).click({ timeout: 90_000 });
    await page.getByRole("complementary").getByRole("button", { name: "Revisar venda" }).click();
    await page.getByRole("button", { name: /^Cobrar/ }).click();
    const picker = page.getByLabel("Maquininha usada");
    await expect(picker).toHaveValue(terminalA.id);
    await expect(picker.locator("option:checked")).toHaveText(`${terminalA.code} · ${terminalA.label} (com ${sellerA.name})`);
    await page.getByRole("button", { name: "Cancelar venda pendente" }).click();

    // Free swap: seller B uses A, which is with seller A; it becomes B's last used terminal.
    const sale = await checkout(b.request, sellerB.locationId, kinder.id, "terminal-swap");
    const used = await confirmManual(b.request, sale, { integrationChannel: "MAQUININHA", cardMethod: "DEBITO", terminalId: terminalA.id, proofReference: reference("T1"), surchargeCents: 0 }, "terminal-swap");
    expect(used.status(), await used.text()).toBe(200);
    expect(await preference(b.request)).toEqual({ terminalId: terminalA.id, source: "LAST_USED" });

    // A inactive: ignored as assigned and as last used; B is the only active terminal.
    expect((await setActive(terminalA, false)).status()).toBe(200);
    expect(await preference(a.request)).toEqual({ terminalId: terminalB.id, source: "ONLY_ACTIVE" });
    expect(await preference(b.request)).toEqual({ terminalId: terminalB.id, source: "ONLY_ACTIVE" });

    // Audit of the assignment.
    const [audit] = await target.sql(`select count(*)::integer as total from cohort_data.audit_logs where action = 'payments.terminal.assigned' and entity_id = '${terminalA.id}'`);
    expect(Number(audit.total)).toBeGreaterThanOrEqual(1);
  } finally {
    await setActive(terminalA, true);
    await assign(terminalA.id, null);
    await Promise.all([admin.context.close(), a.context.close(), b.context.close()]);
  }
});
