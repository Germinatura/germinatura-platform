import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const rowsSchema = z.array(z.object({ id: z.uuid(), cohort_id: z.uuid().nullable() }));

/**
 * ADR 0011 (PR 4): the cohort of each record of a page that was already read and authorized, so a consolidated list
 * says which cohort every row belongs to. Same caller and same request scope; a failure leaves the rows unlabeled
 * (the screen shows "—"), never labeled wrongly.
 */
export async function salesCohorts(client: SupabaseClient, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await client.from("sales").select("id,cohort_id").in("id", ids);
  const rows = error ? null : rowsSchema.safeParse(data);
  return new Map(rows?.success ? rows.data.map((row) => [row.id, row.cohort_id]) : []);
}

export async function auditCohorts(client: SupabaseClient, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await client.rpc("audit_log_cohorts", { p_ids: ids });
  const rows = error ? null : rowsSchema.safeParse(data);
  return new Map(rows?.success ? rows.data.map((row) => [row.id, row.cohort_id]) : []);
}
