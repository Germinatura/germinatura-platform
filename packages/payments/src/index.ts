export interface PaymentRequest {
  orderId: string;
  amountInCents: number;
  idempotencyKey: string;
}

export interface PaymentResult {
  externalId: string;
  status: "PENDING" | "PAID" | "FAILED";
}

export interface PaymentProvider {
  createPayment(input: PaymentRequest): Promise<PaymentResult>;
  getPaymentStatus(externalId: string): Promise<PaymentResult>;
  cancelOrRefund(externalId: string): Promise<PaymentResult>;
  validateWebhook(request: Request): Promise<boolean>;
}
