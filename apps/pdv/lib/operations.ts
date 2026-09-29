import {
  featureFlagsResponseSchema,
  paymentLinkChargeResponseSchema,
  type PaymentLinkCharge,
  cashPaymentResponseSchema,
  manualPaymentConfirmationResponseSchema,
  mySalesResponseSchema,
  completePickupResponseSchema,
  pickupReservationsResponseSchema,
  paymentTerminalsResponseSchema,
  sellerShiftResponseSchema,
  pricingQuoteResponseSchema,
  publicCatalogProductsResponseSchema,
  sellerCloseoutResponseSchema,
  salesCancelResponseSchema,
  salesCheckoutResponseSchema,
  sellerStockTransferContextResponseSchema,
  sellerStockTransferMutationResponseSchema,
  stockReturnContextResponseSchema,
  stockReturnMutationResponseSchema,
  stockLossContextResponseSchema,
  stockLossMutationResponseSchema,
  inventoryCountContextResponseSchema,
  inventoryCountMutationResponseSchema,
  type CashPaymentResponse,
  type ManualPaymentConfirmationResponse,
  type MySalesFilter,
  type MySalesResponse,
  type CompletePickupRequest,
  type CompletePickupResponse,
  type PickupReservation,
  type CardPaymentMethod,
  type PaymentTerminal,
  type SellerShift,
  type PaymentIntegrationChannel,
  type PricingQuoteResponse,
  type PublicCatalogProduct,
  type SellerCloseoutResponse,
  type SalesCheckoutResponse,
  type SellerStockTransferContextResponse,
  type SellerStockTransferMutationResponse,
  type StockReturnContextResponse,
  type StockReturnMutationResponse,
  type StockLossContextResponse,
  type StockLossMutationResponse,
  type InventoryCountContextResponse,
  type InventoryCountMutationResponse,
} from "@germinatura/contracts";
import { apiFetch } from "@/lib/api";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { cartPayload } from "./operations-pure";

export { cartPayload, cashChange, formatMoney, mySaleStatus, parseMoneyInput, paymentMethodLabel, paymentSummary } from "./operations-pure";

export interface StockLocation {
  id: string;
  name: string;
  type: "CENTRAL" | "SELLER";
}

export interface InventoryContext {
  locations: StockLocation[];
  availableByLocationAndProduct: Record<string, number>;
  onHandByLocationAndProduct: Record<string, number>;
}

interface InventoryBalance {
  locationId: string;
  productId: string;
  available: number;
  onHand: number;
}

export interface CartItem {
  product: PublicCatalogProduct;
  quantity: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function parseLocation(value: unknown): StockLocation | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || typeof row.name !== "string") return null;
  if (row.location_type !== "CENTRAL" && row.location_type !== "SELLER") return null;
  return { id: row.id, name: row.name, type: row.location_type };
}

function parseBalance(value: unknown): InventoryBalance | null {
  const row = asRecord(value);
  if (
    !row
    || typeof row.location_id !== "string"
    || typeof row.product_id !== "string"
    || typeof row.on_hand_quantity !== "number"
    || typeof row.reserved_quantity !== "number"
  ) return null;
  return {
    locationId: row.location_id,
    productId: row.product_id,
    available: Math.max(0, row.on_hand_quantity - row.reserved_quantity),
    onHand: row.on_hand_quantity,
  };
}

async function responseError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  const record = asRecord(body);
  return typeof record?.message === "string" ? record.message : fallback;
}

export async function loadInventoryContext(): Promise<InventoryContext> {
  const supabase = getSupabaseBrowserClient();
  const [locationResult, balanceResult] = await Promise.all([
    supabase
      .from("stock_locations")
      .select("id,name,location_type")
      .eq("active", true)
      .order("location_type", { ascending: true })
      .order("name", { ascending: true }),
    supabase
      .from("inventory_balances")
      .select("location_id,product_id,on_hand_quantity,reserved_quantity"),
  ]);

  if (locationResult.error || balanceResult.error) {
    throw new Error("Não foi possível carregar a localização e o estoque deste PDV.");
  }
  const locationRows: unknown[] = Array.isArray(locationResult.data) ? locationResult.data : [];
  const balanceRows: unknown[] = Array.isArray(balanceResult.data) ? balanceResult.data : [];
  const locations = locationRows.map(parseLocation).filter((value): value is StockLocation => value !== null);
  const balances = balanceRows.map(parseBalance).filter((value): value is InventoryBalance => value !== null);
  return {
    locations,
    availableByLocationAndProduct: Object.fromEntries(
      balances.map((balance) => [`${balance.locationId}:${balance.productId}`, balance.available]),
    ),
    onHandByLocationAndProduct: Object.fromEntries(
      balances.map((balance) => [`${balance.locationId}:${balance.productId}`, balance.onHand]),
    ),
  };
}

export async function createSellerCloseout(
  periodStart: string,
  periodEnd: string,
  stockCounts: Array<{ productId: string; countedQuantity: number }>,
  justification: string | null,
  idempotencyKey: string,
): Promise<SellerCloseoutResponse["data"]> {
  const response = await apiFetch("/api/v1/closeouts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ periodStart, periodEnd, stockCounts, justification }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível concluir o fechamento."));
  const parsed = sellerCloseoutResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O fechamento retornou dados inválidos.");
  return parsed.data.data;
}

export async function loadCatalog(): Promise<PublicCatalogProduct[]> {
  const response = await apiFetch("/api/v1/catalog/products?limit=50");
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível carregar o catálogo."));
  const parsed = publicCatalogProductsResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O catálogo retornou dados inválidos.");
  return parsed.data.data.filter((product) => product.sellablePdv);
}

export async function quoteCart(items: CartItem[], couponCode?: string): Promise<PricingQuoteResponse["data"]> {
  const response = await apiFetch("/api/v1/pricing/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "PDV", items: cartPayload(items), ...(couponCode ? { couponCode } : {}) }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível atualizar os valores da venda."));
  const parsed = pricingQuoteResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A cotação retornou dados inválidos.");
  return parsed.data.data;
}

export async function checkoutCart(
  locationId: string,
  items: CartItem[],
  idempotencyKey: string,
  couponCode?: string,
): Promise<SalesCheckoutResponse["data"]> {
  const response = await apiFetch("/api/v1/sales/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ channel: "PDV", locationId, items: cartPayload(items), ...(couponCode ? { couponCode } : {}) }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível iniciar a cobrança."));
  const parsed = salesCheckoutResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A cobrança retornou dados inválidos.");
  return parsed.data.data;
}

export async function confirmManualPayment(
  saleId: string,
  channel: Extract<PaymentIntegrationChannel, "MAQUININHA" | "PIX_AREA">,
  proofReference: string,
  card: { cardMethod: CardPaymentMethod; terminalId: string | null } | null,
  idempotencyKey: string,
): Promise<ManualPaymentConfirmationResponse["data"]> {
  const response = await apiFetch(`/api/v1/sales/${saleId}/payments/manual-confirmation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ integrationChannel: channel, proofReference, ...(card ?? {}) }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível confirmar o recebimento."));
  const parsed = manualPaymentConfirmationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A confirmação retornou dados inválidos.");
  return parsed.data.data;
}

/** RES-003: prepared reservations waiting for pickup at the locations this operator runs. */
export async function loadPickups(query: string): Promise<PickupReservation[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("query", query.trim());
  const response = await apiFetch(`/api/v1/pdv/pickups${params.size ? `?${params}` : ""}`);
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível carregar as retiradas."));
  const parsed = pickupReservationsResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("As retiradas retornaram dados inválidos.");
  return parsed.data.data;
}

/** Hands over a prepared reservation, charging the frozen price in one atomic step. */
export async function completePickup(reservationId: string, payment: CompletePickupRequest, idempotencyKey: string): Promise<CompletePickupResponse["data"]> {
  const response = await apiFetch(`/api/v1/pdv/pickups/${reservationId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payment),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível concluir a retirada."));
  const parsed = completePickupResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A retirada retornou dados inválidos.");
  return parsed.data.data;
}

/** Spec 6.7: active Maquininhas; when any exists the seller must name the one used. */
export async function loadPaymentTerminals(): Promise<PaymentTerminal[]> {
  const response = await apiFetch("/api/v1/pdv/terminals");
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível carregar as maquininhas."));
  const parsed = paymentTerminalsResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("As maquininhas retornaram dados inválidos.");
  return parsed.data.data;
}

/** Spec 6.10: the seller's own sales, newest first, with the pending count for the tab badge. */
export async function loadMySales(filter: MySalesFilter | null, cursor?: string | null): Promise<MySalesResponse> {
  const params = new URLSearchParams();
  if (filter) params.set("filter", filter);
  if (cursor) params.set("cursor", cursor);
  const response = await apiFetch(`/api/v1/pdv/sales${params.size ? `?${params}` : ""}`);
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível carregar suas vendas."));
  const parsed = mySalesResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("As vendas retornaram dados inválidos.");
  return parsed.data;
}

export async function cancelPendingSale(saleId: string, idempotencyKey: string) {
  const response = await apiFetch(`/api/v1/sales/${saleId}/cancel`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível cancelar a venda pendente."));
  const parsed = salesCancelResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O cancelamento retornou dados inválidos.");
  return parsed.data.data;
}

export async function loadSellerStockTransfers(cursor?: string): Promise<SellerStockTransferContextResponse["data"]> {
  const response = await apiFetch(`/api/v1/inventory/transfer-requests?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível carregar as transferências."));
  const parsed = sellerStockTransferContextResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A consulta de transferências retornou dados inválidos.");
  return parsed.data.data;
}

export async function loadStockReturns(cursor?: string): Promise<StockReturnContextResponse["data"]> {
  const response = await apiFetch(`/api/v1/inventory/returns?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível carregar as devoluções."));
  const parsed = stockReturnContextResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A consulta de devoluções retornou dados inválidos.");
  return parsed.data.data;
}

export async function requestStockReturn(
  input: { productId: string; quantity: number; reason: string },
  idempotencyKey: string,
): Promise<StockReturnMutationResponse["data"]> {
  const response = await apiFetch("/api/v1/inventory/returns", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível solicitar a devolução."));
  const parsed = stockReturnMutationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A solicitação de devolução retornou dados inválidos.");
  return parsed.data.data;
}

export async function cancelStockReturn(requestId: string, reason: string, idempotencyKey: string): Promise<StockReturnMutationResponse["data"]> {
  const response = await apiFetch(`/api/v1/inventory/returns/${requestId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ action: "CANCEL", reason }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível cancelar a devolução."));
  const parsed = stockReturnMutationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O cancelamento da devolução retornou dados inválidos.");
  return parsed.data.data;
}

export async function loadStockLosses(cursor?: string): Promise<StockLossContextResponse["data"]> {
  const response = await apiFetch(`/api/v1/inventory/losses?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível carregar as perdas."));
  const parsed = stockLossContextResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A consulta de perdas retornou dados inválidos.");
  return parsed.data.data;
}

export async function reportStockLoss(input: { productId: string; quantity: number; reason: string; observation: string; photoPath?: string | null }, idempotencyKey: string): Promise<StockLossMutationResponse["data"]> {
  const response = await apiFetch("/api/v1/inventory/losses", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível registrar a perda."));
  const parsed = stockLossMutationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O registro da perda retornou dados inválidos.");
  return parsed.data.data;
}

export async function cancelStockLoss(reportId: string, reason: string, idempotencyKey: string): Promise<StockLossMutationResponse["data"]> {
  const response = await apiFetch(`/api/v1/inventory/losses/${reportId}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ action: "CANCEL", reason }) });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível cancelar a perda."));
  const parsed = stockLossMutationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O cancelamento retornou dados inválidos.");
  return parsed.data.data;
}

export async function loadInventoryCounts(cursor?: string): Promise<InventoryCountContextResponse["data"]> {
  const response = await apiFetch(`/api/v1/inventory/counts?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível carregar o estoque."));
  const parsed = inventoryCountContextResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A consulta de estoque retornou dados inválidos.");
  return parsed.data.data;
}

export async function submitInventoryCount(input: { locationId?: string | null; observation: string; items: Array<{ productId: string; expectedOnHandQuantity: number; expectedReservedQuantity: number; countedOnHandQuantity: number }> }, idempotencyKey: string): Promise<InventoryCountMutationResponse["data"]> {
  const response = await apiFetch("/api/v1/inventory/counts", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível enviar a contagem."));
  const parsed = inventoryCountMutationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A contagem retornou dados inválidos.");
  return parsed.data.data;
}

export async function cancelInventoryCount(countId: string, reason: string, idempotencyKey: string): Promise<InventoryCountMutationResponse["data"]> {
  const response = await apiFetch(`/api/v1/inventory/counts/${countId}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ action: "CANCEL", reason }) });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível cancelar a contagem."));
  const parsed = inventoryCountMutationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O cancelamento retornou dados inválidos.");
  return parsed.data.data;
}

export async function requestSellerStockTransfer(
  input: { fromLocationId: string; productId: string; quantity: number; reason: string },
  idempotencyKey: string,
): Promise<SellerStockTransferMutationResponse["data"]> {
  const response = await apiFetch("/api/v1/inventory/transfer-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível solicitar a transferência."));
  const parsed = sellerStockTransferMutationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A solicitação de transferência retornou dados inválidos.");
  return parsed.data.data;
}

export async function resolveSellerStockTransfer(
  requestId: string,
  action: "ACCEPT" | "REJECT" | "CANCEL",
  reason: string,
  idempotencyKey: string,
): Promise<SellerStockTransferMutationResponse["data"]> {
  const response = await apiFetch(`/api/v1/inventory/transfer-requests/${requestId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ action, reason }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível decidir a transferência."));
  const parsed = sellerStockTransferMutationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A decisão da transferência retornou dados inválidos.");
  return parsed.data.data;
}

/** PAY-009: the seller open shift ("Meu turno"), or null. */
export async function loadMyShift(): Promise<SellerShift | null> {
  const response = await apiFetch("/api/v1/pdv/shifts");
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível carregar o turno."));
  const parsed = sellerShiftResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O turno retornou dados inválidos.");
  return parsed.data.data;
}

export async function openShift(locationId: string, openingCashCents: number, idempotencyKey: string): Promise<SellerShift> {
  const response = await apiFetch("/api/v1/pdv/shifts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ locationId, openingCashCents }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível abrir o turno."));
  const parsed = sellerShiftResponseSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.data) throw new Error("O turno retornou dados inválidos.");
  return parsed.data.data;
}

export async function closeShift(shiftId: string, countedCashCents: number, justification: string | null, idempotencyKey: string): Promise<SellerShift> {
  const response = await apiFetch(`/api/v1/pdv/shifts/${shiftId}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ countedCashCents, justification }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível fechar o turno."));
  const parsed = sellerShiftResponseSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.data) throw new Error("O turno retornou dados inválidos.");
  return parsed.data.data;
}

export async function confirmCashPayment(saleId: string, tenderedCents: number, idempotencyKey: string): Promise<CashPaymentResponse["data"]> {
  const response = await apiFetch(`/api/v1/sales/${saleId}/payments/cash`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ tenderedCents }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível registrar o recebimento em dinheiro."));
  const parsed = cashPaymentResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O recebimento retornou dados inválidos.");
  return parsed.data.data;
}

/** Feature flags the seller can see; a failed load is treated as everything off. */
export async function loadEnabledFeatures(): Promise<Set<string>> {
  const response = await apiFetch("/api/v1/feature-flags");
  if (!response.ok) return new Set();
  const parsed = featureFlagsResponseSchema.safeParse(await response.json());
  return new Set(parsed.success ? parsed.data.data.filter((flag) => flag.enabled).map((flag) => flag.key) : []);
}

/** ADR 0010: asks for a Payment Link; the link itself is created by the jobs worker. */
export async function requestPaymentLink(saleId: string, idempotencyKey: string): Promise<PaymentLinkCharge> {
  const response = await apiFetch(`/api/v1/sales/${saleId}/payments/payment-link`, {
    method: "POST", headers: { "Idempotency-Key": idempotencyKey },
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível pedir o link de pagamento."));
  const parsed = paymentLinkChargeResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O link de pagamento retornou dados inválidos.");
  return parsed.data.data;
}

export async function loadPaymentLink(chargeId: string): Promise<PaymentLinkCharge> {
  const response = await apiFetch(`/api/v1/payments/payment-links/${chargeId}`);
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível consultar o link de pagamento."));
  const parsed = paymentLinkChargeResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O link de pagamento retornou dados inválidos.");
  return parsed.data.data;
}
