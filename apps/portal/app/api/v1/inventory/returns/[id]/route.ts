import { idempotencyKeySchema, resolveStockReturnSchema, stockReturnMutationResponseSchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { returnError, returnFail, returnHeaders, uuidPath } from "../helpers";
export async function PATCH(request: Request, context:{params:Promise<{id:string}>}) {
  const requestId=createRequestId(request.headers);
  try {
    await requirePermission("inventory.return.own"); const {id}=await context.params;
    const key=idempotencyKeySchema.safeParse(request.headers.get("idempotency-key")); const parsed=resolveStockReturnSchema.safeParse(await request.json().catch(()=>null));
    if(!uuidPath(id)||!key.success||!parsed.success||parsed.data.action!=="CANCEL") return returnFail(requestId,"INVALID_STOCK_RETURN","O vendedor somente pode cancelar uma devolução pendente com motivo.",422);
    const client=await createAuthenticatedSupabaseClient(request); const correlationId=crypto.randomUUID();
    const {data,error}=await client.rpc("resolve_stock_return",{p_request_id:id,p_action:"CANCEL",p_reason:parsed.data.reason,p_idempotency_key:key.data,p_correlation_id:correlationId});
    if(error) return returnError(requestId,error);
    const result=stockReturnMutationResponseSchema.safeParse({data:{requestId:data?.request_id,status:data?.status,movementId:data?.movement_id??null,correlationId:data?.correlation_id},request_id:requestId});
    if(!result.success) return returnFail(requestId,"INVENTORY_UNAVAILABLE","Não foi possível confirmar o cancelamento.",503);
    return NextResponse.json(result.data,{headers:returnHeaders(requestId)});
  } catch(error) { if(error instanceof AuthorizationError) return returnFail(requestId,error.status===401?"UNAUTHENTICATED":"FORBIDDEN",error.message,error.status); return returnFail(requestId,"INVENTORY_UNAVAILABLE","Não foi possível cancelar a devolução.",503); }
}
