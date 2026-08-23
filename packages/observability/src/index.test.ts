import { describe, expect, it } from "vitest";
import { createRequestId, redactSensitiveContext } from "./index";

describe("log redaction", () => {
  it("redacts sensitive keys recursively", () => {
    expect(redactSensitiveContext({
      request_id: "request-1",
      password: "secret-value",
      nested: { refreshToken: "token-value", amount: 10 },
    })).toEqual({
      request_id: "request-1",
      password: "[REDACTED]",
      nested: { refreshToken: "[REDACTED]", amount: 10 },
    });
  });

  it("redacts bearer credentials embedded in messages", () => {
    expect(redactSensitiveContext({ message: "request used Bearer token-value" })).toEqual({
      message: "request used Bearer [REDACTED]",
    });
  });
});

describe("request correlation", () => {
  it("preserves a bounded safe request id", () => {
    expect(createRequestId(new Headers({ "x-request-id": "request-1234" }))).toBe("request-1234");
  });

  it("replaces malformed request ids", () => {
    expect(createRequestId(new Headers({ "x-request-id": "bad id" }))).toMatch(/^[0-9a-f-]{36}$/);
  });
});
