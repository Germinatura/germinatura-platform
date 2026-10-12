import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

function localSupabase() {
  const status = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  const serviceKey = status.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !serviceKey || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Local Supabase required");
  return { url, key, serviceKey };
}

async function signIn(email: string, password: string) {
  const { url, key } = localSupabase();
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }) });
  const body = await response.json() as { access_token: string; user: { id: string } };
  return { token: body.access_token, id: body.user.id };
}

function asPerson(token: string) {
  const { url, key } = localSupabase();
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const read = async (id: string) => {
    const [identity, preferences] = await Promise.all([
      fetch(`${url}/rest/v1/profiles?select=display_name,username&id=eq.${id}`, { headers }).then((r) => r.json() as Promise<Array<{ display_name: string; username: string }>>),
      fetch(`${url}/rest/v1/profile_preferences?select=revision&profile_id=eq.${id}`, { headers }).then((r) => r.json() as Promise<Array<{ revision: number }>>),
    ]);
    return { name: identity[0].display_name, username: identity[0].username, revision: preferences[0]?.revision ?? 0 };
  };
  const save = async (id: string, username: string) => {
    const current = await read(id);
    const response = await fetch(`${url}/rest/v1/rpc/update_my_profile`, { method: "POST", headers, body: JSON.stringify({
      p_expected_revision: current.revision, p_display_name: current.name, p_username: username, p_avatar_path: null,
      p_bio: "", p_class_name: "", p_sweet_preferences: [], p_idempotency_key: `username-${randomUUID()}`, p_correlation_id: randomUUID() }) });
    return { status: response.status, body: await response.json() as { message?: string; username?: string } };
  };
  return { read, save };
}

// A2: two people asking for the same free username at the same moment. The unique index decides: exactly one keeps it,
// the other gets USERNAME_ALREADY_USED, and nobody ends up with a half-saved profile.
it("two people choosing the same free username at once: exactly one gets it", async () => {
  const seller = await signIn("vendedor.teste@institutojef.org.br", "Vendedor123!");
  const destination = await signIn("vendedor.destino@institutojef.org.br", "VendedorDestino123!");
  const sellerApi = asPerson(seller.token);
  const destinationApi = asPerson(destination.token);
  const originals = [await sellerApi.read(seller.id), await destinationApi.read(destination.id)];
  const wanted = `corrida.${randomUUID().slice(0, 8)}`;
  try {
    const results = await Promise.all([sellerApi.save(seller.id, wanted), destinationApi.save(destination.id, wanted)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.body.message).toBe("USERNAME_ALREADY_USED");
    const after = [await sellerApi.read(seller.id), await destinationApi.read(destination.id)];
    expect(after.filter((profile) => profile.username === wanted)).toHaveLength(1);
    expect(after.filter((profile) => profile.username !== wanted).map((profile) => profile.username))
      .toEqual(originals.filter((_, index) => after[index].username !== wanted).map((profile) => profile.username));
  } finally {
    expect((await sellerApi.save(seller.id, originals[0].username)).status).toBe(200);
    expect((await destinationApi.save(destination.id, originals[1].username)).status).toBe(200);
  }
});

// A2: the confirmed e-mail is not editable. The browser holds a Supabase session, so the attempt goes straight to Auth.
it("Auth refuses an e-mail change requested with the person's own session", async () => {
  const { url, key, serviceKey } = localSupabase();
  const consumer = await signIn("consumidor.teste@institutojef.org.br", "Consumidor123!");
  const attempt = await fetch(`${url}/auth/v1/user`, { method: "PUT",
    headers: { apikey: key, Authorization: `Bearer ${consumer.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: `outra.${randomUUID().slice(0, 8)}@institutojef.org.br` }) });
  expect(attempt.ok).toBe(false);
  const user = await fetch(`${url}/auth/v1/admin/users/${consumer.id}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } })
    .then((response) => response.json() as Promise<{ email: string; new_email?: string }>);
  expect(user.email).toBe("consumidor.teste@institutojef.org.br");
  expect(user.new_email ?? "").toBe("");
  // Signing in, which also updates the Auth user, keeps working.
  expect((await signIn("consumidor.teste@institutojef.org.br", "Consumidor123!")).id).toBe(consumer.id);
});
