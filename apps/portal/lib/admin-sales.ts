import { adminSaleDetailSchema, adminSaleSchema, createApiError } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

// Summary returned by private.sale_admin_summary (list rows and the head of the detail).
export const databaseAdminSaleSchema = z.object({
  sale_id: z.uuid(), status: z.string(), channel: z.string(), created_at: z.string(),
  location_id: z.uuid(), location_name: z.string(), seller_id: z.uuid(), seller_name: z.string(),
  original_total_cents: z.number().int(), discount_total_cents: z.number().int(), total_cents: z.number().int(),
  pending_reason: z.string().nullable(),
  payment: z.object({
    attempt_id: z.uuid(), status: z.string(), integration_channel: z.string().nullable(),
    confirmation_source: z.string().nullable(), confirmed_at: z.string().nullable(), proof_reference: z.string().nullable(),
    card_method: z.string().nullable(), terminal_code: z.string().nullable(),
  }).nullable(),
});

export const databaseAdminSaleDetailSchema = databaseAdminSaleSchema.extend({
  items: z.array(z.object({
    product_name: z.string(), product_sku: z.string(), quantity: z.number().int(),
    unit_price_cents: z.number().int(), discount_cents: z.number().int(), total_cents: z.number().int(),
  })).nullable(),
  ledger: z.array(z.object({
    id: z.uuid(), entry_type: z.string(), amount_cents: z.number().int(), created_at: z.string(),
    refund_method: z.string().nullable(), reference: z.string().nullable(),
  })),
  cash_movements: z.array(z.object({
    id: z.uuid(), movement_type: z.string(), amount_cents: z.number().int(), shift_id: z.uuid(), created_at: z.string(),
  })),
  history: z.array(z.object({
    from_status: z.string().nullable(), to_status: z.string(), reason: z.string().nullable(), created_at: z.string(),
  })),
  reversal: z.object({ allowed: z.boolean(), blocked_reason: z.string().nullable(), cash_payout_allowed: z.boolean() }),
  raffle: z.object({ campaign_id: z.uuid(), campaign_name: z.string(), campaign_status: z.string(), numbers: z.array(z.number().int()).nullable() }).nullable(),
});

function summary(value: z.infer<typeof databaseAdminSaleSchema>) {
  return {
    saleId: value.sale_id, status: value.status, channel: value.channel, createdAt: value.created_at,
    locationId: value.location_id, locationName: value.location_name, sellerId: value.seller_id, sellerName: value.seller_name,
    originalTotalCents: value.original_total_cents, discountTotalCents: value.discount_total_cents, totalCents: value.total_cents,
    pendingReason: value.pending_reason,
    payment: value.payment && {
      attemptId: value.payment.attempt_id, status: value.payment.status, integrationChannel: value.payment.integration_channel,
      confirmationSource: value.payment.confirmation_source, confirmedAt: value.payment.confirmed_at,
      proofReference: value.payment.proof_reference, cardMethod: value.payment.card_method, terminalCode: value.payment.terminal_code,
    },
  };
}

export const toAdminSale = (value: z.infer<typeof databaseAdminSaleSchema>) => adminSaleSchema.parse(summary(value));

export function toAdminSaleDetail(value: z.infer<typeof databaseAdminSaleDetailSchema>) {
  return adminSaleDetailSchema.parse({
    ...summary(value),
    items: (value.items ?? []).map((item) => ({
      productName: item.product_name, productSku: item.product_sku, quantity: item.quantity,
      unitPriceCents: item.unit_price_cents, discountCents: item.discount_cents, totalCents: item.total_cents,
    })),
    ledger: value.ledger.map((entry) => ({
      id: entry.id, entryType: entry.entry_type, amountCents: entry.amount_cents, createdAt: entry.created_at,
      refundMethod: entry.refund_method, reference: entry.reference,
    })),
    cashMovements: value.cash_movements.map((movement) => ({
      id: movement.id, movementType: movement.movement_type, amountCents: movement.amount_cents,
      shiftId: movement.shift_id, createdAt: movement.created_at,
    })),
    history: value.history.map((entry) => ({
      fromStatus: entry.from_status, toStatus: entry.to_status, reason: entry.reason, createdAt: entry.created_at,
    })),
    reversal: {
      allowed: value.reversal.allowed, blockedReason: value.reversal.blocked_reason,
      cashPayoutAllowed: value.reversal.cash_payout_allowed,
    },
    raffle: value.raffle && { campaignId: value.raffle.campaign_id, campaignName: value.raffle.campaign_name,
      campaignStatus: value.raffle.campaign_status, numbers: value.raffle.numbers ?? [] },
  });
}

export function adminSalesErrorResponse(code: string, message: string, requestId: string, status: number) {
  return NextResponse.json(createApiError(code, message, requestId), {
    status, headers: { "Cache-Control": "no-store", "x-request-id": requestId },
  });
}
