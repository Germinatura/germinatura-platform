import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

// H1: people receiving at the same time never get the same automatic lot code (the database reserves the number).
it("concurrent lot code reservations of the same product and day are all different and contiguous", async () => {
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
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function rpc<T>(name: string, body: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json() as T & { message?: string };
    if (!response.ok) throw new Error(`${name}: ${result.message ?? response.status}`);
    return result;
  }

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const supplier = await rpc<{ id: string }>("save_supplier", {
    p_supplier_id: null, p_expected_revision: null, p_name: `Fornecedor lote ${randomUUID().slice(0, 8)}`, p_contact_name: "Ana",
    p_email: null, p_phone: null, p_document: null, p_notes: null, p_active: true, p_reason: "Teste de concorrência de lote",
    p_idempotency_key: `lot-race-supplier:${randomUUID()}`, p_correlation_id: randomUUID(),
  });
  const order = await rpc<{ id: string; items: { id: string }[] }>("create_purchase_order", {
    p_supplier_id: supplier.id, p_ordered_on: today, p_expected_on: null, p_freight_cents: 0, p_other_cost_cents: 0,
    p_payment_method: "PIX", p_proof_reference: null, p_notes: null,
    p_items: [{ productId: "33f00000-0000-4000-8000-000000000001", quantity: 30, unitCostCents: 500 }],
    p_reason: "Teste de concorrência de lote", p_idempotency_key: `lot-race-order:${randomUUID()}`, p_correlation_id: randomUUID(),
  });
  const items = await fetch(`${url}/rest/v1/purchase_order_items?select=id&order_id=eq.${order.id}`, { headers });
  const [item] = await items.json() as Array<{ id: string }>;

  const reservations = await Promise.all(Array.from({ length: 12 }, () =>
    rpc<{ lot_code: string; sequence: number }>("reserve_purchase_lot_code", { p_order_item_id: item.id, p_received_on: today })));
  const codes = reservations.map((reservation) => reservation.lot_code);
  expect(new Set(codes).size).toBe(12);
  const sequences = reservations.map((reservation) => reservation.sequence).sort((left, right) => left - right);
  expect(sequences.at(-1)! - sequences[0]).toBe(11);
  for (const code of codes) expect(code).toMatch(/^IPU-\d{6}-\d{2,3}$/);
});
