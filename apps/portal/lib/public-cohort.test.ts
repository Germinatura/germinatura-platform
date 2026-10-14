import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/public", () => ({ createPublicSupabaseClient: () => ({ rpc }) }));
const { resolvePublicCohort } = await import("@/lib/public-cohort");

const thirtyTwo = `a${"b".repeat(30)}c`;
const cohort = { id: "c0000000-0000-4000-8000-000000002027", name: "Turma 2027", year: 2027, slug: thirtyTwo, is_default: false };

describe("public ?turma=<slug> (ADR 0011)", () => {
  beforeEach(() => { rpc.mockReset(); });

  it("looks up a 32-character slug", async () => {
    rpc.mockResolvedValueOnce({ data: cohort, error: null });
    expect(await resolvePublicCohort(thirtyTwo)).toEqual(cohort);
    expect(rpc).toHaveBeenCalledWith("resolve_public_cohort", { p_slug: thirtyTwo });
  });

  it("never looks up a 33-character or malformed slug", async () => {
    for (const slug of [`${thirtyTwo}d`, "", "-2027", "2027-", "Turma-2027", "turma_2027", "../2026", "c0000000-0000-4000-8000-000000002026x"]) {
      expect(await resolvePublicCohort(slug), slug).toBeNull();
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an archived (or unknown) cohort resolves to nothing, never to the default cohort", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await resolvePublicCohort("turma-arquivada")).toBeNull();
  });
});
