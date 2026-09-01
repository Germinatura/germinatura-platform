export type ApiAccessLevel = "public" | "authenticated" | "seller" | "finance" | "admin";

interface ApiAccessRule {
  path: string;
  methods: readonly string[];
  access: ApiAccessLevel;
}

export const apiAccessRules: readonly ApiAccessRule[] = [
  { path: "/api/v1/health", methods: ["GET"], access: "public" },
  { path: "/api/v1/catalog/products", methods: ["GET"], access: "public" },
  { path: "/api/v1/pricing/quote", methods: ["POST"], access: "public" },
  { path: "/api/v1/sales/checkout", methods: ["POST"], access: "authenticated" },
  { path: "/api/v1/sales/:id/cancel", methods: ["POST"], access: "authenticated" },
  { path: "/api/v1/sales/:id/payments/manual-confirmation", methods: ["POST"], access: "seller" },
  { path: "/api/v1/payments/:id/reconciliations", methods: ["POST"], access: "finance" },
  { path: "/api/v1/closeouts", methods: ["POST"], access: "seller" },
  { path: "/api/v1/closeouts/:id/reopen", methods: ["POST"], access: "finance" },
  { path: "/api/v1/reservations", methods: ["POST"], access: "authenticated" },
  { path: "/api/v1/reservations/:id/cancel", methods: ["POST"], access: "authenticated" },
  { path: "/api/v1/reservations/:id/convert", methods: ["POST"], access: "authenticated" },
  { path: "/api/v1/admin/raffles", methods: ["POST"], access: "admin" },
  { path: "/api/v1/admin/raffles/:id/close", methods: ["POST"], access: "admin" },
  { path: "/api/v1/admin/raffles/:id/draw", methods: ["POST"], access: "admin" },
  { path: "/api/v1/raffles/:id/numbers/reserve", methods: ["POST"], access: "authenticated" },
  { path: "/api/v1/raffles/sales/:id/cancel", methods: ["POST"], access: "authenticated" },
  { path: "/api/v1/auth/otp/request", methods: ["POST"], access: "public" },
  { path: "/api/v1/auth/otp/verify", methods: ["POST"], access: "public" },
  { path: "/api/v1/auth/signup/request", methods: ["POST"], access: "public" },
  { path: "/api/v1/auth/signup/verify", methods: ["POST"], access: "public" },
  { path: "/api/v1/auth/signup/complete", methods: ["POST"], access: "public" },
  { path: "/api/v1/auth/password-recovery/request", methods: ["POST"], access: "public" },
  { path: "/api/v1/auth/password-recovery/verify", methods: ["POST"], access: "public" },
  { path: "/api/v1/auth/password-recovery/complete", methods: ["POST"], access: "public" },
  { path: "/api/v1/admin/bootstrap", methods: ["POST"], access: "authenticated" },
  { path: "/api/v1/admin/users", methods: ["POST"], access: "admin" },
  { path: "/api/v1/admin/users/:id/roles", methods: ["PATCH"], access: "admin" },
  { path: "/api/v1/admin/users/:id/password-recovery", methods: ["POST"], access: "admin" },
  { path: "/api/v1/admin/users/:id/signup-code", methods: ["POST"], access: "admin" },
  { path: "/api/auth/login", methods: ["POST"], access: "public" },
  { path: "/api/auth/logout", methods: ["POST"], access: "authenticated" },
  { path: "/api/auth/me", methods: ["GET"], access: "authenticated" },
  { path: "/api/auth/reset-password", methods: ["POST"], access: "authenticated" },
  { path: "/api/v1/auth/session", methods: ["GET"], access: "authenticated" },
];

export function apiAccessRule(path: string): ApiAccessRule | undefined {
  return apiAccessRules.find((rule) => {
    if (rule.path === path) return true;
    if (rule.path === "/api/v1/admin/users/:id/roles") {
      return /^\/api\/v1\/admin\/users\/[0-9a-f-]+\/roles$/i.test(path);
    }
    if (rule.path === "/api/v1/admin/users/:id/password-recovery") {
      return /^\/api\/v1\/admin\/users\/[0-9a-f-]+\/password-recovery$/i.test(path);
    }
    if (rule.path === "/api/v1/admin/users/:id/signup-code") {
      return /^\/api\/v1\/admin\/users\/[0-9a-f-]+\/signup-code$/i.test(path);
    }
    if (rule.path === "/api/v1/sales/:id/cancel") {
      return /^\/api\/v1\/sales\/[0-9a-f-]+\/cancel$/i.test(path);
    }
    if (rule.path === "/api/v1/sales/:id/payments/manual-confirmation") {
      return /^\/api\/v1\/sales\/[0-9a-f-]+\/payments\/manual-confirmation$/i.test(path);
    }
    if (rule.path === "/api/v1/payments/:id/reconciliations") {
      return /^\/api\/v1\/payments\/[0-9a-f-]+\/reconciliations$/i.test(path);
    }
    if (rule.path === "/api/v1/closeouts/:id/reopen") {
      return /^\/api\/v1\/closeouts\/[0-9a-f-]+\/reopen$/i.test(path);
    }
    if (rule.path === "/api/v1/reservations/:id/cancel") {
      return /^\/api\/v1\/reservations\/[0-9a-f-]+\/cancel$/i.test(path);
    }
    if (rule.path === "/api/v1/reservations/:id/convert") {
      return /^\/api\/v1\/reservations\/[0-9a-f-]+\/convert$/i.test(path);
    }
    if (rule.path === "/api/v1/admin/raffles/:id/close") {
      return /^\/api\/v1\/admin\/raffles\/[0-9a-f-]+\/close$/i.test(path);
    }
    if (rule.path === "/api/v1/admin/raffles/:id/draw") {
      return /^\/api\/v1\/admin\/raffles\/[0-9a-f-]+\/draw$/i.test(path);
    }
    if (rule.path === "/api/v1/raffles/:id/numbers/reserve") {
      return /^\/api\/v1\/raffles\/[0-9a-f-]+\/numbers\/reserve$/i.test(path);
    }
    if (rule.path === "/api/v1/raffles/sales/:id/cancel") {
      return /^\/api\/v1\/raffles\/sales\/[0-9a-f-]+\/cancel$/i.test(path);
    }
    return false;
  });
}

export function rolesSatisfyAccess(roles: readonly string[], access: ApiAccessLevel): boolean {
  if (access === "public" || access === "authenticated") return true;
  if (access === "admin") return roles.includes("ADMIN");
  if (access === "finance") return roles.includes("ADMIN") || roles.includes("FINANCEIRO");
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
