import type { NextConfig } from 'next';
// SEC2: static security headers on every response. Page responses also get a nonce CSP from
// proxy.ts, which replaces the minimal CSP below on those paths.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  },
];
const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
export default config;
