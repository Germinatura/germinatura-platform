import { describe, expect, it } from "vitest";
import { buildShareText } from "./share-text";

const products = [{ name: "Brigadeiro", priceCents: 350 }, { name: "Bolo de pote", priceCents: 1200 }];
const link = "https://portal.example/d/abc12345";

describe("share text", () => {
  it("formats WhatsApp with bold title, bullets and the tracked link", () => {
    expect(buildShareText({ channel: "WHATSAPP", title: "Doces da semana", products, link }))
      .toBe("*Doces da semana*\n\n• Brigadeiro — R$ 3,50\n• Bolo de pote — R$ 12,00\n\nReserve pelo Portal: https://portal.example/d/abc12345");
  });

  it("points in-person material to the QR code", () => {
    expect(buildShareText({ channel: "PRESENCIAL", title: "Feira", products: [], link }))
      .toBe("Feira\n\nConfira o catálogo completo da formatura.\n\nAponte a câmera para o QR Code ou acesse https://portal.example/d/abc12345");
  });

  it("keeps the link in every channel", () => {
    for (const channel of ["INSTAGRAM", "MURAL", "OUTRO"] as const) {
      expect(buildShareText({ channel, title: "Oferta", products, link })).toContain(link);
    }
  });
});
