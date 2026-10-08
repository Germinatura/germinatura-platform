import { describe, expect, it } from "vitest";
import { Badge, BrandMark, Button, Card, fieldDescriptionIds, Input, InputGroup, ReasonField } from "./index";

describe("shared UI primitives", () => {
  it("applies semantic button variants and loading state", () => {
    const button = Button({ children: "Cobrar", variant: "operation", loading: true });

    expect(button).toMatchObject({
      props: {
        className: "g-button g-button--operation g-button--md",
        disabled: true,
        "aria-busy": true,
      },
    });
  });

  it("uses semantic classes instead of app-specific colors", () => {
    expect(Card({ tone: "selected" })).toMatchObject({ props: { className: "g-card g-card--selected" } });
    expect(Badge({ tone: "warning" })).toMatchObject({ props: { className: "g-badge g-badge--warning" } });
    expect(Input({ id: "email" })).toMatchObject({ props: { className: "g-input" } });
  });

  it("shares one accessible brand mark across applications", () => {
    const mark = BrandMark({ title: "Germinatura" });
    expect(mark).toMatchObject({
      props: {
        role: "img",
        "aria-label": "Germinatura",
        children: { props: { fill: "#0E208E" } },
      },
    });
    expect(BrandMark({ tone: "inverse" })).toMatchObject({
      props: { children: { props: { fill: "currentColor" } } },
    });
  });

  it("keeps a decorative input icon out of the accessibility tree and out of the text", () => {
    expect(InputGroup({ icon: "icon", children: null })).toMatchObject({
      props: { className: "g-input-group", children: [{ props: { className: "g-input-group__icon", "aria-hidden": "true" } }, null, undefined] },
    });
    expect(InputGroup({ icon: "icon", trailing: "toggle", children: null })).toMatchObject({ props: { className: "g-input-group g-input-group--trailing" } });
  });

  it("writes the minimum of a reason and counts while it is short", () => {
    type Node = { props: { children?: unknown; [key: string]: unknown } };
    const parts = (value: string) => (ReasonField({ id: "reason", value, onChange: () => undefined, minLength: 8, maxLength: 300 }) as Node).props.children as Node[];
    const [, control, rule, count] = parts("Troco");
    expect(control.props["aria-describedby"]).toBe("reason-rule reason-count");
    expect(control.props["aria-invalid"]).toBe(true);
    expect((rule.props.children as string[]).join("")).toBe("Mínimo de 8 caracteres.");
    expect(count.props.children).toBe("5/8 caracteres");
    const [, doneControl, , doneCount] = parts("Venda avulsa");
    expect(doneCount.props.children).toBe("");
    expect(doneControl.props["aria-invalid"]).toBeUndefined();
  });

  it("names the helper texts of a field for aria-describedby", () => {
    expect(fieldDescriptionIds("limit", { description: "Vazio exige aprovação" })).toBe("limit-description");
    expect(fieldDescriptionIds("limit", { description: "x", error: "Obrigatório" })).toBe("limit-error");
    expect(fieldDescriptionIds("limit", {})).toBeUndefined();
  });
});
