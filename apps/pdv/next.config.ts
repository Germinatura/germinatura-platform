import type { NextConfig } from "next";

function requiredUrl(name: "NEXT_PUBLIC_PORTAL_URL" | "NEXT_PUBLIC_SUPABASE_URL") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return new URL(value).toString().replace(/\/$/, "");
}

const portalUrl = requiredUrl("NEXT_PUBLIC_PORTAL_URL");
const supabaseUrl = requiredUrl("NEXT_PUBLIC_SUPABASE_URL");

const nextConfig: NextConfig = {
  transpilePackages: ["@germinatura/auth", "@germinatura/contracts"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${portalUrl}/api/:path*` }];
  },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'", "base-uri 'self'", "frame-ancestors 'none'",
            "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:", `connect-src 'self' ${portalUrl} ${supabaseUrl}`,
          ].join("; "),
        },
      ],
    }];
  },
};

export default nextConfig;
