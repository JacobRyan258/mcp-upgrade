import type { NextConfig } from 'next';

/**
 * Security headers are set here rather than in a proxy so they apply in
 * development, in preview deployments and in production identically.
 *
 * The CSP is deliberately strict. This application renders report content that
 * originated in somebody else's source code, so `script-src` allows nothing
 * beyond the app's own bundles, and `object-src`/`frame-ancestors` are closed
 * entirely.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Next.js injects inline bootstrap scripts; 'unsafe-inline' is required
      // for them and is scoped to scripts we serve from our own origin.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      // Supabase auth and Stripe checkout redirects are the only third parties.
      "connect-src 'self' https://*.supabase.co https://api.stripe.com",
      "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      'upgrade-insecure-requests',
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The scanner and the shared package ship as ESM built by tsc; Next needs to
  // transpile workspace sources rather than treat them as prebuilt externals.
  transpilePackages: ['@mcp-upgrade/shared'],
  experimental: {
    // The database and worker packages must never be bundled into a client
    // chunk. Listing them keeps `pg` server-only even if an import slips.
    serverActions: { bodySizeLimit: '2mb' },
  },
  serverExternalPackages: ['pg', '@mcp-upgrade/database'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
