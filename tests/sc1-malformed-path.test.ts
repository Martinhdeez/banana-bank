// SC1: a path that does not percent-decode gets a 400 from proxy.ts (JSON for /api) with an
// x-request-id and one access-log line, instead of Next's bare production 500. The production
// reproduction against a running server is tests/e2e/malformed-path.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import * as staticInfo from 'next/dist/build/analysis/get-page-static-info.js';
import { getMiddlewareRouteMatcher } from 'next/dist/shared/lib/router/utils/middleware-route-matcher.js';
import { proxy, config } from '../proxy';

// Next compiles proxy matchers with this (runtime export, not in its .d.ts).
const { getMiddlewareMatchers } = staticInfo as unknown as {
  getMiddlewareMatchers: (matcher: unknown, nextConfig: object) => never;
};

const run = (path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(`http://127.0.0.1:3000${path}`, { headers }));

test('SC1: a malformed /api path is a 400 JSON with an x-request-id and one access-log line', async (t) => {
  const info = t.mock.method(console, 'info', () => {});
  for (const path of ['/api/transfers/%zz/receipt', '/api/conversations/%E0%A4%A']) {
    const r = run(path);
    assert.equal(r.status, 400, path);
    assert.match(r.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await r.json(), { error: 'Invalid request path.' });
    assert.match(r.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('content-security-policy'), null, 'no page CSP on /api');
  }
  assert.equal(info.mock.callCount(), 2);
  const line = JSON.parse(info.mock.calls[0].arguments[0] as string);
  assert.equal(line.event, 'api_request');
  assert.equal(line.status, 400);
  assert.equal(line.route, 'malformed-path');
  assert.ok(!JSON.stringify(line).includes('%zz'), 'the raw path is not logged');
  assert.equal(
    run('/api/x/%zz', { 'x-request-id': 'trace-1' }).headers.get('x-request-id'),
    'trace-1',
  );
});

test('SC1: a malformed page path is a 400 HTML page', async (t) => {
  const info = t.mock.method(console, 'info', () => {});
  const r = run('/receipt/%zz');
  assert.equal(r.status, 400);
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await r.text(), /Bad request/);
  assert.ok(r.headers.get('x-request-id'));
  assert.equal(JSON.parse(info.mock.calls[0].arguments[0] as string).event, 'page_request');
});

test('SC1: well-formed paths are unchanged (pages get the CSP, /api passes through)', () => {
  assert.match(run('/receipt/abc').headers.get('content-security-policy') ?? '', /'nonce-/);
  const api = run('/api/files/a%20b');
  assert.equal(api.headers.get('x-middleware-next'), '1');
  assert.equal(api.headers.get('content-security-policy'), null);
});

test('SC1: the matcher sends malformed /api paths to the proxy and keeps the rest of /api out', () => {
  const match = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, {}));
  const req = { headers: {} } as never;
  for (const path of ['/api/transfers/%zz/receipt', '/api/incidents/%zz', '/receipt/%zz', '/'])
    assert.ok(match(path, req, {}), `${path} reaches the proxy`);
  for (const path of ['/api/health', '/api/approvals/abc/confirm', '/_next/static/chunks/a.js'])
    assert.ok(!match(path, req, {}), `${path} skips the proxy`);
});
