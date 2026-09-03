import { describe, expect, it } from "vitest";
import { Badge, BrandMark, Button, Card, Input } from "./index";

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
});
