import { describe, expect, it } from "vitest";
import { cohortOnlyReason, safeNextPath, screenAllowedInAll } from "./consolidated-screens";

describe("screens in Todas as turmas (ADR 0011, PR 4)", () => {
  it("opens only the consolidated screens and sends every other one to the cohort selection", () => {
    for (const path of ["/", "/admin/usuarios", "/admin/turmas", "/admin/auditoria", "/admin/financeiro/vendas", "/admin/financeiro/indicadores", "/perfil"]) {
      expect(screenAllowedInAll(path), path).toBe(true);
    }
    for (const path of ["/admin/financeiro/saldo", "/admin/financeiro/contas-a-pagar", "/admin/estoque", "/admin/rifas", "/catalogo", "/admin/financeiro/vendas/x", "/admin/nova-tela"]) {
      expect(screenAllowedInAll(path), path).toBe(false);
    }
  });

  it("explains why a screen stays in one cohort, the PicPay statement included", () => {
    expect(cohortOnlyReason("/admin/financeiro/extrato")).toMatch(/evidência global/);
    expect(cohortOnlyReason("/admin/financeiro/contas-a-pagar")).toMatch(/livro de uma turma/);
    expect(cohortOnlyReason("/admin/estoque/lotes")).toMatch(/locais de uma turma/);
    expect(cohortOnlyReason("/algo")).toMatch(/uma turma/);
  });

  it("returns only to a same-origin path", () => {
    expect(safeNextPath("/admin/estoque?q=1")).toBe("/admin/estoque?q=1");
    for (const value of ["https://evil.test", "//evil.test", "/\\evil.test", "", null, undefined]) expect(safeNextPath(value)).toBe("/");
  });
});
