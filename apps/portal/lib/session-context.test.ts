import { describe, expect, it } from "vitest";
import { createSessionContext, forwardSessionContext, readSessionContext, SESSION_CONTEXT_HEADER } from "./session-context";

const session = { user: { id: "10000000-0000-4000-8000-000000000003", authId: "10000000-0000-4000-8000-000000000003", email: "c@institutojef.org.br",
  perfil: "CONSUMIDOR" as const, nome: "Consumidor", username: "consumidor", avatarPath: null, roles: ["CONSUMIDOR" as const], active: true as const,
  onboardingCompleted: true, needsPasswordReset: false as const } };

describe("session context", () => {
  it("round-trips for the same token within its lifetime", async () => {
    const value = await createSessionContext(session, "token-a");
    await expect(readSessionContext(value, "token-a")).resolves.toEqual(session);
  });

  it("is bound to the token it was made for", async () => {
    await expect(readSessionContext(await createSessionContext(session, "token-a"), "token-b")).resolves.toBeNull();
  });

  it("expires, and refuses a lifetime longer than the proxy grants", async () => {
    const now = Date.now();
    await expect(readSessionContext(await createSessionContext(session, "token-a", now - 31_000), "token-a", now)).resolves.toBeNull();
    await expect(readSessionContext(await createSessionContext(session, "token-a", now + 60_000), "token-a", now)).resolves.toBeNull();
  });

  it("refuses any change to the payload or the signature", async () => {
    const [payload, signature] = (await createSessionContext(session, "token-a")).split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as { s: typeof session };
    decoded.s.user.roles = ["ADMIN" as never];
    const altered = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
    const flipped = `${payload}.${signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`}`;
    for (const value of [altered, flipped, `${payload}.`, payload, `${payload}.${signature}.extra`, "", "x".repeat(9000)]) {
      await expect(readSessionContext(value, "token-a")).resolves.toBeNull();
    }
  });

  it("always drops the client's value before forwarding", () => {
    const incoming = new Headers({ [SESSION_CONTEXT_HEADER]: "from-the-client", authorization: "Bearer t" });
    expect(forwardSessionContext(incoming, null).has(SESSION_CONTEXT_HEADER)).toBe(false);
    expect(forwardSessionContext(incoming, "signed").get(SESSION_CONTEXT_HEADER)).toBe("signed");
    expect(forwardSessionContext(incoming, null).get("authorization")).toBe("Bearer t");
  });
});
