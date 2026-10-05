import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Pin the Turbopack root: a stray package-lock.json exists in the home directory and
// Next.js would otherwise warn about / guess the workspace root.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV === "development";
const isProductionEnv = process.env.APP_ENV === "production";

// Static pages cannot carry per-request nonces, so script-src needs 'unsafe-inline' for the
// inline bootstrap scripts Next.js emits (see node_modules/next/dist/docs/01-app/02-guides/
// content-security-policy.md, "Without Nonces"). Everything else is locked down. Cloudflare
// Turnstile is the only third-party origin allowed.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isProductionEnv ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // Staging and previews must never be indexed. Production relies on robots.ts instead.
  ...(isProductionEnv
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : [{ key: "X-Robots-Tag", value: "noindex, nofollow" }]),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Loaded lazily and only when SENTRY_DSN is set; keep it out of the server bundle.
  serverExternalPackages: ["@sentry/node"],
  typedRoutes: true,
  turbopack: { root: projectRoot },
  // Inlines the (6 KB) stylesheet into the HTML so first paint does not wait for a second round trip.
  // Right for paid-ad landing pages, where nearly every visitor is new (no cached CSS to lose).
  // Experimental in Next 16: if it ever misbehaves, delete this block and nothing else changes.
  experimental: { inlineCss: true },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // API responses can contain per-request state and must never be cached by a CDN.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      // The business dashboard shows personal data and carries one-time sign-in links: never cached, never indexed, and a link's secret is
      // never sent on as a Referer to another site (the sign-in page has no outbound links today; this keeps it that way).
      {
        source: "/dashboard/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      // The operator inbox shows personal data: never cached anywhere, never indexed (also in production).
      {
        source: "/admin/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;
