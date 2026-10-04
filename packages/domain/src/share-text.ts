import { formatMoneyBrl, moneyFromCents } from "./index";

export type ShareTextChannel = "WHATSAPP" | "INSTAGRAM" | "MURAL" | "PRESENCIAL" | "OUTRO";
export interface ShareTextProduct { name: string; priceCents: number }

/**
 * Builds the ready-to-copy text of a share campaign with current prices and the tracked link (spec 5.13).
 * Prices are informative: the server recalculates them, with promotions, when the customer reserves.
 */
export function buildShareText(input: { channel: ShareTextChannel; title: string; products: readonly ShareTextProduct[]; link: string }): string {
  const lines = input.products.map((product) => `${product.name} — ${formatMoneyBrl(moneyFromCents(product.priceCents))}`);
  const offer = lines.length > 0 ? lines : ["Confira o catálogo completo da formatura."];
  switch (input.channel) {
    case "WHATSAPP":
      return [`*${input.title}*`, "", ...offer.map((line) => `• ${line}`), "", `Reserve pelo Portal: ${input.link}`].join("\n");
    case "INSTAGRAM":
      return [input.title, "", ...offer, "", `Reserve pelo link: ${input.link}`, "", "#formatura #germinatura"].join("\n");
    case "MURAL":
      return [input.title, "", ...offer, "", `Reservas: ${input.link}`].join("\n");
    case "PRESENCIAL":
      return [input.title, "", ...offer, "", `Aponte a câmera para o QR Code ou acesse ${input.link}`].join("\n");
    default:
      return [input.title, "", ...offer, "", input.link].join("\n");
  }
}
