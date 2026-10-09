import { createApiError } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requireSession } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

/**
 * ADR 0011 (PR 5): the active locations and balances the PDV sells from, read inside the PDV's cohort (validated by the
 * proxy). The PDV used to read them straight from the database in the browser, without its cohort.
 */
export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  try {
    await requireSession();
    const client = await createAuthenticatedSupabaseClient(request);
    const [locations, balances] = await Promise.all([
      client.from("stock_locations").select("id,name,location_type").eq("active", true)
        .order("location_type", { ascending: true }).order("name", { ascending: true }),
      client.from("inventory_balances").select("location_id,product_id,on_hand_quantity,reserved_quantity"),
    ]);
    if (locations.error || balances.error) {
      return NextResponse.json(createApiError("INVENTORY_UNAVAILABLE", "Não foi possível carregar a localização e o estoque deste PDV.", requestId), { status: 503, headers });
    }
    return NextResponse.json({ data: { locations: locations.data ?? [], balances: balances.data ?? [] }, request_id: requestId }, { headers });
  } catch (error) {
    const status = error instanceof AuthorizationError ? error.status : 503;
    return NextResponse.json(createApiError(status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : "INVENTORY_UNAVAILABLE",
      "Não foi possível carregar a localização e o estoque deste PDV.", requestId), { status, headers });
  }
}
