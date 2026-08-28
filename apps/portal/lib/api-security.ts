export type ApiAccessLevel = "public" | "authenticated" | "seller" | "admin";

interface ApiAccessRule {
  path: string;
  methods: readonly string[];
  access: ApiAccessLevel;
}

export const apiAccessRules: readonly ApiAccessRule[] = [
  { path: "/api/v1/health", methods: ["GET"], access: "public" },
  { path: "/api/v1/catalog/products", methods: ["GET"], access: "public" },
  { path: "/api/auth/login", methods: ["POST"], access: "public" },
  { path: "/api/auth/logout", methods: ["POST"], access: "authenticated" },
  { path: "/api/auth/me", methods: ["GET"], access: "authenticated" },
  { path: "/api/auth/reset-password", methods: ["POST"], access: "authenticated" },
  { path: "/api/v1/auth/session", methods: ["GET"], access: "authenticated" },
];

export function apiAccessRule(path: string): ApiAccessRule | undefined {
  return apiAccessRules.find((rule) => rule.path === path);
}

export function rolesSatisfyAccess(roles: readonly string[], access: ApiAccessLevel): boolean {
  if (access === "public" || access === "authenticated") return true;
  if (access === "admin") return roles.includes("ADMIN");
  return roles.includes("ADMIN") || roles.includes("VENDEDOR");
}

function configuredOrigins(): Set<string> {
  const values = [
    process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000",
    process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001",
  ];
  return new Set(values.map((value) => new URL(value).origin));
}

export function isTrustedMutation(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  if (authorization && /^Bearer\s+\S+$/.test(authorization)) return true;

  const origin = request.headers.get("origin");
  if (!origin) return false;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;

  try {
    return configuredOrigins().has(new URL(origin).origin);
  } catch {
    return false;
  }
}
