import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

const TURMA_2026 = "c0000000-0000-4000-8000-000000002026";

// E0 (ADR 0011): unassigned PicPay evidence attributed by two ADMIN_MASTER requests at once. The database serializes them:
// the same line ends in exactly one cohort, and a second assignment to the same cohort finds nothing left to take.
it("serializa atribuições concorrentes: a evidência fica em uma única turma e nunca é atribuída duas vezes", async () => {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Supabase local indisponível");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "master.teste@institutojef.org.br", password: "Master123!" }) });
  const { access_token: token } = await login.json() as { access_token: string };
  const master = async (cohort: string, name: string, body: Record<string, unknown>) => {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-germinatura-cohort": cohort }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  const tag = randomUUID().slice(0, 6);
  let cohortB = "";
  for (let year = 2100; !cohortB && year >= 2060; year -= 1) {
    const created = await master("all", "create_cohort", { p_name: `Atribuição ${tag}`, p_year: year, p_slug: `atrib-${tag}`, p_status: "ACTIVE",
      p_idempotency_key: `attribution-race-${tag}-${year}`, p_correlation_id: randomUUID() });
    if (created.status === 200) cohortB = String(created.body.id);
  }
  expect(cohortB).not.toBe("");
  try {
    // A mixed file: its lines stay global until ADMIN_MASTER attributes them. Unique amounts keep runs apart.
    const base = 100_000 + Math.floor(Math.random() * 800_000);
    const money = (cents: number) => `-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    const content = ["data;movimento;descrição;tipo;valor",
      `2025-04-10;Pix enviado;Disputa ${tag};Saída;${money(base)};`, `2025-04-10;Pix enviado;Repetida ${tag};Saída;${money(base + 1)};`].join("\r\n");
    const imported = await master(TURMA_2026, "import_picpay_file", { p_file_name: `misto-${tag}.csv`, p_content: content, p_scope: "GLOBAL",
      p_declared_cohort_id: null, p_idempotency_key: `attribution-import-${tag}`, p_correlation_id: randomUUID() });
    expect(imported.status).toBe(200);
    expect((imported.body.declaration as { attributed: number }).attributed).toBe(0);
    const items = await master(TURMA_2026, "list_unassigned_picpay_evidence", { p_import_id: imported.body.id, p_limit: 10 });
    const lines = items.body as unknown as Array<{ id: string; amount_cents: number }>;
    const disputed = lines.find((line) => line.amount_cents === -base)?.id as string;
    const repeated = lines.find((line) => line.amount_cents === -(base + 1))?.id as string;
    const assign = (cohort: string, lineId: string, cents: number) => master(cohort, "assign_picpay_evidence", { p_import_id: null,
      p_statement_line_ids: [lineId], p_transaction_ids: null, p_reason: "Corrida de atribuição", p_expected_count: 1,
      p_expected_total_cents: -cents, p_idempotency_key: `attribution-assign-${randomUUID()}`, p_correlation_id: randomUUID() });

    // Turma 2026 and B claim the same line at once: one wins, the other is refused because the line counts elsewhere now.
    const [toA, toB] = await Promise.all([assign(TURMA_2026, disputed, base), assign(cohortB, disputed, base)]);
    expect([toA.status, toB.status].sort()).toEqual([200, 403]);
    expect((toA.status === 403 ? toA : toB).body.message).toBe("PICPAY_EVIDENCE_ATTRIBUTED_TO_ANOTHER_COHORT");

    // The same cohort twice with different keys: the second finds nothing left to attribute.
    const [first, second] = await Promise.all([assign(TURMA_2026, repeated, base + 1), assign(TURMA_2026, repeated, base + 1)]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    expect((first.status === 400 ? first : second).body.message).toBe("PICPAY_ASSIGNMENT_CHANGED");

    const left = await master(TURMA_2026, "list_unassigned_picpay_evidence", { p_import_id: imported.body.id, p_limit: 10 });
    expect(left.body).toEqual([]);
  } finally {
    await master("all", "update_cohort", { p_cohort_id: cohortB, p_name: `Atribuição ${tag}`, p_status: "ARCHIVED", p_reason: "Fim do teste",
      p_correlation_id: randomUUID() });
  }
});
