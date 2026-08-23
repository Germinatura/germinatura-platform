import type { NextConfig } from "next";

function requiredOrigin(name: "NEXT_PUBLIC_PORTAL_URL" | "NEXT_PUBLIC_SUPABASE_URL") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return new URL(value).origin;
}

const portalUrl = requiredOrigin("NEXT_PUBLIC_PORTAL_URL");
const supabaseUrl = requiredOrigin("NEXT_PUBLIC_SUPABASE_URL");
const scriptSource = process.env.NODE_ENV === "development"
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
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
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'", "object-src 'none'",
            scriptSource, "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:", `connect-src 'self' ${portalUrl} ${supabaseUrl}`,
            "font-src 'self' data:", "worker-src 'self' blob:",
          ].join("; "),
        },
      ],
    }];
  },
};

export default nextConfig;
