import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const CENTRAL_LOCATION_ID = "50000000-0000-4000-8000-000000000001";
const SELLER_LOCATION_ID = "50000000-0000-4000-8000-000000000002";
const PRODUCT_ID = "33000000-0000-4000-8000-000000000001";
const ADMIN_ID = "10000000-0000-4000-8000-000000000001";

type SupabaseConfig = {
  apiUrl: string;
  publishableKey: string;
};

type RpcOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

type Balance = {
  on_hand_quantity: number;
  reserved_quantity: number;
  available_quantity: number;
};

function localSupabaseConfig(): SupabaseConfig {
  let apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!apiUrl || !publishableKey) {
    const status = execFileSync(
      process.execPath,
      ["tools/run-supabase.mjs", "status", "-o", "env"],
      { encoding: "utf8" },
    );
    apiUrl ??= status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
    publishableKey ??= status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  }

  if (!apiUrl || !publishableKey || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) {
    throw new Error("Supabase local indisponivel; inicie o ambiente antes do teste de integracao.");
  }

  return { apiUrl, publishableKey };
}

async function adminAccessToken(config: SupabaseConfig): Promise<string> {
  const response = await fetch(`${config.apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: config.publishableKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "admin@germinatura.test", password: "Admin123!" }),
  });
  const body = (await response.json()) as { access_token?: string; message?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(`Falha ao autenticar fixture administrativa: ${body.message ?? response.status}`);
  }
  return body.access_token;
}

function authenticatedHeaders(config: SupabaseConfig, accessToken: string): Record<string, string> {
  return {
    apikey: config.publishableKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

async function rpc(
  config: SupabaseConfig,
  accessToken: string,
  functionName: string,
  parameters: Record<string, unknown>,
): Promise<RpcOutcome> {
  const response = await fetch(`${config.apiUrl}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: authenticatedHeaders(config, accessToken),
    body: JSON.stringify(parameters),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      error: typeof body.message === "string" ? body.message : String(response.status),
    };
  }
  return { ok: true, data: body };
}

async function selectRows<T>(
  config: SupabaseConfig,
  accessToken: string,
  path: string,
): Promise<T[]> {
  const response = await fetch(`${config.apiUrl}/rest/v1/${path}`, {
    headers: authenticatedHeaders(config, accessToken),
  });
  const body = (await response.json()) as T[] | { message?: string };
  if (!response.ok || !Array.isArray(body)) {
    throw new Error(`Falha ao consultar estado concorrente: ${"message" in body ? body.message : response.status}`);
  }
  return body;
}

async function balance(
  config: SupabaseConfig,
  accessToken: string,
  locationId: string,
): Promise<Balance> {
  const rows = await selectRows<Balance>(
    config,
    accessToken,
    `inventory_balances?select=on_hand_quantity,reserved_quantity,available_quantity&location_id=eq.${locationId}&product_id=eq.${PRODUCT_ID}`,
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function balanceOrZero(
  config: SupabaseConfig,
  accessToken: string,
  locationId: string,
): Promise<Balance> {
  const rows = await selectRows<Balance>(
    config,
    accessToken,
    `inventory_balances?select=on_hand_quantity,reserved_quantity,available_quantity&location_id=eq.${locationId}&product_id=eq.${PRODUCT_ID}`,
  );
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? { on_hand_quantity: 0, reserved_quantity: 0, available_quantity: 0 };
}

async function adjustTo(
  config: SupabaseConfig,
  accessToken: string,
  locationId: string,
  target: number,
): Promise<void> {
  const current = await balance(config, accessToken, locationId);
  expect(current.reserved_quantity).toBe(0);
  const delta = target - current.on_hand_quantity;
  if (delta === 0) return;

  const result = await rpc(config, accessToken, "adjust_stock", {
    p_location_id: locationId,
    p_product_id: PRODUCT_ID,
    p_quantity_delta: delta,
    p_reason: "Preparacao isolada do teste concorrente",
    p_idempotency_key: `integration-adjust-${randomUUID()}`,
    p_correlation_id: randomUUID(),
  });
  expect(result).toMatchObject({ ok: true });
}

function reservationParameters(key: string, originId: string): Record<string, unknown> {
  return {
    p_location_id: CENTRAL_LOCATION_ID,
    p_items: [{ product_id: PRODUCT_ID, quantity: 1 }],
    p_origin_type: "integration_test",
    p_origin_id: originId,
    p_idempotency_key: key,
    p_correlation_id: randomUUID(),
  };
}

async function releaseReservation(
  config: SupabaseConfig,
  accessToken: string,
  reservationId: string,
): Promise<void> {
  const result = await rpc(config, accessToken, "release_stock_reservation", {
    p_reservation_id: reservationId,
    p_idempotency_key: `integration-release-${randomUUID()}`,
    p_correlation_id: randomUUID(),
  });
  expect(result).toMatchObject({ ok: true });
}

describe("concorrencia real de reservas", () => {
  it("protege a ultima unidade, o replay e a corrida com transferencia", async () => {
    const config = localSupabaseConfig();
    const accessToken = await adminAccessToken(config);
    const tokenPayload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"),
    ) as { sub?: string };
    expect(tokenPayload.sub).toBe(ADMIN_ID);
    const session = await rpc(config, accessToken, "get_my_session", {});
    expect(session).toMatchObject({ ok: true, data: { auth_id: ADMIN_ID, roles: ["ADMIN"] } });
    await adjustTo(config, accessToken, CENTRAL_LOCATION_ID, 1);

    const differentKeyOrigin = `different-${randomUUID()}`;
    const differentKeyResults = await Promise.all([
      rpc(config, accessToken, "reserve_stock", reservationParameters(`integration-reserve-${randomUUID()}`, differentKeyOrigin)),
      rpc(config, accessToken, "reserve_stock", reservationParameters(`integration-reserve-${randomUUID()}`, differentKeyOrigin)),
    ]);
    const differentKeyWinners = differentKeyResults.filter((result) => result.ok);
    const differentKeyLosers = differentKeyResults.filter((result) => !result.ok);
    expect(differentKeyWinners).toHaveLength(1);
    expect(differentKeyLosers).toEqual([{ ok: false, error: "STOCK_CONFLICT" }]);
    expect(await balance(config, accessToken, CENTRAL_LOCATION_ID)).toEqual({
      on_hand_quantity: 1,
      reserved_quantity: 1,
      available_quantity: 0,
    });
    await releaseReservation(
      config,
      accessToken,
      String(differentKeyWinners[0].data.reservation_id),
    );

    const sameKey = `integration-reserve-${randomUUID()}`;
    const sameKeyOrigin = `same-${randomUUID()}`;
    const sameKeyResults = await Promise.all([
      rpc(config, accessToken, "reserve_stock", reservationParameters(sameKey, sameKeyOrigin)),
      rpc(config, accessToken, "reserve_stock", reservationParameters(sameKey, sameKeyOrigin)),
    ]);
    expect(sameKeyResults.every((result) => result.ok)).toBe(true);
    const sameKeyIds = sameKeyResults.map((result) =>
      String((result as Extract<RpcOutcome, { ok: true }>).data.reservation_id),
    );
    expect(new Set(sameKeyIds).size).toBe(1);

    const reservations = await selectRows<{ id: string }>(
      config,
      accessToken,
      `stock_reservations?select=id&origin_type=eq.integration_test&origin_id=eq.${sameKeyOrigin}`,
    );
    expect(reservations).toEqual([{ id: sameKeyIds[0] }]);
    const movements = await selectRows<{ id: string }>(
      config,
      accessToken,
      `stock_movements?select=id&movement_type=eq.RESERVA&source_type=eq.stock_reservation&source_id=eq.${sameKeyIds[0]}`,
    );
    expect(movements).toHaveLength(1);
    await releaseReservation(config, accessToken, sameKeyIds[0]);

    const raceOrigin = `race-${randomUUID()}`;
    const raceResults = await Promise.all([
      rpc(
        config,
        accessToken,
        "reserve_stock",
        reservationParameters(`integration-reserve-${randomUUID()}`, raceOrigin),
      ),
      rpc(config, accessToken, "transfer_stock", {
        p_from_location_id: CENTRAL_LOCATION_ID,
        p_to_location_id: SELLER_LOCATION_ID,
        p_product_id: PRODUCT_ID,
        p_quantity: 1,
        p_reason: "Corrida real entre reserva e transferencia",
        p_idempotency_key: `integration-transfer-${randomUUID()}`,
        p_correlation_id: randomUUID(),
      }),
    ]);
    const raceWinners = raceResults.filter((result) => result.ok);
    const raceLosers = raceResults.filter((result) => !result.ok);
    expect(raceWinners).toHaveLength(1);
    expect(raceLosers).toEqual([{ ok: false, error: "STOCK_CONFLICT" }]);

    const winner = raceWinners[0];
    if ("reservation_id" in winner.data) {
      expect(await balance(config, accessToken, CENTRAL_LOCATION_ID)).toEqual({
        on_hand_quantity: 1,
        reserved_quantity: 1,
        available_quantity: 0,
      });
      await releaseReservation(config, accessToken, String(winner.data.reservation_id));
    } else {
      expect(await balance(config, accessToken, CENTRAL_LOCATION_ID)).toEqual({
        on_hand_quantity: 0,
        reserved_quantity: 0,
        available_quantity: 0,
      });
      const reversal = await rpc(config, accessToken, "reverse_stock_movement", {
        p_movement_id: winner.data.movement_id,
        p_reason: "Restauracao do fixture apos teste concorrente",
        p_idempotency_key: `integration-reverse-${randomUUID()}`,
        p_correlation_id: randomUUID(),
      });
      expect(reversal).toMatchObject({ ok: true });
    }

    expect(await balance(config, accessToken, CENTRAL_LOCATION_ID)).toEqual({
      on_hand_quantity: 1,
      reserved_quantity: 0,
      available_quantity: 1,
    });
    expect(await balanceOrZero(config, accessToken, SELLER_LOCATION_ID)).toEqual({
      on_hand_quantity: 0,
      reserved_quantity: 0,
      available_quantity: 0,
    });
  });
});
