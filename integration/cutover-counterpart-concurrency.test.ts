import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

// PR E: two technical counterparts designated at once against the same historical expense, together above it. The
// database serializes the designations of a cohort: exactly one wins, the other is refused, and the active designations
// never go beyond the expense.
it("serializa designações concorrentes: a despesa nunca é neutralizada além do seu valor", async () => {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Supabase local indisponível");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const rpc = async (name: string, body: Record<string, unknown>) => {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  // History needs an opening position. Like the finance E2E, an absent one is recorded far in the past, so every other
  // suite keeps the normal (native) rules.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const shift = (day: string, days: number) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
  let opening = (await rpc("get_finance_opening_position", {})).body.current as { operating_since: string } | null;
  if (!opening) {
    const recorded = await rpc("record_finance_opening_position", { p_as_of: shift(today, -400), p_operating_since: shift(today, -399), p_free_cents: 5_000_000,
      p_vault_cents: 0, p_receivables_cents: 0, p_cash_cents: 0, p_description: "Abertura do teste de contrapartidas", p_reason: null, p_supersedes_id: null,
      p_idempotency_key: `counterpart-race-opening-${randomUUID()}`, p_correlation_id: randomUUID() });
    expect(recorded.status).toBe(200);
    opening = (await rpc("get_finance_opening_position", {})).body.current as { operating_since: string };
  }
  const historyDay = shift(opening.operating_since, -1);
  const tag = randomUUID().slice(0, 8);
  const entry = async (kind: string, cents: number, reference: string) => {
    const result = await rpc("record_finance_entry", { p_kind: kind, p_category: kind === "EXPENSE" ? "MATERIAIS" : "AJUSTE", p_account: "PICPAY_EMPRESAS",
      p_counter_account: null, p_amount_cents: cents, p_occurred_on: historyDay, p_description: `Corrida de contrapartidas ${tag} ${reference}`,
      p_reference: `${reference}-${tag}`, p_idempotency_key: `counterpart-race-${reference}-${tag}`, p_correlation_id: randomUUID() });
    expect(result.status).toBe(200);
    return String(result.body.id);
  };
  const target = await entry("EXPENSE", 100_000, "ALVO");
  const first = await entry("INCOME", 60_000, "CP1");
  const second = await entry("INCOME", 60_000, "CP2");

  const designate = (counterpart: string) => rpc("designate_cutover_counterpart", { p_counterpart_manual_entry_id: counterpart, p_target_statement_line_id: null,
    p_target_manual_expense_id: target, p_neutralized_cents: 60_000, p_reason: "Corrida de contrapartidas do teste",
    p_idempotency_key: `counterpart-race-designate-${counterpart}`, p_correlation_id: randomUUID() });
  const [a, b] = await Promise.all([designate(first), designate(second)]);
  expect([a.status, b.status].sort()).toEqual([200, 400]);
  expect((a.status === 400 ? a : b).body.message).toBe("CUTOVER_TARGET_EXCEEDED");

  const listed = await rpc("list_cutover_counterparts", {});
  const items = (listed.body.items as Array<{ status: string; neutralized_cents: number; target: { id: string } }>)
    .filter((item) => item.target.id === target && item.status === "ATIVA");
  expect(items).toHaveLength(1);
  expect(items.reduce((sum, item) => sum + item.neutralized_cents, 0)).toBeLessThanOrEqual(100_000);
});
