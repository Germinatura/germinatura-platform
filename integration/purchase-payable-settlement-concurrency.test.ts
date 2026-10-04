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

it("serializa a liquidação e a reversão concorrentes sem ultrapassar a obrigação", async () => {
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
    p_name: `Fornecedor liquidação ${randomUUID()}`, p_contact_name: "Equipe", p_email: null, p_phone: null,
    p_document: null, p_notes: null, p_active: true, p_reason: "Teste concorrente",
    p_idempotency_key: `payable-supplier:${randomUUID()}`, p_correlation_id: randomUUID() });
  const order = await rpc("create_purchase_order", { p_supplier_id: supplier.data.id,
    p_ordered_on: "2026-09-20", p_expected_on: null, p_freight_cents: 0, p_other_cost_cents: 0,
    p_payment_method: "PIX após entrega", p_proof_reference: null, p_notes: null,
    p_items: [{ productId: "33000000-0000-4000-8000-000000000001", quantity: 1, unitCostCents: 1000 }],
    p_reason: "Pedido concorrente", p_idempotency_key: `payable-order:${randomUUID()}`, p_correlation_id: randomUUID() });
  const orderId = order.data.id;
  if (typeof orderId !== "string") throw new Error("Pedido sem identificador");
  const itemsResponse = await fetch(`${url}/rest/v1/purchase_order_items?select=id&order_id=eq.${orderId}`, { headers });
  const items = await itemsResponse.json() as Array<{ id: string }>;
  const receipt = await rpc("receive_purchase_order_item", { p_order_id: orderId, p_order_item_id: items[0]?.id,
    p_quantity: 1, p_received_on: "2026-09-20", p_lot_code: "PAYABLE-RACE", p_manufactured_on: null,
    p_expires_on: null, p_reason: "Entrega conferida", p_idempotency_key: `payable-receipt:${randomUUID()}`,
    p_correlation_id: randomUUID() });
  const payableId = receipt.data.payableId;
  if (typeof payableId !== "string") throw new Error("Obrigação sem identificador");
  const payload = { p_payable_id: payableId, p_amount_cents: 1000, p_effective_on: "2026-09-20",
    p_payment_method: "PIX PicPay Empresas", p_reference: "RACE-PIX", p_reason: "Pagamento conferido" };
  const firstKey = `payable-race:${randomUUID()}`;
  const secondKey = `payable-race:${randomUUID()}`;
  const [first, second] = await Promise.all([
    rpc("settle_purchase_payable", { ...payload, p_idempotency_key: firstKey, p_correlation_id: randomUUID() }),
    rpc("settle_purchase_payable", { ...payload, p_idempotency_key: secondKey, p_correlation_id: randomUUID() }),
  ]);
  expect([first.status, second.status].sort()).toEqual([200, 400]);
  const successful = first.status === 200 ? first : second;
  expect(successful.data.remainingCents).toBe(0);
  const settlements = await fetch(`${url}/rest/v1/purchase_payable_settlements?select=id,entry_type,amount_cents&payable_id=eq.${payableId}`, { headers });
  const settlementRows = await settlements.json() as Array<{ id: string; entry_type: string; amount_cents: number }>;
  expect(settlementRows).toHaveLength(1);
  expect(settlementRows[0]).toMatchObject({ entry_type: "SETTLEMENT", amount_cents: 1000 });
  const replay = await rpc("settle_purchase_payable", { ...payload,
    p_idempotency_key: first.status === 200 ? firstKey : secondKey, p_correlation_id: randomUUID() });
  expect(replay.status).toBe(200);
  expect(replay.data).toEqual(successful.data);
  const settlementId = successful.data.id;
  if (typeof settlementId !== "string") throw new Error("Liquidação sem identificador");
  const reversalPayload = { p_settlement_id: settlementId, p_effective_on: "2026-09-20", p_reason: "Corrigir conta de pagamento" };
  const [reversal1, reversal2] = await Promise.all([
    rpc("reverse_purchase_payable_settlement", { ...reversalPayload, p_idempotency_key: `reversal:${randomUUID()}`, p_correlation_id: randomUUID() }),
    rpc("reverse_purchase_payable_settlement", { ...reversalPayload, p_idempotency_key: `reversal:${randomUUID()}`, p_correlation_id: randomUUID() }),
  ]);
  expect([reversal1.status, reversal2.status].sort()).toEqual([200, 400]);
  const balance = await fetch(`${url}/rest/v1/purchase_payable_balances?select=settled_cents,outstanding_cents,status&id=eq.${payableId}`, { headers });
  expect(await balance.json()).toEqual([{ settled_cents: 0, outstanding_cents: 1000, status: "PENDING" }]);
});
