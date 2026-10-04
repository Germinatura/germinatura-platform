import type { PublicCatalogProduct } from "@germinatura/contracts";

export interface CartPayloadItem {
  product: PublicCatalogProduct;
  quantity: number;
}

export function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(amountCents / 100);
}

export function cartPayload(items: CartPayloadItem[]) {
  return items.map(({ product, quantity }) => ({ productId: product.id, quantity }));
}

/** Parses a typed BRL amount ("50", "50,5", "1.234,56") into integer cents, or null. */
export function parseMoneyInput(value: string): number | null {
  const normalized = value.trim().replace(/^R\$\s*/i, "").replace(/\.(?=\d{3}(\D|$))/g, "");
  const match = normalized.match(/^(\d{1,13})(?:[,.](\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Change for a cash payment, or null while the tendered amount does not cover the total. */
export function cashChange(totalCents: number, tenderedCents: number | null): number | null {
  return tenderedCents === null || tenderedCents < totalCents ? null : tenderedCents - totalCents;
}

const paymentMethodLabels: Record<string, string> = {
  DINHEIRO: "Dinheiro", MAQUININHA: "Maquininha", PIX_AREA: "Pix (Área Pix)", TAP: "PicPay Tap",
  PAYMENT_LINK: "Link de pagamento", CHECKOUT_API: "Checkout PicPay", PICPAY_WALLET: "Carteira PicPay",
};

/** Human label of the payment method of a sale; null channel means not paid yet. */
export function paymentMethodLabel(channel: string | null | undefined) {
  return channel ? paymentMethodLabels[channel] ?? channel : "Sem pagamento";
}

/** Spec 6.10 status shown in "Minhas vendas"; pending reasons take precedence over the sale status. */
export function mySaleStatus(sale: { status: string; pendingReason: string | null; payment: { status: string } | null }) {
  if (sale.pendingReason === "AWAITING_PAYMENT") return { label: "Aguardando pagamento", tone: "warning" as const };
  if (sale.pendingReason === "RECONCILIATION_PENDING") return { label: "Pendente de conciliação", tone: "warning" as const };
  if (sale.status === "CANCELLED") return sale.payment?.status === "REFUNDED"
    ? { label: "Estornada", tone: "danger" as const } : { label: "Cancelada", tone: "neutral" as const };
  return { label: "Concluída", tone: "success" as const };
}

const cardMethodLabels: Record<string, string> = {
  CREDITO: "Crédito", DEBITO: "Débito", VOUCHER_ALIMENTACAO: "Vale-alimentação", VOUCHER_REFEICAO: "Vale-refeição",
};

/** Payment line of "Minhas vendas": channel, then card method and terminal when present. */
export function paymentSummary(payment: { integrationChannel: string | null; cardMethod: string | null; terminalCode: string | null } | null) {
  const channel = paymentMethodLabel(payment?.integrationChannel);
  const card = payment?.cardMethod ? cardMethodLabels[payment.cardMethod] ?? payment.cardMethod : null;
  return [channel, card, payment?.terminalCode ?? null].filter(Boolean).join(" · ");
}
