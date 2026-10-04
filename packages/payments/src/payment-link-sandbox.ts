import { PaymentLinkProviderError, type PaymentLinkConfig, type PaymentLinkGateway } from "./payment-link";

// Documented sandbox hosts and test ids (PicPay "Configuração" and "Cenários de Teste" pages).
const sandboxTokenUrl = "https://api.ms.qa.limbo.work/oauth2/token";
const sandboxApiBaseUrl = "https://api.ms.qa.limbo.work/sandbox/v1";
const missingLinkId = "17496673826849ce36a1c29";
const failingTransactionsLinkId = "17496626166849bb9851578";
const emptyLinkId = "173887430167a51dbd8ee2d";
const refundSuccessTransactionId = "9f1c6b2a-3f4e-4b8d-a6c2-22e12f5a9d74";
const refundFailureTransactionId = "e379b4d5-791c-48c8-bc19-3e908a6de9b7";

export interface SandboxCheckStep { step: string; ok: boolean; detail: string }
export interface SandboxCheckResult { ok: boolean; steps: SandboxCheckStep[] }

export function isPaymentLinkSandbox(config: PaymentLinkConfig): boolean {
  return config.tokenUrl === sandboxTokenUrl && config.apiBaseUrl === sandboxApiBaseUrl;
}

const codeOf = (error: unknown) => error instanceof PaymentLinkProviderError
  ? `${error.code}${error.status ? ` (HTTP ${error.status})` : ""}${error.uncertain ? " incerto" : ""}${error.reason ? ` [${error.reason}]` : ""}`
  : "UNEXPECTED_ERROR";

/**
 * Exercises the sandbox without the webhook and without touching the database: OAuth, creation, lookups,
 * transactions, inactivation (twice, to prove idempotency) and refunds, using the documented test ids.
 * Reports only step names, outcomes and provider error codes.
 */
export async function runPaymentLinkSandboxCheck(gateway: PaymentLinkGateway, today: string): Promise<SandboxCheckResult> {
  const steps: SandboxCheckStep[] = [];
  const record = async (step: string, run: () => Promise<[boolean, string]>) => {
    const started = Date.now();
    const took = () => ` (${Date.now() - started} ms)`;
    try { const [ok, detail] = await run(); steps.push({ step, ok, detail: detail + took() }); }
    catch (error) { steps.push({ step, ok: false, detail: codeOf(error) + took() }); }
  };
  // Only a real answer from the provider counts as the documented rejection; no answer is a failure.
  const expectRejected = async (run: () => Promise<unknown>): Promise<[boolean, string]> => {
    try { await run(); return [false, "respondeu com sucesso"]; }
    catch (error) {
      return [error instanceof PaymentLinkProviderError && !error.uncertain && error.status !== undefined && !error.code.startsWith("AUTH_"), codeOf(error)];
    }
  };

  await record("oauth_and_missing_link", async () => {
    const charge = await gateway.findCharge(missingLinkId);
    return [charge === null, charge === null ? "token obtido; link inexistente = 404" : "link inexistente foi encontrado"];
  });
  await record("transactions_empty", async () => {
    const { transactions } = await gateway.listTransactions(emptyLinkId);
    return [transactions.length === 0, `${transactions.length} transações`];
  });
  await record("transactions_failure", () => expectRejected(() => gateway.listTransactions(failingTransactionsLinkId)));

  let linkId: string | null = null;
  await record("create", async () => {
    const created = await gateway.createCharge({
      orderNumber: `GDIAG${Date.now().toString(36).toUpperCase()}`.slice(0, 15), name: "Germinatura diagnóstico sandbox",
      amountCents: 100, expiresOn: today,
    });
    linkId = created.paymentLinkId;
    return [true, `link criado (${created.brcode ? "com" : "sem"} Pix copia e cola)`];
  });
  if (linkId) {
    const id: string = linkId;
    await record("find_created", async () => {
      const charge = await gateway.findCharge(id);
      return [charge?.status === "active", charge ? `status ${charge.status}, valor ${charge.amountCents ?? "?"}` : "não encontrado"];
    });
    await record("transactions_created", async () => {
      const { transactions } = await gateway.listTransactions(id);
      return [true, `${transactions.length} transações (o sandbox devolve uma lista fixa)`];
    });
    await record("inactivate", async () => { await gateway.inactivateCharge(id); return [true, "inativado"]; });
    await record("inactivate_again", async () => { await gateway.inactivateCharge(id); return [true, "já inativado tratado como sucesso"]; });
    await record("find_inactivated", async () => {
      const charge = await gateway.findCharge(id);
      return [charge !== null && charge.status !== "active", charge ? `status ${charge.status}` : "não encontrado"];
    });
  }
  await record("refund_success", async () => {
    const refund = await gateway.refundTransaction(refundSuccessTransactionId, 100);
    return [refund.amountCents === 100, `estorno aceito: ${refund.amountCents} de ${refund.originalAmountCents}`];
  });
  await record("refund_rejected", () => expectRejected(() => gateway.refundTransaction(refundFailureTransactionId, 100)));
  return { ok: steps.every((step) => step.ok), steps };
}
