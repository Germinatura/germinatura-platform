import { describe, expect, it } from "vitest";
import { activeSection, navigationFor, searchNavigation, type NavigationContext } from "./navigation";

const base: NavigationContext = { roles: [], experience: "admin", features: ["reservations", "raffles", "procurement", "events"], pdvUrl: "http://pdv.test" };
const ids = (context: NavigationContext) => navigationFor(context).flatMap((section) => section.items.map((item) => item.id));
const sectionIds = (context: NavigationContext) => navigationFor(context).map((section) => section.id);

describe("portal navigation", () => {
  it("gives the administrator every staff section in the admin experience", () => {
    const context = { ...base, roles: ["ADMIN"] };
    expect(sectionIds(context)).toEqual(["principal", "catalogo", "financeiro", "comunicacao", "conta", "pdv"]);
    expect(navigationFor(context)[0]?.label).toBe("Operação");
    expect(ids(context)).toEqual(expect.arrayContaining(["users", "audit", "admin-catalog", "inventory", "shifts", "admin-events", "pdv"]));
    expect(ids(context)).not.toContain("catalog");
  });

  it("hides staff areas from an administrator browsing as a consumer", () => {
    const context: NavigationContext = { ...base, roles: ["ADMIN"], experience: "consumer" };
    expect(sectionIds(context)).toEqual(["principal", "conta", "pdv"]);
    expect(navigationFor(context)[0]?.label).toBe("Explorar");
    expect(ids(context)).toEqual(expect.arrayContaining(["home", "catalog", "my-reservations", "raffles", "events", "switch-experience"]));
  });

  it("shows a consumer only consumer screens and no experience switch", () => {
    const list = ids({ ...base, roles: ["CONSUMIDOR"] });
    expect(list).toEqual(["home", "catalog", "my-reservations", "raffles", "events", "profile", "notifications"]);
  });

  it("keeps each staff role inside its own areas", () => {
    expect(sectionIds({ ...base, roles: ["ESTOQUE"] })).toEqual(["principal", "catalogo", "conta"]);
    expect(ids({ ...base, roles: ["ESTOQUE"] })).not.toContain("admin-catalog");
    expect(sectionIds({ ...base, roles: ["FINANCEIRO"] })).toEqual(["principal", "financeiro", "conta"]);
    expect(sectionIds({ ...base, roles: ["COMUNICACAO"] })).toEqual(["principal", "comunicacao", "conta"]);
    expect(ids({ ...base, roles: ["VENDEDOR"] })).toContain("pdv");
  });

  it("follows the feature flags", () => {
    const admin = ids({ ...base, roles: ["ADMIN"], features: [] });
    expect(admin).not.toContain("admin-reservations");
    expect(admin).not.toContain("admin-raffles");
    expect(ids({ ...base, roles: ["CONSUMIDOR"], features: [] })).not.toContain("raffles");
    expect(admin).not.toContain("procurement");
    expect(admin).not.toContain("admin-events");
    expect(admin).not.toContain("events");
    expect(admin).toContain("payables");
    expect(admin).toContain("shifts");
  });

  it("finds the section of the current route", () => {
    const sections = navigationFor({ ...base, roles: ["ADMIN"] });
    expect(activeSection(sections, "/admin/financeiro/turnos")).toBe("financeiro");
    expect(activeSection(sections, "/admin/financeiro/importar-extrato")).toBe("financeiro");
    expect(activeSection(sections, "/admin/estoque")).toBe("catalogo");
    expect(activeSection(sections, "/")).toBe("principal");
    expect(activeSection(sections, "/rota-desconhecida")).toBeNull();
  });

  it("searches names and keywords without accents and only among reachable screens", () => {
    const admin = navigationFor({ ...base, roles: ["ADMIN"] });
    expect(searchNavigation(admin, "turno")[0]?.item.id).toBe("shifts");
    expect(searchNavigation(admin, "configuracoes")[0]?.item.id).toBe("settings");
    expect(searchNavigation(admin, "fornecedor").map((match) => match.item.id)).toEqual(expect.arrayContaining(["procurement", "payables"]));
    expect(searchNavigation(admin, "financeiro extrato").map((match) => match.item.id)).toEqual(expect.arrayContaining(["statement", "statement-import"]));
    const consumer = navigationFor({ ...base, roles: ["CONSUMIDOR"] });
    expect(searchNavigation(consumer, "auditoria")).toEqual([]);
    expect(searchNavigation(consumer, "turno")).toEqual([]);
    expect(searchNavigation(consumer, "").length).toBe(7);
  });
});
