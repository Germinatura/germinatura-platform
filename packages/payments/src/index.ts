import type { MoneyCents } from "@germinatura/domain";

export const paymentStatuses = ["CREATED", "PENDING", "AWAITING_EXTERNAL_CONFIRMATION", "APPROVED", "DECLINED", "CANCELLED", "EXPIRED", "REFUNDED", "RECONCILIATION_PENDING", "RECONCILED"] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];
export type PaymentConfirmationSource = "WEBHOOK" | "STATUS_QUERY" | "MANUAL" | "RECONCILIATION_IMPORT";
export type PaymentIntegrationChannel = "PIX_AREA" | "CHECKOUT_API" | "PICPAY_WALLET" | "PAYMENT_LINK" | "MAQUININHA" | "TAP";

export interface PaymentRequest { orderId: string; amountInCents: MoneyCents; idempotencyKey: string; }
export interface PaymentResult { externalId?: string; status: PaymentStatus; confirmationSource?: PaymentConfirmationSource; }
export interface RefundRequest { externalId: string; amountInCents?: MoneyCents; idempotencyKey: string; }

export interface PaymentProvider {
  createPayment(input: PaymentRequest): Promise<PaymentResult>;
  getPaymentStatus(externalId: string): Promise<PaymentResult>;
  cancelOrRefund(input: RefundRequest): Promise<PaymentResult>;
  validateWebhook(request: Request): Promise<boolean>;
  normalizeEvent(event: unknown): PaymentResult;
}

export interface CardPresentAttemptRequest extends PaymentRequest {
  channel: Extract<PaymentIntegrationChannel, "MAQUININHA" | "TAP">;
  operatorId: string;
  terminalId?: string;
}

export interface ManualTerminalConfirmation {
  attemptId: string; idempotencyKey: string; operatorId: string; approved: boolean;
  occurredAt: string; nonSensitiveReference?: string;
}

export interface CardPresentProvider {
  createPaymentAttempt(input: CardPresentAttemptRequest): Promise<PaymentResult>;
  confirmExternalTerminalPayment(input: ManualTerminalConfirmation): Promise<PaymentResult>;
  reconcileTransaction(input: { attemptId: string; idempotencyKey: string; externalReference: string }): Promise<PaymentResult>;
  supportsRemoteInitiation(): boolean;
  createRemoteTerminalPayment?(input: CardPresentAttemptRequest): Promise<PaymentResult>;
}

const allowedTransitions: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  CREATED: ["PENDING", "AWAITING_EXTERNAL_CONFIRMATION", "CANCELLED", "EXPIRED"],
  PENDING: ["AWAITING_EXTERNAL_CONFIRMATION", "APPROVED", "DECLINED", "CANCELLED", "EXPIRED"],
  AWAITING_EXTERNAL_CONFIRMATION: ["APPROVED", "DECLINED", "CANCELLED", "EXPIRED"],
  APPROVED: ["REFUNDED", "RECONCILIATION_PENDING", "RECONCILED"],
  DECLINED: [], CANCELLED: [], EXPIRED: [],
  REFUNDED: ["RECONCILIATION_PENDING", "RECONCILED"],
  RECONCILIATION_PENDING: ["RECONCILED"], RECONCILED: [],
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || allowedTransitions[from].includes(to);
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransitionPayment(from, to)) throw new Error(`Invalid payment status transition: ${from} -> ${to}`);
}

export class PaymentIntegrationUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "PaymentIntegrationUnavailableError"; }
}

/** Performs no network request. Replace only after official PicPay enablement. */
export class UnavailablePicPayCardPresentProvider implements CardPresentProvider {
  supportsRemoteInitiation(): boolean { return false; }
  createPaymentAttempt(input: CardPresentAttemptRequest): Promise<PaymentResult> {
    void input;
    return Promise.reject(this.unavailable());
  }
  confirmExternalTerminalPayment(input: ManualTerminalConfirmation): Promise<PaymentResult> {
    void input;
    return Promise.reject(this.unavailable());
  }
  reconcileTransaction(input: { attemptId: string; idempotencyKey: string; externalReference: string }): Promise<PaymentResult> {
    void input;
    return Promise.reject(this.unavailable());
  }
  private unavailable(): PaymentIntegrationUnavailableError {
    return new PaymentIntegrationUnavailableError("PicPay card-present integration is unavailable until officially documented and enabled");
  }
}
