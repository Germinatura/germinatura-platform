import {
  createApiError,
  idempotencyKeySchema,
  saveSupplierResponseSchema,
  saveSupplierSchema,
  supplierQuerySchema,
  suppliersResponseSchema,
} from "@germinatura/contracts";
import { createRequestId } from "@germinatura/observability";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError, requirePermission } from "@/lib/auth";
import { createAuthenticatedSupabaseClient } from "@/lib/authenticated-supabase";

const supplierRowsSchema = z.array(z.object({
  id: z.uuid(), name: z.string(), contact_name: z.string().nullable(), email: z.string().nullable(),
  phone: z.string().nullable(), document: z.string().nullable(), notes: z.string().nullable(),
  active: z.boolean(), revision: z.number().int(), created_at: z.string(), updated_at: z.string(),
}));

const headersFor = (requestId: string) => ({ "Cache-Control": "no-store", "x-request-id": requestId });
const fail = (requestId: string, code: string, message: string, status: number) =>
  NextResponse.json(createApiError(code, message, requestId), { status, headers: headersFor(requestId) });

export async function GET(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("procurement.manage");
    const parsed = supplierQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return fail(requestId, "INVALID_SUPPLIER_QUERY", "Consulta de fornecedores inválida.", 422);
    const client = await createAuthenticatedSupabaseClient(request);
    let query = client.from("suppliers")
      .select("id,name,contact_name,email,phone,document,notes,active,revision,created_at,updated_at")
      .order("name").order("id").limit(500);
    if (parsed.data.status !== "ALL") query = query.eq("active", parsed.data.status === "ACTIVE");
    const { data, error } = await query;
    if (error) return fail(requestId, "PROCUREMENT_UNAVAILABLE", "Não foi possível consultar fornecedores.", 503);
    const rows = supplierRowsSchema.safeParse(data);
    if (!rows.success) return fail(requestId, "PROCUREMENT_UNAVAILABLE", "A consulta retornou dados inválidos.", 503);
    const q = parsed.data.q?.toLocaleLowerCase("pt-BR");
    const mapped = rows.data.map((row) => ({
      id: row.id, name: row.name, contactName: row.contact_name, email: row.email, phone: row.phone,
      document: row.document, notes: row.notes, active: row.active, revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })).filter((row) => !q || `${row.name} ${row.contactName ?? ""} ${row.email ?? ""} ${row.phone ?? ""} ${row.document ?? ""}`.toLocaleLowerCase("pt-BR").includes(q));
    const result = suppliersResponseSchema.safeParse({ data: mapped, request_id: requestId });
    if (!result.success) return fail(requestId, "PROCUREMENT_UNAVAILABLE", "A consulta retornou dados inválidos.", 503);
    return NextResponse.json(result.data, { headers: headersFor(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(requestId, error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail(requestId, "PROCUREMENT_UNAVAILABLE", "Não foi possível consultar fornecedores.", 503);
  }
}

export async function POST(request: Request) {
  const requestId = createRequestId(request.headers);
  try {
    await requirePermission("procurement.manage");
    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    const parsed = saveSupplierSchema.safeParse(await request.json().catch(() => null));
    if (!key.success || !parsed.success) return fail(requestId, "INVALID_SUPPLIER", "Confira cadastro, contato e motivo da alteração.", 422);
    const value = parsed.data;
    const client = await createAuthenticatedSupabaseClient(request);
    const { data, error } = await client.rpc("save_supplier", {
      p_supplier_id: value.id, p_expected_revision: value.expectedRevision, p_name: value.name,
      p_contact_name: value.contactName, p_email: value.email, p_phone: value.phone,
      p_document: value.document, p_notes: value.notes, p_active: value.active, p_reason: value.reason,
      p_idempotency_key: key.data, p_correlation_id: crypto.randomUUID(),
    });
    if (error) {
      if (error.code === "42501") return fail(requestId, "FORBIDDEN", "Permissão insuficiente.", 403);
      if (error.message === "SUPPLIER_NOT_FOUND") return fail(requestId, "SUPPLIER_NOT_FOUND", "Fornecedor não encontrado.", 404);
      if (error.message === "SUPPLIER_REVISION_CONFLICT") return fail(requestId, "SUPPLIER_REVISION_CONFLICT", "Este fornecedor foi alterado em outra sessão. Atualize a lista.", 409);
      if (error.code === "23505") return fail(requestId, "SUPPLIER_DOCUMENT_CONFLICT", "Este documento já pertence a outro fornecedor.", 409);
      if (error.message === "IDEMPOTENCY_CONFLICT" || error.message === "IDEMPOTENCY_IN_PROGRESS") return fail(requestId, error.message, "A solicitação já está em processamento ou foi usada com outro conteúdo.", 409);
      if (error.code === "22023" || error.code === "23514") return fail(requestId, "INVALID_SUPPLIER", "Confira cadastro, contato e motivo da alteração.", 422);
      return fail(requestId, "PROCUREMENT_UNAVAILABLE", "Não foi possível salvar o fornecedor.", 503);
    }
    const result = saveSupplierResponseSchema.safeParse({ data, request_id: requestId });
    if (!result.success) return fail(requestId, "PROCUREMENT_UNAVAILABLE", "Não foi possível confirmar o resultado.", 503);
    return NextResponse.json(result.data, { status: value.id === null ? 201 : 200, headers: headersFor(requestId) });
  } catch (error) {
    if (error instanceof AuthorizationError) return fail(requestId, error.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message, error.status);
    return fail(requestId, "PROCUREMENT_UNAVAILABLE", "Não foi possível salvar o fornecedor.", 503);
  }
}
