import { picpayEvidenceOverviewSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { cohortAdminFailure, requireAdminMaster } from "@/lib/cohort-admin";

const storedSchema = z.object({
  imports: z.number().int(), last_period_to: z.string().nullable(), inflow_cents: z.number().int(), outflow_cents: z.number().int(),
  lines: z.number().int(), lines_pending: z.number().int(), lines_global: z.number().int(),
  lines_by_cohort: z.array(z.object({ cohort_id: z.uuid(), lines: z.number().int() })),
});

/**
 * ADR 0011 (PR 4): the shared PicPay account evidence (statement imports and lines), global by nature. Lines are counted
 * by the cohort their classification was attributed to; no per-cohort balance is derived from the statement.
 */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requireAdminMaster();
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("picpay_evidence_overview");
    if (error) throw error;
    const stored = storedSchema.parse(data);
    return NextResponse.json({
      data: picpayEvidenceOverviewSchema.parse({
        imports: stored.imports, lastPeriodTo: stored.last_period_to, inflowCents: stored.inflow_cents, outflowCents: stored.outflow_cents,
        lines: stored.lines, linesPending: stored.lines_pending, linesGlobal: stored.lines_global,
        linesByCohort: stored.lines_by_cohort.map((item) => ({ cohortId: item.cohort_id, lines: item.lines })),
      }),
      request_id: requestId,
    }, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    return cohortAdminFailure(error, requestId, "Não foi possível consultar a evidência PicPay.");
  }
}
