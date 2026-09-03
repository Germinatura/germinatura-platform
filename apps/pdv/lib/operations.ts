import {
  manualPaymentConfirmationResponseSchema,
  pricingQuoteResponseSchema,
  publicCatalogProductsResponseSchema,
  sellerCloseoutResponseSchema,
  salesCancelResponseSchema,
  salesCheckoutResponseSchema,
  type ManualPaymentConfirmationResponse,
  type PaymentIntegrationChannel,
  type PricingQuoteResponse,
  type PublicCatalogProduct,
  type SellerCloseoutResponse,
  type SalesCheckoutResponse,
} from "@germinatura/contracts";
import { apiFetch } from "@/lib/api";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { cartPayload } from "./operations-pure";

export { cartPayload, formatMoney } from "./operations-pure";

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

export async function quoteCart(items: CartItem[]): Promise<PricingQuoteResponse["data"]> {
  const response = await apiFetch("/api/v1/pricing/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "PDV", items: cartPayload(items) }),
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
): Promise<SalesCheckoutResponse["data"]> {
  const response = await apiFetch("/api/v1/sales/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ channel: "PDV", locationId, items: cartPayload(items) }),
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
  idempotencyKey: string,
): Promise<ManualPaymentConfirmationResponse["data"]> {
  const response = await apiFetch(`/api/v1/sales/${saleId}/payments/manual-confirmation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ integrationChannel: channel, proofReference }),
  });
  if (!response.ok) throw new Error(await responseError(response, "Não foi possível confirmar o recebimento."));
  const parsed = manualPaymentConfirmationResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A confirmação retornou dados inválidos.");
  return parsed.data.data;
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
