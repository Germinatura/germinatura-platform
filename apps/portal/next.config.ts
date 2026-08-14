import type { NextConfig } from "next";
import { parsePublicEnv } from "@germinatura/config";

const env = parsePublicEnv(process.env);
const pdvUrl = env.NEXT_PUBLIC_PDV_URL;
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      `connect-src 'self' ${supabaseUrl} ${pdvUrl}`,
      "font-src 'self' data:",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  transpilePackages: [
    "@germinatura/auth",
    "@germinatura/config",
    "@germinatura/contracts",
    "@germinatura/legacy-db",
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
