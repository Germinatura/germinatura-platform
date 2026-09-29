import { describe, expect, it } from "vitest";
import { publishAnnouncementRequestSchema } from "./index";

const base = { title: "Reunião", body: "Encontro às 18h.", all: false, roles: [], emails: [] };

describe("announcement contracts", () => {
  it("needs an audience", () => {
    expect(publishAnnouncementRequestSchema.safeParse(base).success).toBe(false);
    expect(publishAnnouncementRequestSchema.safeParse({ ...base, all: true }).success).toBe(true);
    expect(publishAnnouncementRequestSchema.safeParse({ ...base, roles: ["VENDEDOR"] }).success).toBe(true);
    expect(publishAnnouncementRequestSchema.safeParse({ ...base, roles: ["TURMA_A"] }).success).toBe(false);
  });

  it("normalizes e-mails", () => {
    expect(publishAnnouncementRequestSchema.parse({ ...base, emails: [" Aluno@InstitutoJEF.org.br "] }).emails).toEqual(["aluno@institutojef.org.br"]);
    expect(publishAnnouncementRequestSchema.safeParse({ ...base, emails: ["não é e-mail"] }).success).toBe(false);
  });
});
