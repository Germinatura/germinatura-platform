import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

const TURMA_2026 = "c0000000-0000-4000-8000-000000002026";

// ADR 0011 (PR 5): two cohorts asked to become the default at the same time. The database serializes the changes:
// both requests finish, and there is always exactly one default, ACTIVE, at the end.
it("two cohorts trying to become the default at once leave exactly one default", async () => {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  const serviceKey = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !serviceKey || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Local Supabase required");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "master.teste@institutojef.org.br", password: "Master123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const master = async (name: string, body: Record<string, unknown>) => {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-germinatura-cohort": "all" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const defaults = async () => {
    const response = await fetch(`${url}/rest/v1/cohorts?select=id,status&is_default=eq.true`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    return await response.json() as Array<{ id: string; status: string }>;
  };

  const tag = randomUUID().slice(0, 6);
  const created: string[] = [];
  // Years are unique; earlier runs leave their (archived) cohorts behind, so try free years.
  for (let year = 2041; created.length < 2 && year <= 2100; year += 1) {
    const index = created.length;
    const result = await master("create_cohort", { p_name: `Concorrência ${tag} ${index}`, p_year: year, p_slug: `conc-${tag}-${index}`, p_status: "ACTIVE",
      p_idempotency_key: `default-race-${tag}-${year}`, p_correlation_id: randomUUID() });
    if (result.status === 200) created.push(String(result.body.id));
  }
  expect(created).toHaveLength(2);
  try {
    const [first, second] = await Promise.all(created.map((cohort) => master("set_default_cohort",
      { p_cohort_id: cohort, p_reason: "Corrida de turma padrão", p_correlation_id: randomUUID() })));
    expect([first.status, second.status]).toEqual([200, 200]);
    const after = await defaults();
    expect(after).toHaveLength(1);
    expect(created).toContain(after[0]?.id);
    expect(after[0]?.status).toBe("ACTIVE");
  } finally {
    expect((await master("set_default_cohort", { p_cohort_id: TURMA_2026, p_reason: "Fim do teste de concorrência", p_correlation_id: randomUUID() })).status).toBe(200);
    for (const cohort of created) {
      await master("update_cohort", { p_cohort_id: cohort, p_name: `Concorrência ${tag}`, p_status: "ARCHIVED", p_reason: "Fim do teste", p_correlation_id: randomUUID() });
    }
  }
  expect((await defaults()).map((row) => row.id)).toEqual([TURMA_2026]);
});
