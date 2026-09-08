import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

it("category edits have one revision winner and concurrent retries create one category", async () => {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Local Supabase required");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }),
  });
  expect(login.ok).toBe(true);
  const { access_token: token } = await login.json() as { access_token: string };
  if (typeof token !== "string" || !token) throw new Error("Local fixture authentication failed");
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function save(body: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/save_catalog_category`, { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json() as { id: string; revision: number; name: string; message: string };
    return response.ok
      ? { ok: true as const, value: { id: result.id, revision: result.revision, name: result.name } }
      : { ok: false as const, message: result.message };
  }
  const create = { p_category_id: null, p_expected_revision: null, p_name: "Categoria concorrente",
    p_slug: `race-${randomUUID()}`, p_active: false, p_sort_order: 0, p_reason: "Teste de concorrência",
    p_idempotency_key: `create:${randomUUID()}`, p_correlation_id: randomUUID() };
  const duplicated = await Promise.all([save(create), save({ ...create, p_correlation_id: randomUUID() })]);
  expect(duplicated.every((result) => result.ok)).toBe(true);
  const created = duplicated[0];
  if (!created.ok) throw new Error("Category creation failed");
  expect(duplicated[1]).toEqual(created);
  const update = { ...create, p_category_id: created.value.id, p_expected_revision: 1 };
  const race = await Promise.all([
    save({ ...update, p_name: "Edição A", p_idempotency_key: `edit:${randomUUID()}` }),
    save({ ...update, p_name: "Edição B", p_idempotency_key: `edit:${randomUUID()}` }),
  ]);
  expect(race.filter((result) => result.ok)).toHaveLength(1);
  expect(race.filter((result) => !result.ok)).toEqual([{ ok: false, message: "CATEGORY_REVISION_CONFLICT" }]);
  const winner = race.find((result) => result.ok);
  expect(winner?.ok && winner.value.revision).toBe(2);
});
