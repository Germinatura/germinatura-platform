import { featureFlagKeySchema } from "@germinatura/contracts";
import { describe, expect, it } from "vitest";
import { featureFlagEffects } from "./feature-flag-effects";

describe("feature flag effects", () => {
  it("explains what every flag does on and off in Configurações", () => {
    for (const key of featureFlagKeySchema.options) {
      expect(featureFlagEffects[key]?.on, key).toBeTruthy();
      expect(featureFlagEffects[key]?.off, key).toBeTruthy();
    }
  });

  it("links module flags to the history that stays readable", () => {
    expect(featureFlagEffects.procurement?.history?.href).toBe("/admin/compras");
    expect(featureFlagEffects.events?.history?.href).toBe("/admin/comunicacao/eventos");
    expect(featureFlagEffects.cash_payment?.history?.href).toBe("/admin/financeiro/turnos");
  });
});
