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

it("serializa pedido e cancelamento concorrentes com replay sem efeitos duplicados", async () => {
  const { url, key } = local();
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const token = (await login.json() as { access_token?: string }).access_token;
  expect(login.ok && token).toBeTruthy();
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function rpc(name: string, input: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(input) });
    const data = await response.json() as Record<string, unknown>;
    return { status: response.status, data };
  }
  const supplier = await rpc("save_supplier", { p_supplier_id: null, p_expected_revision: null,
    p_name: `Fornecedor corrida ${randomUUID()}`, p_contact_name: "Equipe", p_email: null, p_phone: null,
    p_document: null, p_notes: null, p_active: true, p_reason: "Teste concorrente",
    p_idempotency_key: `race-supplier:${randomUUID()}`, p_correlation_id: randomUUID() });
  expect(supplier.status).toBe(200);
  const payload = { p_supplier_id: supplier.data.id, p_ordered_on: "2026-09-18", p_expected_on: null,
    p_freight_cents: 50, p_other_cost_cents: 0, p_payment_method: "PIX após entrega",
    p_proof_reference: null, p_notes: null,
    p_items: [{ productId: "33000000-0000-4000-8000-000000000001", quantity: 2, unitCostCents: 625 }],
    p_reason: "Pedido sob concorrência", p_idempotency_key: `race-order:${randomUUID()}` };
  const [first, second] = await Promise.all([rpc("create_purchase_order", { ...payload, p_correlation_id: randomUUID() }), rpc("create_purchase_order", { ...payload, p_correlation_id: randomUUID() })]);
  expect([first.status, second.status]).toEqual([200, 200]);
  expect(first.data).toEqual(second.data);
  expect(first.data.totalCents).toBe(1300);
  const orderId = first.data.id;
  if (typeof orderId !== "string") throw new Error("Pedido sem identificador");
  const cancelKey = `race-cancel:${randomUUID()}`;
  const [cancel1, cancel2] = await Promise.all([
    rpc("cancel_purchase_order", { p_order_id: orderId, p_reason: "Pedido substituído", p_idempotency_key: cancelKey, p_correlation_id: randomUUID() }),
    rpc("cancel_purchase_order", { p_order_id: orderId, p_reason: "Pedido substituído", p_idempotency_key: cancelKey, p_correlation_id: randomUUID() }),
  ]);
  expect([cancel1.status, cancel2.status]).toEqual([200, 200]);
  expect(cancel1.data).toEqual(cancel2.data);
  const orders = await fetch(`${url}/rest/v1/purchase_orders?select=id,status,total_cents&id=eq.${orderId}`, { headers });
  expect(orders.ok).toBe(true);
  expect((await orders.json() as Array<{ id: string; status: string; total_cents: number }>)).toEqual([{ status: "CANCELLED", total_cents: 1300, id: orderId }]);
  const items = await fetch(`${url}/rest/v1/purchase_order_items?select=id&order_id=eq.${orderId}`, { headers });
  expect(items.ok).toBe(true);
  expect((await items.json() as unknown[])).toHaveLength(1);
});
