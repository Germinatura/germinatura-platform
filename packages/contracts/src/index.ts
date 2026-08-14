import { z } from "zod";

export const appRoleSchema = z.enum(["ADMIN", "VENDEDOR", "CONSUMER"]);
export type AppRole = z.infer<typeof appRoleSchema>;

export const permissionSchema = z.enum([
  "portal.access",
  "admin.access",
  "catalog.read",
  "catalog.manage",
  "inventory.read",
  "inventory.manage",
  "sales.create",
  "sales.read.own",
  "sales.read.all",
  "reservations.manage.own",
  "reservations.manage.all",
  "raffles.buy",
  "raffles.sell",
  "raffles.manage",
  "users.manage",
  "finance.manage",
]);
export type Permission = z.infer<typeof permissionSchema>;

export const sessionUserSchema = z.object({
  id: z.string().min(1),
  authId: z.uuid(),
  email: z.email(),
  name: z.string().min(1),
  role: appRoleSchema,
  roles: z.array(appRoleSchema).min(1),
  legacyUserId: z.string().nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
  request_id: z.string().min(1),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function createApiError(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ApiError {
  return apiErrorSchema.parse({ code, message, request_id: requestId, details });
}

export interface ApiClientOptions {
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export function createApiClient({ getAccessToken, fetchImpl = fetch }: ApiClientOptions) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("Authorization")) {
      const accessToken = await getAccessToken();
      if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    }
    return fetchImpl(input, { ...init, headers, credentials: init.credentials ?? "include" });
  };
}
