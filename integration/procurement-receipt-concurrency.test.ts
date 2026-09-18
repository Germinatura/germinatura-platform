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

it("serializa a última unidade recebida e não duplica estoque ou obrigação em replay", async () => {
  const { url, key } = local();
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const token = (await login.json() as { access_token?: string }).access_token;
  expect(login.ok && token).toBeTruthy();
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function rpc(name: string, input: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(input) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
  const supplier = await rpc("save_supplier", { p_supplier_id: null, p_expected_revision: null,
    p_name: `Fornecedor recebimento ${randomUUID()}`, p_contact_name: "Equipe", p_email: null, p_phone: null,
    p_document: null, p_notes: null, p_active: true, p_reason: "Teste concorrente",
    p_idempotency_key: `race-supplier:${randomUUID()}`, p_correlation_id: randomUUID() });
  expect(supplier.status).toBe(200);
  const order = await rpc("create_purchase_order", { p_supplier_id: supplier.data.id,
    p_ordered_on: "2026-09-18", p_expected_on: null, p_freight_cents: 1, p_other_cost_cents: 0,
    p_payment_method: "PIX após entrega", p_proof_reference: null, p_notes: null,
    p_items: [{ productId: "33000000-0000-4000-8000-000000000001", quantity: 1, unitCostCents: 100 }],
    p_reason: "Pedido concorrente", p_idempotency_key: `race-order:${randomUUID()}`, p_correlation_id: randomUUID() });
  expect(order.status).toBe(200);
  const orderId = order.data.id;
  if (typeof orderId !== "string") throw new Error("Pedido sem identificador");
  const itemsResponse = await fetch(`${url}/rest/v1/purchase_order_items?select=id&order_id=eq.${orderId}`, { headers });
  expect(itemsResponse.ok).toBe(true);
  const items = await itemsResponse.json() as Array<{ id: string }>;
  const payload = { p_order_id: orderId, p_order_item_id: items[0]?.id, p_quantity: 1,
    p_received_on: "2026-09-18", p_lot_code: "RACE-LOT", p_manufactured_on: null, p_expires_on: null,
    p_reason: "Entrega conferida" };
  const firstKey = `race-receipt:${randomUUID()}`;
  const secondKey = `race-receipt:${randomUUID()}`;
  const [first, second] = await Promise.all([
    rpc("receive_purchase_order_item", { ...payload, p_idempotency_key: firstKey, p_correlation_id: randomUUID() }),
    rpc("receive_purchase_order_item", { ...payload, p_idempotency_key: secondKey, p_correlation_id: randomUUID() }),
  ]);
  expect([first.status, second.status].sort()).toEqual([200, 400]);
  const successful = first.status === 200 ? first : second;
  expect(successful.data.totalCostCents).toBe(101);
  const receiptId = successful.data.id;
  if (typeof receiptId !== "string") throw new Error("Recebimento sem identificador");
  const receipts = await fetch(`${url}/rest/v1/purchase_receipts?select=id,quantity,total_cost_cents&order_id=eq.${orderId}`, { headers });
  expect(await receipts.json()).toEqual([{ id: receiptId, quantity: 1, total_cost_cents: 101 }]);
  const payable = await fetch(`${url}/rest/v1/purchase_payable_entries?select=amount_cents&receipt_id=eq.${receiptId}`, { headers });
  expect(await payable.json()).toEqual([{ amount_cents: 101 }]);
  const replay = await rpc("receive_purchase_order_item", { ...payload, p_idempotency_key: first.status === 200 ? firstKey : secondKey, p_correlation_id: randomUUID() });
  expect(replay.status).toBe(200);
  expect(replay.data).toEqual(successful.data);
});
