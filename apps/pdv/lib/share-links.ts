import {
  attributePdvSaleResponseSchema, sellerShareLinkResponseSchema, sellerShareLinksResponseSchema,
  type CreateShareCampaignRequest, type SellerShareLinksResponse, type ShareCampaign,
} from "@germinatura/contracts";
import { apiFetch } from "@/lib/api";

async function failure(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return new Error(body?.message ?? fallback);
}

/** GROW-002: the seller's own tracked links and the campaigns a sale can come from. */
export async function loadShareLinks(): Promise<SellerShareLinksResponse["data"]> {
  const response = await apiFetch("/api/v1/pdv/share-links");
  if (!response.ok) throw await failure(response, "Não foi possível carregar a divulgação.");
  const parsed = sellerShareLinksResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A divulgação retornou dados inválidos.");
  return parsed.data.data;
}

export async function createShareLink(request: CreateShareCampaignRequest, idempotencyKey: string): Promise<ShareCampaign> {
  const response = await apiFetch("/api/v1/pdv/share-links", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response, "Não foi possível criar o link.");
  const parsed = sellerShareLinkResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("O link retornou dados inválidos.");
  return parsed.data.data;
}

/** Records which campaign brought the customer of a PDV sale. */
export async function attributeSaleOrigin(saleId: string, code: string) {
  const response = await apiFetch(`/api/v1/pdv/sales/${saleId}/origin`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
  });
  if (!response.ok) throw await failure(response, "Não foi possível registrar a origem.");
  const parsed = attributePdvSaleResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("A origem retornou dados inválidos.");
  return parsed.data.data;
}
