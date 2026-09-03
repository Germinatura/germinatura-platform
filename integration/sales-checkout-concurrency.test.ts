import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const CENTRAL_LOCATION_ID = "50000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "33f00000-0000-4000-8000-000000000001";

type Config = { apiUrl: string; publishableKey: string };
type Outcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

function config(): Config {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], {
    encoding: "utf8",
  });
  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    ?? status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!apiUrl || !publishableKey || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) {
    throw new Error("Supabase local indisponivel para o teste de checkout.");
  }
  return { apiUrl, publishableKey };
}

async function token(current: Config): Promise<string> {
  const response = await fetch(`${current.apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: current.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }),
  });
  const body = await response.json() as { access_token?: string };
  if (!response.ok || !body.access_token) throw new Error("Falha ao autenticar fixture administrativa.");
  return body.access_token;
}

function headers(current: Config, accessToken: string): Record<string, string> {
  return {
    apikey: current.publishableKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

async function rpc(
  current: Config,
  accessToken: string,
  name: string,
  parameters: Record<string, unknown>,
): Promise<Outcome> {
  const response = await fetch(`${current.apiUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: headers(current, accessToken),
    body: JSON.stringify(parameters),
  });
  const body = await response.json() as Record<string, unknown>;
  return response.ok
    ? { ok: true, data: body }
    : { ok: false, error: typeof body.message === "string" ? body.message : String(response.status) };
}

async function rows<T>(current: Config, accessToken: string, path: string): Promise<T[]> {
  const response = await fetch(`${current.apiUrl}/rest/v1/${path}`, {
    headers: headers(current, accessToken),
  });
  const body = await response.json() as T[] | { message?: string };
  if (!response.ok || !Array.isArray(body)) throw new Error("Falha ao consultar checkout concorrente.");
  return body;
}

function checkoutParameters(key: string): Record<string, unknown> {
  return {
    p_channel: "PDV",
    p_location_id: CENTRAL_LOCATION_ID,
    p_items: [{ product_id: PRODUCT_ID, quantity: 1 }],
    p_idempotency_key: key,
    p_correlation_id: randomUUID(),
  };
}

async function setStock(current: Config, accessToken: string, target: number): Promise<void> {
  const [balance] = await rows<{ on_hand_quantity: number; reserved_quantity: number }>(
    current,
    accessToken,
    `inventory_balances?select=on_hand_quantity,reserved_quantity&location_id=eq.${CENTRAL_LOCATION_ID}&product_id=eq.${PRODUCT_ID}`,
  );
  expect(balance.reserved_quantity).toBe(0);
  const delta = target - balance.on_hand_quantity;
  if (delta === 0) return;
  expect(await rpc(current, accessToken, "adjust_stock", {
    p_location_id: CENTRAL_LOCATION_ID,
    p_product_id: PRODUCT_ID,
    p_quantity_delta: delta,
    p_reason: "Preparacao do checkout concorrente",
    p_idempotency_key: `checkout-adjust-${randomUUID()}`,
    p_correlation_id: randomUUID(),
  })).toMatchObject({ ok: true });
}

async function cancel(current: Config, accessToken: string, saleId: string): Promise<void> {
  expect(await rpc(current, accessToken, "cancel_sale", {
    p_sale_id: saleId,
    p_idempotency_key: `checkout-release-${randomUUID()}`,
    p_correlation_id: randomUUID(),
  })).toMatchObject({ ok: true });
}

describe("checkout transacional real", () => {
  it("tem um vencedor na ultima unidade e deduplica o duplo Cobrar", async () => {
    const current = config();
    const accessToken = await token(current);
    await setStock(current, accessToken, 1);

    const race = await Promise.all([
      rpc(current, accessToken, "checkout_sale", checkoutParameters(`checkout-race-${randomUUID()}`)),
      rpc(current, accessToken, "checkout_sale", checkoutParameters(`checkout-race-${randomUUID()}`)),
    ]);
    expect(race.filter((result) => result.ok)).toHaveLength(1);
    expect(race.filter((result) => !result.ok)).toEqual([{ ok: false, error: "STOCK_CONFLICT" }]);
    const winner = race.find((result): result is Extract<Outcome, { ok: true }> => result.ok)!;
    const winnerSaleId = String(winner.data.sale_id);
    expect(await rows<{ id: string }>(current, accessToken, `sales?select=id&id=eq.${winnerSaleId}`))
      .toEqual([{ id: winnerSaleId }]);
    expect(await rows<{ id: string }>(current, accessToken, `payment_attempts?select=id&sale_id=eq.${winnerSaleId}`))
      .toHaveLength(1);
    await cancel(current, accessToken, winnerSaleId);

    const sameKey = `checkout-double-${randomUUID()}`;
    const duplicate = await Promise.all([
      rpc(current, accessToken, "checkout_sale", checkoutParameters(sameKey)),
      rpc(current, accessToken, "checkout_sale", checkoutParameters(sameKey)),
    ]);
    expect(duplicate.every((result) => result.ok)).toBe(true);
    const saleIds = duplicate.map((result) => String((result as Extract<Outcome, { ok: true }>).data.sale_id));
    expect(new Set(saleIds).size).toBe(1);
    const reservationIds = duplicate.map((result) => String(
      ((result as Extract<Outcome, { ok: true }>).data.reservation as { reservation_id: string }).reservation_id,
    ));
    expect(new Set(reservationIds).size).toBe(1);
    expect(await rows<{ id: string }>(current, accessToken, `payment_attempts?select=id&sale_id=eq.${saleIds[0]}`))
      .toHaveLength(1);
    await cancel(current, accessToken, saleIds[0]);
  });

  it("confirma manualmente uma unica vez sob duplo clique", async () => {
    const current = config();
    const accessToken = await token(current);
    await setStock(current, accessToken, 1);

    const checkout = await rpc(
      current,
      accessToken,
      "checkout_sale",
      checkoutParameters(`manual-confirm-checkout-${randomUUID()}`),
    );
    expect(checkout.ok).toBe(true);
    const saleId = String((checkout as Extract<Outcome, { ok: true }>).data.sale_id);
    const confirmationKey = `manual-confirm-${randomUUID()}`;
    const proofReference = `NSU-${randomUUID()}`;
    const confirmationParameters = () => ({
      p_sale_id: saleId,
      p_integration_channel: "MAQUININHA",
      p_proof_reference: proofReference,
      p_idempotency_key: confirmationKey,
      p_correlation_id: randomUUID(),
    });

    const confirmations = await Promise.all([
      rpc(current, accessToken, "confirm_manual_payment", confirmationParameters()),
      rpc(current, accessToken, "confirm_manual_payment", confirmationParameters()),
    ]);
    expect(confirmations.every((result) => result.ok)).toBe(true);
    const attemptIds = confirmations.map((result) => String(
      ((result as Extract<Outcome, { ok: true }>).data.payment_attempt as { attempt_id: string }).attempt_id,
    ));
    expect(new Set(attemptIds).size).toBe(1);
    expect(await rows<{ status: string }>(current, accessToken, `sales?select=status&id=eq.${saleId}`))
      .toEqual([{ status: "CONFIRMED" }]);
    expect(await rows<{ status: string }>(current, accessToken, `payment_attempts?select=status&sale_id=eq.${saleId}`))
      .toEqual([{ status: "APPROVED" }]);
    expect(await rows<{ id: string }>(current, accessToken, `financial_ledger_entries?select=id&sale_id=eq.${saleId}`))
      .toHaveLength(1);
    const reconciliationKey = `manual-reconciliation-${randomUUID()}`;
    const externalReference = `SETTLEMENT-${randomUUID()}`;
    const reconciliationParameters = () => ({
      p_attempt_id: attemptIds[0],
      p_observed_amount_cents: 2590,
      p_fee_amount_cents: 59,
      p_external_reference: externalReference,
      p_source: "MANUAL",
      p_idempotency_key: reconciliationKey,
      p_correlation_id: randomUUID(),
    });
    const reconciliations = await Promise.all([
      rpc(current, accessToken, "reconcile_payment_attempt", reconciliationParameters()),
      rpc(current, accessToken, "reconcile_payment_attempt", reconciliationParameters()),
    ]);
    expect(reconciliations.every((result) => result.ok)).toBe(true);
    expect(new Set(reconciliations.map((result) => String(
      (result as Extract<Outcome, { ok: true }>).data.reconciliation_id,
    ))).size).toBe(1);
    expect(await rows<{ status: string }>(current, accessToken, `payment_attempts?select=status&id=eq.${attemptIds[0]}`))
      .toEqual([{ status: "RECONCILED" }]);
    expect(await rows<{ id: string }>(current, accessToken, `payment_reconciliations?select=id&payment_attempt_id=eq.${attemptIds[0]}`))
      .toHaveLength(1);
    expect(await rows<{ id: string }>(current, accessToken, `financial_ledger_entries?select=id&sale_id=eq.${saleId}`))
      .toHaveLength(3);
    const reversalKey = `confirmed-reversal-${randomUUID()}`;
    const refundReference = `REFUND-${randomUUID()}`;
    const reversalParameters = () => ({
      p_sale_id: saleId,
      p_reason: "Cliente solicitou estorno integral",
      p_refund_reference: refundReference,
      p_idempotency_key: reversalKey,
      p_correlation_id: randomUUID(),
    });
    const reversals = await Promise.all([
      rpc(current, accessToken, "reverse_confirmed_sale", reversalParameters()),
      rpc(current, accessToken, "reverse_confirmed_sale", reversalParameters()),
    ]);
    expect(reversals.every((result) => result.ok)).toBe(true);
    expect(new Set(reversals.map((result) => String(
      ((result as Extract<Outcome, { ok: true }>).data.reversal as { refund_entry_id: string }).refund_entry_id,
    ))).size).toBe(1);
    expect(await rows<{ status: string }>(current, accessToken, `sales?select=status&id=eq.${saleId}`))
      .toEqual([{ status: "CANCELLED" }]);
    expect(await rows<{ status: string }>(current, accessToken, `payment_attempts?select=status&id=eq.${attemptIds[0]}`))
      .toEqual([{ status: "REFUNDED" }]);
    expect(await rows<{ id: string }>(current, accessToken, `stock_movements?select=id&source_type=eq.sale_reversal&source_id=eq.${saleId}`))
      .toHaveLength(1);
    expect(await rows<{ id: string }>(current, accessToken, `financial_ledger_entries?select=id&sale_id=eq.${saleId}&entry_type=eq.REFUND`))
      .toHaveLength(1);
    const [balance] = await rows<{ on_hand_quantity: number; reserved_quantity: number }>(
      current,
      accessToken,
      `inventory_balances?select=on_hand_quantity,reserved_quantity&location_id=eq.${CENTRAL_LOCATION_ID}&product_id=eq.${PRODUCT_ID}`,
    );
    expect(balance).toEqual({ on_hand_quantity: 1, reserved_quantity: 0 });
  });
});
