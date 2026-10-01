import { managementIndicatorsSchema, type ManagementIndicators } from "@germinatura/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const n = z.coerce.number();
const nullableNumber = z.coerce.number().nullable();

const databaseSchema = z.object({
  period: z.object({ from: z.string(), to: z.string(), days: n, time_zone: z.literal("America/Sao_Paulo") }),
  totals: z.object({
    gross_revenue_cents: n, sale_revenue_cents: n, manual_income_cents: n, refunds_cents: n, fees_cents: n, divergences_cents: n,
    net_revenue_cents: n, cogs_cents: n, cogs_unknown_units: n, losses_cost_cents: n, losses_units: n, losses_unknown_units: n,
    operating_expenses_cents: n, supplier_payments_cents: n, gross_margin_cents: n, gross_margin_bps: nullableNumber,
    operating_profit_cents: n, cash_balance_cents: n, sales_count: n, refunded_sales: n, average_ticket_cents: nullableNumber,
    cost_complete: z.boolean(),
  }),
  by_channel: z.object({ PDV: n, ONLINE: n, RESERVA: n, RIFA: n, EVENTO: n, MANUAL: n }),
  by_payment_method: z.record(z.string(), n),
  refunds_by_payment_method: z.record(z.string(), n),
  expenses_by_category: z.record(z.string(), n),
  top_products: z.array(z.object({
    product_id: z.uuid(), product_name: z.string(), units: n, revenue_cents: n, cost_cents: nullableNumber,
    unknown_cost_units: n, margin_cents: nullableNumber, units_per_day: n,
  })),
  sellers: z.array(z.object({
    seller_id: z.uuid(), seller_name: z.string(), revenue_cents: n, sales_count: n, refunded_count: n, units: n,
    average_ticket_cents: nullableNumber,
  })),
  losses: z.array(z.object({
    product_id: z.uuid(), product_name: z.string(), reason: z.string(), location_id: z.uuid(), location_name: z.string(),
    units: n, cost_cents: nullableNumber, unknown_cost_units: n,
  })),
  daily: z.array(z.object({ day: z.string(), revenue_cents: n, net_revenue_cents: n, cogs_cents: n, gross_margin_cents: n })),
  pending: z.object({ awaiting_payment: n, divergent_reconciliations: n, reopened_closeouts: n, open_payment_recoveries: n, statement_lines_pending: n }),
});

export class IndicatorsError extends Error {
  constructor(readonly code: "FORBIDDEN" | "INVALID_PERIOD" | "UNAVAILABLE") { super(code); }
}

/** ADMIN-001: reads the period indicators computed by the database and maps them to the shared contract. */
export async function loadManagementIndicators(client: SupabaseClient, from: string, to: string): Promise<ManagementIndicators> {
  const { data, error } = await client.rpc("management_indicators", { p_from: from, p_to: to });
  if (error) {
    if (error.message.includes("FINANCE_MANAGE_REQUIRED")) throw new IndicatorsError("FORBIDDEN");
    if (error.message.includes("INVALID_INDICATORS_PERIOD")) throw new IndicatorsError("INVALID_PERIOD");
    throw new IndicatorsError("UNAVAILABLE");
  }
  const parsed = databaseSchema.safeParse(data);
  if (!parsed.success) throw new IndicatorsError("UNAVAILABLE");
  const value = parsed.data;
  const totals = value.totals;
  return managementIndicatorsSchema.parse({
    period: { from: value.period.from, to: value.period.to, days: value.period.days, timeZone: value.period.time_zone },
    totals: {
      grossRevenueCents: totals.gross_revenue_cents, saleRevenueCents: totals.sale_revenue_cents, manualIncomeCents: totals.manual_income_cents,
      refundsCents: totals.refunds_cents, feesCents: totals.fees_cents, divergencesCents: totals.divergences_cents,
      netRevenueCents: totals.net_revenue_cents, cogsCents: totals.cogs_cents, cogsUnknownUnits: totals.cogs_unknown_units,
      lossesCostCents: totals.losses_cost_cents, lossesUnits: totals.losses_units, lossesUnknownUnits: totals.losses_unknown_units,
      operatingExpensesCents: totals.operating_expenses_cents, supplierPaymentsCents: totals.supplier_payments_cents,
      grossMarginCents: totals.gross_margin_cents, grossMarginBps: totals.gross_margin_bps,
      operatingProfitCents: totals.operating_profit_cents, cashBalanceCents: totals.cash_balance_cents,
      salesCount: totals.sales_count, refundedSales: totals.refunded_sales, averageTicketCents: totals.average_ticket_cents,
      costComplete: totals.cost_complete,
    },
    byChannel: value.by_channel,
    byPaymentMethod: value.by_payment_method,
    refundsByPaymentMethod: value.refunds_by_payment_method,
    expensesByCategory: value.expenses_by_category,
    topProducts: value.top_products.map((row) => ({
      productId: row.product_id, productName: row.product_name, units: row.units, revenueCents: row.revenue_cents,
      costCents: row.cost_cents, unknownCostUnits: row.unknown_cost_units, marginCents: row.margin_cents, unitsPerDay: row.units_per_day,
    })),
    sellers: value.sellers.map((row) => ({
      sellerId: row.seller_id, sellerName: row.seller_name, revenueCents: row.revenue_cents, salesCount: row.sales_count,
      refundedCount: row.refunded_count, units: row.units, averageTicketCents: row.average_ticket_cents,
    })),
    losses: value.losses.map((row) => ({
      productId: row.product_id, productName: row.product_name, reason: row.reason, locationId: row.location_id,
      locationName: row.location_name, units: row.units, costCents: row.cost_cents, unknownCostUnits: row.unknown_cost_units,
    })),
    daily: value.daily.map((row) => ({
      day: row.day, revenueCents: row.revenue_cents, netRevenueCents: row.net_revenue_cents, cogsCents: row.cogs_cents,
      grossMarginCents: row.gross_margin_cents,
    })),
    pending: {
      awaitingPayment: value.pending.awaiting_payment, divergentReconciliations: value.pending.divergent_reconciliations,
      reopenedCloseouts: value.pending.reopened_closeouts, openPaymentRecoveries: value.pending.open_payment_recoveries,
      statementLinesPending: value.pending.statement_lines_pending,
    },
  });
}

/** First day of the current São Paulo month and today, as ISO dates. */
export function currentMonthToDate(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
  return { from: `${today.slice(0, 8)}01`, to: today };
}
