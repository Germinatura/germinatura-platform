import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

const SOURCE_LOCATION_ID = "50000000-0000-4000-8000-000000000002";
const DESTINATION_LOCATION_ID = "50000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "33000000-0000-4000-8000-000000000001";

type Config = { apiUrl: string; publishableKey: string };
type Outcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
type Balance = { on_hand_quantity: number; reserved_quantity: number; available_quantity: number };

function config(): Config {
  const output = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const apiUrl = output.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const publishableKey = output.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!apiUrl || !publishableKey || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) throw new Error("Supabase local indisponível.");
  return { apiUrl, publishableKey };
}

async function login(local: Config, email: string, password: string) {
  const response = await fetch(`${local.apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: local.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json() as { access_token?: string; message?: string };
  if (!response.ok || !body.access_token) throw new Error(body.message ?? "Falha de autenticação");
  return body.access_token;
}

async function rpc(local: Config, token: string, name: string, parameters: Record<string, unknown>): Promise<Outcome> {
  const response = await fetch(`${local.apiUrl}/rest/v1/rpc/${name}`, {
    method: "POST", headers: { apikey: local.publishableKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(parameters),
  });
  const body = await response.json() as Record<string, unknown>;
  return response.ok ? { ok: true, data: body } : {
    ok: false,
    error: typeof body.message === "string" ? body.message : String(response.status),
  };
}

async function balance(local: Config, token: string, locationId: string): Promise<Balance> {
  const response = await fetch(`${local.apiUrl}/rest/v1/inventory_balances?select=on_hand_quantity,reserved_quantity,available_quantity&location_id=eq.${locationId}&product_id=eq.${PRODUCT_ID}`, {
    headers: { apikey: local.publishableKey, Authorization: `Bearer ${token}` },
  });
  const rows = await response.json() as Balance[];
  if (!response.ok) throw new Error("Falha ao consultar saldo");
  return rows[0] ?? { on_hand_quantity: 0, reserved_quantity: 0, available_quantity: 0 };
}

async function adjustTo(local: Config, admin: string, locationId: string, target: number) {
  const current = await balance(local, admin, locationId);
  expect(current.reserved_quantity).toBe(0);
  if (current.on_hand_quantity === target) return;
  expect(await rpc(local, admin, "adjust_stock", {
    p_location_id: locationId, p_product_id: PRODUCT_ID, p_quantity_delta: target - current.on_hand_quantity,
    p_reason: "Preparar corrida entre venda e devolução", p_idempotency_key: `stock-return-adjust:${randomUUID()}`,
    p_correlation_id: randomUUID(),
  })).toMatchObject({ ok: true });
}

it("serializa o recebimento da devolução contra a reserva da última unidade", async () => {
  const local = config();
  const [admin, sourceSeller] = await Promise.all([
    login(local, "admin.teste@institutojef.org.br", "Admin123!"),
    login(local, "vendedor.teste@institutojef.org.br", "Vendedor123!"),
  ]);
  const originalSource = await balance(local, admin, SOURCE_LOCATION_ID);
  const originalDestination = await balance(local, admin, DESTINATION_LOCATION_ID);
  expect(originalSource.reserved_quantity).toBe(0);
  expect(originalDestination.reserved_quantity).toBe(0);
  await adjustTo(local, admin, SOURCE_LOCATION_ID, 1);

  const requested = await rpc(local, sourceSeller, "request_stock_return", {
    p_product_id: PRODUCT_ID, p_quantity: 1,
    p_reason: "Última unidade para venda concorrente", p_idempotency_key: `stock-return-request:${randomUUID()}`,
    p_correlation_id: randomUUID(),
  });
  expect(requested).toMatchObject({ ok: true });
  const requestId = String((requested as Extract<Outcome, { ok: true }>).data.request_id);
  const reservationOrigin = `stock-return-race:${randomUUID()}`;

  const raced = await Promise.all([
    rpc(local, admin, "resolve_stock_return", {
      p_request_id: requestId, p_action: "RECEIVE", p_reason: "Quantidade e integridade conferidas",
      p_idempotency_key: `stock-return-accept:${randomUUID()}`, p_correlation_id: randomUUID(),
    }),
    rpc(local, admin, "reserve_stock", {
      p_location_id: SOURCE_LOCATION_ID, p_items: [{ product_id: PRODUCT_ID, quantity: 1 }],
      p_origin_type: "integration_test", p_origin_id: reservationOrigin,
      p_idempotency_key: `stock-return-reserve:${randomUUID()}`, p_correlation_id: randomUUID(),
    }),
  ]);
  expect(raced.filter((result) => result.ok)).toHaveLength(1);
  expect(raced.filter((result) => !result.ok)).toEqual([{ ok: false, error: "STOCK_CONFLICT" }]);

  const winner = raced.find((result): result is Extract<Outcome, { ok: true }> => result.ok)!;
  if ("movement_id" in winner.data) {
    expect(await balance(local, admin, SOURCE_LOCATION_ID)).toMatchObject({ on_hand_quantity: 0, reserved_quantity: 0 });
    expect(await balance(local, admin, DESTINATION_LOCATION_ID)).toMatchObject({ on_hand_quantity: originalDestination.on_hand_quantity + 1 });
    expect(await rpc(local, admin, "reverse_stock_movement", {
      p_movement_id: winner.data.movement_id, p_reason: "Restaurar fixture após corrida de devolução",
      p_idempotency_key: `stock-return-reverse:${randomUUID()}`, p_correlation_id: randomUUID(),
    })).toMatchObject({ ok: true });
  } else {
    expect(await balance(local, admin, SOURCE_LOCATION_ID)).toMatchObject({ on_hand_quantity: 1, reserved_quantity: 1, available_quantity: 0 });
    expect(await rpc(local, admin, "release_stock_reservation", {
      p_reservation_id: winner.data.reservation_id,
      p_idempotency_key: `stock-return-release:${randomUUID()}`, p_correlation_id: randomUUID(),
    })).toMatchObject({ ok: true });
    expect(await rpc(local, sourceSeller, "resolve_stock_return", {
      p_request_id: requestId, p_action: "CANCEL", p_reason: "Reserva concorrente venceu a devolução",
      p_idempotency_key: `stock-return-cancel:${randomUUID()}`, p_correlation_id: randomUUID(),
    })).toMatchObject({ ok: true });
  }

  await adjustTo(local, admin, SOURCE_LOCATION_ID, originalSource.on_hand_quantity);
  expect(await balance(local, admin, SOURCE_LOCATION_ID)).toEqual(originalSource);
  expect(await balance(local, admin, DESTINATION_LOCATION_ID)).toEqual(originalDestination);
});
