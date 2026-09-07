import { createApiError } from "@germinatura/contracts";

export interface PortalWorkerBinding {
  fetch(request: Request): Promise<Response>;
}

export function isPortalApiPath(path: string) {
  return path.startsWith("/api/") && path !== "/api/auth/login" && path !== "/api/v1/health";
}

function unavailable(message: string) {
  const requestId = crypto.randomUUID();
  return Response.json(createApiError("PORTAL_UNAVAILABLE", message, requestId), { status: 503, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
}

/** Transport only. Portal remains responsible for Auth, CSRF, RLS and idempotency. */
export async function forwardPortalApi(request: Request, binding: PortalWorkerBinding | undefined, portalUrl: string | undefined): Promise<Response> {
  if (!binding || !portalUrl) return unavailable("Serviço temporariamente indisponível. Tente novamente online.");
  const incoming = new URL(request.url);
  const target = new URL(portalUrl);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  target.hash = "";
  const forwarded = new Request(new Request(target, request), { redirect: "manual" });
  forwarded.headers.delete("host");
  for (const name of [...forwarded.headers.keys()]) {
    if (name.startsWith("x-middleware-") || ["connection", "transfer-encoding", "upgrade"].includes(name)) forwarded.headers.delete(name);
  }
  try {
    // Exactly one attempt, including financial mutations; never replay on reconnection.
    const upstream = await binding.fetch(forwarded);
    const response = new Response(upstream.body, upstream);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return unavailable("Não foi possível consultar o resultado. Reconecte e confira a operação antes de tentar novamente.");
  }
}
