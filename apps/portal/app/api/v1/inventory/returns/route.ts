import { idempotencyKeySchema, requestStockReturnSchema, stockReturnMutationResponseSchema, stockReturnQuerySchema } from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";
import { mapContext, returnError, returnFail, returnHeaders } from "./helpers";
export async function GET(request: Request) {
  const requestId=createRequestId(request.headers);
  try {
    await requirePermission("inventory.return.own");
    const parsed=stockReturnQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if(!parsed.success) return returnFail(requestId,"INVALID_RETURN_QUERY","Consulta de devoluções inválida.",422);
    const client=await createAuthenticatedSupabaseClient(request);
    const {data,error}=await client.rpc("get_stock_returns",{p_cursor:parsed.data.cursor??null,p_limit:parsed.data.limit});
    if(error) return returnError(requestId,error);
    const result=mapContext(data,requestId);
    if(!result.success) return returnFail(requestId,"INVENTORY_UNAVAILABLE","A consulta de devoluções retornou dados inválidos.",503);
    return NextResponse.json(result.data,{headers:returnHeaders(requestId)});
  } catch(error) { if(error instanceof AuthorizationError) return returnFail(requestId,error.status===401?"UNAUTHENTICATED":"FORBIDDEN",error.message,error.status); return returnFail(requestId,"INVENTORY_UNAVAILABLE","Não foi possível carregar as devoluções.",503); }
}
export async function POST(request: Request) {
  const requestId=createRequestId(request.headers);
  try {
    await requirePermission("inventory.return.own");
    const key=idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed=requestStockReturnSchema.safeParse(await request.json().catch(()=>null));
    if(!key.success||!parsed.success) return returnFail(requestId,"INVALID_STOCK_RETURN","Confira produto, quantidade e motivo.",422);
    const client=await createAuthenticatedSupabaseClient(request); const correlationId=crypto.randomUUID();
    const {data,error}=await client.rpc("request_stock_return",{p_product_id:parsed.data.productId,p_quantity:parsed.data.quantity,p_reason:parsed.data.reason,p_idempotency_key:key.data,p_correlation_id:correlationId});
    if(error) return returnError(requestId,error);
    const result=stockReturnMutationResponseSchema.safeParse({data:{requestId:data?.request_id,status:data?.status,correlationId:data?.correlation_id},request_id:requestId});
    if(!result.success) return returnFail(requestId,"INVENTORY_UNAVAILABLE","Não foi possível confirmar a devolução.",503);
    return NextResponse.json(result.data,{status:201,headers:returnHeaders(requestId)});
  } catch(error) { if(error instanceof AuthorizationError) return returnFail(requestId,error.status===401?"UNAUTHENTICATED":"FORBIDDEN",error.message,error.status); return returnFail(requestId,"INVENTORY_UNAVAILABLE","Não foi possível solicitar a devolução.",503); }
}
