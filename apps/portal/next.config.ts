import type { NextConfig } from "next";
import { parsePublicEnv } from "@germinatura/config";

const env = parsePublicEnv(process.env);
const pdvUrl = env.NEXT_PUBLIC_PDV_URL;
const pdvOrigin = new URL(pdvUrl).origin;
const supabaseOrigin = new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin;
const scriptSource = process.env.NODE_ENV === "development"
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "object-src 'none'",
      scriptSource,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      `connect-src 'self' ${supabaseOrigin} ${pdvOrigin}`,
      "font-src 'self' data:",
      "worker-src 'self' blob:",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: [
    "@germinatura/auth",
    "@germinatura/config",
    "@germinatura/contracts",
    "@germinatura/observability",
  ],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  async redirects() {
    return [
      { source: "/pdv", destination: pdvUrl, permanent: false },
      { source: "/pdv/:path*", destination: `${pdvUrl}/:path*`, permanent: false },
    ];
  },
};

export default nextConfig;
