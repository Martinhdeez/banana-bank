// SEC2: every response carries the static security headers (next.config.ts) and every page
// response a per-request nonce CSP (proxy.ts); /api and static files stay out of the proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import nextConfig from '../next.config';
import { proxy, config } from '../proxy';

test('next.config headers() sends the static security headers on every path', async () => {
  const rules = await nextConfig.headers!();
  const all = rules.find((r) => r.source === '/:path*');
  assert.ok(all, 'a /:path* rule exists');
  const h = Object.fromEntries(all.headers.map(({ key, value }) => [key, value]));
  assert.deepEqual(h, {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy':
      'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy':
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  });
});

test('proxy sets a fresh nonce CSP on the page response and forwards it to Next', () => {
  const csp = (r: ReturnType<typeof proxy>) => r.headers.get('content-security-policy') ?? '';
  const first = proxy(new NextRequest('http://127.0.0.1:3000/'));
  const second = proxy(new NextRequest('http://127.0.0.1:3000/'));
  const nonce = csp(first).match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, 'CSP carries a nonce');
  assert.notEqual(nonce, csp(second).match(/'nonce-([^']+)'/)?.[1], 'nonce changes per request');
  // NextResponse.next({ request: { headers } }) forwards request headers as x-middleware-request-*.
  assert.equal(first.headers.get('x-middleware-request-x-nonce'), nonce);
  assert.equal(first.headers.get('x-middleware-request-content-security-policy'), csp(first));
  for (const part of [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ])
    assert.ok(csp(first).includes(part), `CSP has ${part}`);
  assert.ok(!csp(first).includes('unsafe-eval'), 'no unsafe-eval outside development');
});

test('proxy matcher skips /api, static files and the icon', () => {
  const source = (config.matcher[0] as { source: string }).source;
  const re = new RegExp(`^${source}$`);
  for (const path of ['/api/health', '/_next/static/chunks/a.js', '/_next/image', '/icon.svg'])
    assert.ok(!re.test(path), `${path} skipped`);
  assert.ok(re.test('/'), '/ matched');
});
