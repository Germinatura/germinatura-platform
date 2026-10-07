import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

function local() {
  const output = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = output.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = output.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Supabase local indisponível");
  return { url, key };
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

// No opening position is recorded here: the run keeps the normal (non-cutover) rules for later suites.
it("serializa revisão em lote, revisão individual e vínculos concorrentes sem decisão dupla", async () => {
  const { url, key } = local();
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const token = (await login.json() as { access_token?: string }).access_token;
  expect(login.ok && token).toBeTruthy();
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function rpc(name: string, input: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(input) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }

  // Unique amounts keep the file and the link candidates of this run apart from earlier runs.
  const base = 100_000 + Math.floor(Math.random() * 800_000);
  const money = (cents: number) => `-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  const line = (description: string, cents: number) => `${today};Pix enviado;${description};Saída;${money(cents)};`;
  const content = ["data;movimento;descrição;tipo;valor",
    line("Corrida individual", base), line("Corrida lote", base + 1), line("Vínculo A", base + 2), line("Vínculo B", base + 2), line("Lote duplo", base + 3)].join("\r\n");
  const imported = await rpc("import_picpay_statement", { p_file_name: `corrida-${randomUUID()}.csv`, p_content: content,
    p_accept_overlap: true, p_idempotency_key: `race-import:${randomUUID()}`, p_correlation_id: randomUUID() });
  expect(imported.status).toBe(200);
  const importId = imported.data.id as string;
  const lines = await rpc("list_picpay_statement_lines", { p_import_id: importId, p_pending_only: true, p_after_line: null, p_limit: 50 });
  const items = lines.data.items as Array<{ id: string; line_number: number }>;
  const lineId = (number: number) => items.find((item) => item.line_number === number)?.id as string;

  // A bulk and a single review of the same line: exactly one decision wins, the other is refused.
  const preview = await rpc("preview_picpay_statement_bulk", { p_import_id: importId, p_movement: null, p_from: null, p_to: null,
    p_line_ids: [lineId(2), lineId(3)], p_category: "OUTROS" });
  expect(preview.data).toMatchObject({ count: 2, total_cents: -(2 * base + 1), refusals: [] });
  const bulk = (keySuffix: string) => rpc("resolve_picpay_statement_lines_bulk", { p_import_id: importId, p_movement: null, p_from: null,
    p_to: null, p_line_ids: [lineId(2), lineId(3)], p_category: "OUTROS", p_reason: "Despesas do teste concorrente",
    p_expected_count: 2, p_expected_total_cents: -(2 * base + 1), p_expected_selection_sha256: preview.data.selection_sha256,
    p_idempotency_key: `race-bulk:${keySuffix}`, p_correlation_id: randomUUID() });
  const [bulkResult, single] = await Promise.all([
    bulk(randomUUID()),
    rpc("resolve_picpay_statement_line", { p_line_id: lineId(2), p_action: "CLASSIFICAR", p_category: "FORNECEDOR",
      p_payment_attempt_id: null, p_refund_entry_id: null, p_reason: null, p_idempotency_key: `race-single:${randomUUID()}`,
      p_correlation_id: randomUUID() }),
  ]);
  expect([bulkResult.status, single.status].sort()).toEqual([200, 400]);
  const refused = bulkResult.status === 400 ? bulkResult : single;
  expect(refused.data.message).toMatch(/STATEMENT_BULK_SELECTION_CHANGED|STATEMENT_LINE_ALREADY_RESOLVED/);
  // When the single review won, line 3 is still pending: close it the normal way.
  if (bulkResult.status === 400) {
    const rest = await rpc("resolve_picpay_statement_line", { p_line_id: lineId(3), p_action: "CLASSIFICAR", p_category: "OUTROS",
      p_payment_attempt_id: null, p_refund_entry_id: null, p_reason: null, p_idempotency_key: `race-rest:${randomUUID()}`,
      p_correlation_id: randomUUID() });
    expect(rest.status).toBe(200);
  }

  // Two bulks of the same selection: one applies it, the other finds it changed.
  const twice = await rpc("preview_picpay_statement_bulk", { p_import_id: importId, p_movement: null, p_from: null, p_to: null,
    p_line_ids: [lineId(6)], p_category: "OUTROS" });
  const again = () => rpc("resolve_picpay_statement_lines_bulk", { p_import_id: importId, p_movement: null, p_from: null,
    p_to: null, p_line_ids: [lineId(6)], p_category: "OUTROS", p_reason: "Despesas do teste concorrente", p_expected_count: 1,
    p_expected_total_cents: -(base + 3), p_expected_selection_sha256: twice.data.selection_sha256,
    p_idempotency_key: `race-bulk-twice:${randomUUID()}`, p_correlation_id: randomUUID() });
  const [a, b] = await Promise.all([again(), again()]);
  expect([a.status, b.status].sort()).toEqual([200, 400]);
  expect((a.status === 400 ? a : b).data.message).toBe("STATEMENT_BULK_SELECTION_CHANGED");

  // Two lines with the same amount race for the same manual entry: one link, never two.
  const entry = await rpc("record_finance_entry", { p_kind: "EXPENSE", p_category: "MATERIAIS", p_account: "PICPAY_EMPRESAS",
    p_counter_account: null, p_amount_cents: base + 2, p_occurred_on: today, p_description: "Material do teste concorrente",
    p_reference: null, p_idempotency_key: `race-entry:${randomUUID()}`, p_correlation_id: randomUUID() });
  expect(entry.status).toBe(200);
  const link = (number: number) => rpc("link_picpay_statement_line", { p_line_id: lineId(number), p_payable_settlement_id: null,
    p_manual_entry_id: entry.data.id, p_reason: null, p_idempotency_key: `race-link:${randomUUID()}`, p_correlation_id: randomUUID() });
  const [linkA, linkB] = await Promise.all([link(4), link(5)]);
  expect([linkA.status, linkB.status].sort()).toEqual([200, 400]);
  expect((linkA.status === 400 ? linkA : linkB).data.message).toBe("STATEMENT_LINK_RECORD_NOT_LINKABLE");

  // The losing line is closed explicitly, so no line of this run stays pending for later suites.
  const loser = linkA.status === 400 ? 4 : 5;
  const closed = await rpc("resolve_picpay_statement_line", { p_line_id: lineId(loser), p_action: "JA_REGISTRADO", p_category: null,
    p_payment_attempt_id: null, p_refund_entry_id: null, p_reason: "Registro do teste concorrente", p_idempotency_key: `race-close:${randomUUID()}`,
    p_correlation_id: randomUUID() });
  expect(closed.status).toBe(200);
  const after = await rpc("list_picpay_statement_lines", { p_import_id: importId, p_pending_only: false, p_after_line: null, p_limit: 50 });
  const statuses = (after.data.items as Array<{ status: string }>).map((item) => item.status).sort();
  expect(statuses).toEqual(["CLASSIFICADA", "CLASSIFICADA", "CLASSIFICADA", "JA_REGISTRADO", "VINCULADA"]);
});
