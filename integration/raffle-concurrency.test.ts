import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

type Config = { apiUrl: string; publishableKey: string };
type Outcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
const PRODUCT_ID = "33f00000-0000-4000-8000-000000000001";
const LOCATION_ID = "50000000-0000-4000-8000-000000000001";

function config(): Config {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!apiUrl || !publishableKey || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) throw new Error("Supabase local indisponivel para o teste de rifa.");
  return { apiUrl, publishableKey };
}
async function token(current: Config): Promise<string> {
  const response = await fetch(`${current.apiUrl}/auth/v1/token?grant_type=password`, { method: "POST",
    headers: { apikey: current.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const body = await response.json() as { access_token?: string };
  if (!response.ok || !body.access_token) throw new Error("Falha ao autenticar fixture administrativa.");
  return body.access_token;
}
async function rpc(current: Config, accessToken: string, name: string, parameters: Record<string, unknown>): Promise<Outcome> {
  const response = await fetch(`${current.apiUrl}/rest/v1/rpc/${name}`, { method: "POST",
    headers: { apikey: current.publishableKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(parameters) });
  const body = await response.json() as Record<string, unknown>;
  return response.ok ? { ok: true, data: body } : { ok: false, error: typeof body.message === "string" ? body.message : String(response.status) };
}

describe("concorrencia real de rifas", () => {
  it("tem exatamente um vencedor para o mesmo numero e deduplica o duplo clique", async () => {
    const current = config(); const accessToken = await token(current);
    const campaign = await rpc(current, accessToken, "create_raffle_campaign", {
      p_name: `Rifa concorrente ${randomUUID()}`, p_product_id: PRODUCT_ID, p_location_id: LOCATION_ID,
      p_number_count: 10, p_starts_at: new Date(Date.now() - 60_000).toISOString(),
      p_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      p_idempotency_key: `raffle-campaign-${randomUUID()}`, p_correlation_id: randomUUID(),
    });
    expect(campaign.ok).toBe(true); const campaignId = String((campaign as Extract<Outcome, { ok: true }>).data.campaign_id);
    const parameters = (key: string) => ({ p_campaign_id: campaignId, p_numbers: [7],
      p_idempotency_key: key, p_correlation_id: randomUUID() });
    const race = await Promise.all([
      rpc(current, accessToken, "reserve_raffle_numbers", parameters(`raffle-race-${randomUUID()}`)),
      rpc(current, accessToken, "reserve_raffle_numbers", parameters(`raffle-race-${randomUUID()}`)),
    ]);
    expect(race.filter((result) => result.ok)).toHaveLength(1);
    expect(race.filter((result) => !result.ok)).toEqual([{ ok: false, error: "RAFFLE_NUMBER_CONFLICT" }]);
    const winner = race.find((result): result is Extract<Outcome, { ok: true }> => result.ok)!;
    await rpc(current, accessToken, "cancel_raffle_reservation", { p_sale_id: winner.data.sale_id,
      p_idempotency_key: `raffle-race-cancel-${randomUUID()}`, p_correlation_id: randomUUID() });

    const sameKey = `raffle-double-${randomUUID()}`;
    const duplicate = await Promise.all([
      rpc(current, accessToken, "reserve_raffle_numbers", parameters(sameKey)),
      rpc(current, accessToken, "reserve_raffle_numbers", parameters(sameKey)),
    ]);
    expect(duplicate.every((result) => result.ok)).toBe(true);
    expect(new Set(duplicate.map((result) => String((result as Extract<Outcome, { ok: true }>).data.sale_id))).size).toBe(1);
    expect(new Set(duplicate.map((result) => String((result as Extract<Outcome, { ok: true }>).data.payment_attempt_id))).size).toBe(1);
  });
});
