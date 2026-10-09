import { describe, expect, it } from "vitest";
import { cohortHeaders, parseCohortSelection, requestedCohort, selectionAccepted } from "./cohort-context";

const cohortA = "c0000000-0000-4000-8000-000000002026";
const carrier = (header: string | null, cookie?: string) => ({
  headers: { get: (name: string) => (name === "x-germinatura-cohort" ? header : null) },
  cookies: { get: (name: string) => (name === "germinatura_cohort" && cookie !== undefined ? { value: cookie } : undefined) },
});

describe("Portal cohort context", () => {
  it("accepts a cohort id or all, and nothing else", () => {
    expect(parseCohortSelection(` ${cohortA.toUpperCase()} `)).toBe(cohortA);
    expect(parseCohortSelection("ALL")).toBe("all");
    for (const value of ["", "todas", "2026", `${cohortA}x`, null, undefined]) expect(parseCohortSelection(value)).toBeNull();
  });

  it("takes the header over the cookie and reports where a malformed value came from", () => {
    expect(requestedCohort(carrier(cohortA, "all"))).toEqual({ kind: "selected", value: cohortA, source: "header" });
    expect(requestedCohort(carrier(null, "all"))).toEqual({ kind: "selected", value: "all", source: "cookie" });
    expect(requestedCohort(carrier("nope", cohortA))).toEqual({ kind: "invalid", source: "header" });
    expect(requestedCohort(carrier(null, "nope"))).toEqual({ kind: "invalid", source: "cookie" });
    expect(requestedCohort(carrier(null))).toEqual({ kind: "none" });
  });

  it("counts a selection as accepted only when the database resolved exactly it", () => {
    expect(selectionAccepted(cohortA, { cohortMode: "COHORT", cohort: { id: cohortA } })).toBe(true);
    expect(selectionAccepted(cohortA, { cohortMode: "NONE", cohort: null })).toBe(false);
    expect(selectionAccepted(cohortA, { cohortMode: "COHORT", cohort: { id: "c0000000-0000-4000-8000-00000000b027" } })).toBe(false);
    expect(selectionAccepted("all", { cohortMode: "ALL", cohort: null })).toBe(true);
    expect(selectionAccepted("all", { cohortMode: "COHORT", cohort: { id: cohortA } })).toBe(false);
  });

  it("sends the selection to the database only when there is one", () => {
    expect(cohortHeaders(cohortA)).toEqual({ "x-germinatura-cohort": cohortA });
    expect(cohortHeaders(null)).toEqual({});
  });
});
