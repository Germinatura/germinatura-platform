import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ AuthorizationError: class AuthorizationError extends Error { status = 403; } }));

const { financeHistoryDatabaseError } = await import("./finance-history");

describe("financeHistoryDatabaseError", () => {
  it("answers a missing opening position as a known domain state (409), never as an outage", async () => {
    const response = financeHistoryDatabaseError("OPENING_POSITION_REQUIRED", "req-1");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OPENING_POSITION_REQUIRED", request_id: "req-1" });
  });

  it("keeps unknown database failures as 503", async () => {
    const response = financeHistoryDatabaseError("connection reset", "req-2");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "FINANCE_UNAVAILABLE" });
  });
});
