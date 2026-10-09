import { describe, expect, it } from "vitest";
import { eligiblePdvCohorts, operatesPdvIn, parsePdvCohort, readPdvSession, withPdvCohort } from "./pdv-cohort";

const cohortA = "c0000000-0000-4000-8000-000000002026";
const cohortB = "c0000000-0000-4000-8000-00000000b027";
const cohortC = "c0000000-0000-4000-8000-00000000c028";
const option = (id: string, status = "ACTIVE") => ({ id, name: id.slice(-4), year: 2026, slug: id.slice(-4), status, is_default: id === cohortA });
const row = (overrides: Record<string, unknown> = {}) => ({ active: true, onboarding_completed: true, roles: ["VENDEDOR"], admin_master: false,
  cohort_mode: "COHORT", cohort: option(cohortA), cohorts: [option(cohortA), option(cohortB), option(cohortC, "ARCHIVED")], ...overrides });

describe("PDV cohort context", () => {
  it("accepts only a concrete cohort id", () => {
    expect(parsePdvCohort(` ${cohortA.toUpperCase()} `)).toBe(cohortA);
    for (const value of ["all", "ALL", "", null, undefined, `${cohortA};x`]) expect(parsePdvCohort(value)).toBeNull();
  });

  it("operates only in the resolved, open cohort with the PDV role", () => {
    expect(operatesPdvIn(readPdvSession(row()), cohortA)).toBe(true);
    expect(operatesPdvIn(readPdvSession(row()), cohortB)).toBe(false); // resolved elsewhere
    expect(operatesPdvIn(readPdvSession(row({ roles: ["CONSUMIDOR"] })), cohortA)).toBe(false);
    expect(operatesPdvIn(readPdvSession(row({ cohort_mode: "ALL", admin_master: true })), cohortA)).toBe(false);
    expect(operatesPdvIn(readPdvSession(row({ cohort: option(cohortC), cohorts: [option(cohortC, "ARCHIVED")], admin_master: true })), cohortC)).toBe(false);
    expect(operatesPdvIn(readPdvSession(row({ roles: [], admin_master: true })), cohortA)).toBe(true);
    expect(operatesPdvIn(readPdvSession(row({ active: false })), cohortA)).toBe(false);
    expect(operatesPdvIn(readPdvSession("garbage"), cohortA)).toBe(false);
  });

  it("lists as eligible only the cohorts the database confirms inside each one", async () => {
    const asked: (string | null)[] = [];
    const client = {
      rpc: () => {
        let cohort: string | null = null;
        const run = () => {
          asked.push(cohort);
          const data = cohort === cohortA ? row() : cohort === cohortB ? row({ cohort: option(cohortB), roles: ["CONSUMIDOR"] }) : null;
          return Promise.resolve({ data, error: null });
        };
        const query = { setHeader: (_name: string, value: string) => { cohort = value; return query; }, then: (resolve: (value: unknown) => unknown) => run().then(resolve) };
        return query;
      },
    };
    const base = readPdvSession(row())!;
    const eligible = await eligiblePdvCohorts(client as never, base);
    expect(eligible.map((cohort) => cohort.id)).toEqual([cohortA]);
    expect(asked.sort()).toEqual([cohortA, cohortB]); // never asks about the archived cohort
  });

  it("sets the chosen cohort or clears a previous one", () => {
    const calls: string[] = [];
    const response = { cookies: { set: (name: string, value: string) => calls.push(`set ${name}=${value}`), delete: (name: string) => calls.push(`delete ${name}`) } };
    withPdvCohort(response, cohortA);
    withPdvCohort(response, null);
    expect(calls).toEqual([`set germinatura_pdv_cohort=${cohortA}`, "delete germinatura_pdv_cohort"]);
  });
});
