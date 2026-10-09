import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COHORT_SLUG_HTML_PATTERN, COHORT_SLUG_MAX_LENGTH, COHORT_SLUG_PATTERN, cohortCreateRequestSchema, cohortSlugSchema, cohortUpdateRequestSchema } from "./index";

const create = (slug: unknown) => cohortCreateRequestSchema.safeParse({ name: "Turma 2027", year: 2027, slug, status: "PREPARING" });
const thirtyTwo = `a${"b".repeat(30)}c`;

describe("cohort slug: one rule for contract, API, form, database, public ?turma= and the PDV worker", () => {
  it("accepts up to 32 characters and refuses 33", () => {
    expect(thirtyTwo).toHaveLength(COHORT_SLUG_MAX_LENGTH);
    expect(create(thirtyTwo).success).toBe(true);
    expect(cohortSlugSchema.safeParse(thirtyTwo).success).toBe(true);
    expect(create(`${thirtyTwo}d`).success).toBe(false);
    expect(cohortSlugSchema.safeParse(`${thirtyTwo}d`).success).toBe(false);
    expect(create("a").success).toBe(true);
  });

  it("refuses an invalid format", () => {
    for (const slug of ["", "-2027", "2027-", "turma_2027", "turma 2027", "turma.2027", "turmação", "../2026", "all%20", 2027, null]) {
      expect(create(slug).success, String(slug)).toBe(false);
    }
    for (const slug of ["-2027", "Turma-2027", "turma_2027", "../2026"]) expect(cohortSlugSchema.safeParse(slug).success, slug).toBe(false);
  });

  it("normalizes case and surrounding spaces at creation only", () => {
    expect(create("  Turma-2027 ").data?.slug).toBe("turma-2027");
    expect(create(` ${thirtyTwo.toUpperCase()} `).data?.slug).toBe(thirtyTwo);
  });

  it("never edits the slug of an existing cohort", () => {
    expect(cohortUpdateRequestSchema.safeParse({ name: "Turma 2027", status: "ACTIVE", reason: "Ajuste" }).success).toBe(true);
    expect(cohortUpdateRequestSchema.safeParse({ name: "Turma 2027", status: "ACTIVE", reason: "Ajuste", slug: "outra" }).success).toBe(false);
  });

  it("the admin form's HTML pattern, compiled as browsers do (v flag), accepts exactly the same slugs", () => {
    const browser = new RegExp(`^(?:${COHORT_SLUG_HTML_PATTERN})$`, "v");
    const rule = new RegExp(COHORT_SLUG_PATTERN);
    for (const slug of [thirtyTwo, `${thirtyTwo}d`, "a", "2027", "turma-2027", "a--b", "-2027", "2027-", "turma_2027", "turma 2027", "Turma", ""]) {
      expect(browser.test(slug), slug).toBe(rule.test(slug));
    }
    // The plain pattern is not valid for the browser: that is why the form uses the HTML one.
    expect(() => new RegExp(`^(?:${COHORT_SLUG_PATTERN.slice(1, -1)})$`, "v")).toThrow();
  });

  it("is exactly the database check and the PDV service worker rule", () => {
    const migration = readFileSync(new URL("../../../supabase/migrations/20261019090000_cohort_foundation.sql", import.meta.url), "utf8");
    expect(migration).toContain(`constraint cohorts_slug_check check (slug ~ '${COHORT_SLUG_PATTERN}')`);
    const worker = readFileSync(new URL("../../../apps/pdv/public/sw.js", import.meta.url), "utf8");
    expect(worker).toContain(`const SLUG = /${COHORT_SLUG_PATTERN}/;`);
  });
});
