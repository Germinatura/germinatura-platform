import { describe, expect, it } from "vitest";
import { cohortAdminFailure, describeOpenOperations } from "./cohort-admin";

const answer = async (error: unknown) => {
  const response = cohortAdminFailure(error, "request", "fallback");
  return { status: response.status, body: await response.json() as { code: string; message: string; details?: unknown } };
};

describe("cohort administration errors", () => {
  it("maps database codes exactly, even when one code contains another", async () => {
    expect(await answer({ message: "LAST_ADMIN_MASTER_REQUIRED" })).toMatchObject({ status: 409, body: { code: "LAST_ADMIN_MASTER_REQUIRED" } });
    expect(await answer({ message: "ADMIN_MASTER_REQUIRED" })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await answer({ message: "COHORT_FORBIDDEN" })).toMatchObject({ status: 503 });
  });

  it("names the open work that blocks deactivating a membership or archiving a cohort", async () => {
    const membership = await answer({ message: "MEMBERSHIP_HAS_OPEN_OPERATIONS", details: "OPEN_SHIFT,LAST_COHORT_ADMIN" });
    expect(membership).toMatchObject({ status: 409, body: { code: "MEMBERSHIP_HAS_OPEN_OPERATIONS", details: ["OPEN_SHIFT", "LAST_COHORT_ADMIN"] } });
    expect(membership.body.message).toContain("turno de caixa aberto; é o último ADMIN ativo da turma");
    expect((await answer({ message: "COHORT_HAS_OPEN_OPERATIONS", details: "OPEN_RAFFLES" })).body.message).toContain("rifas ativas ou pausadas");
    expect(describeOpenOperations("UNKNOWN_CODE")).toBe("UNKNOWN_CODE");
  });
});
