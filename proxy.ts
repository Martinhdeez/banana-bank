import { NextRequest, NextResponse } from 'next/server';
// SEC2: per-request nonce CSP for page responses (Next guide "Content Security Policy"). Next reads
// the nonce from the forwarded request CSP and puts it on its own scripts; the page must render
// dynamically (app/layout.tsx awaits connection()). style-src keeps 'unsafe-inline' for React
// style={{…}} attributes, which a nonce cannot cover. Dev adds 'unsafe-eval' (React debug stacks)
// and ws: (HMR). No upgrade-insecure-requests/HSTS: the app is served over plain http.
// SC1: a path that does not percent-decode (`/receipt/%zz`) makes Next's route matcher throw, and
// production answers a bare 500 with no headers or log. Answer it here instead: a 400 (JSON for
// /api), with the static SEC2 headers from next.config.ts, an x-request-id and one access-log line.
// Inline log line (same shape as src/http.ts log()): importing src/http.ts would bundle the DB.
function malformedPath(request: NextRequest) {
  const { pathname } = request.nextUrl;
  try {
    decodeURIComponent(pathname);
    return;
  } catch {}
  const api = pathname.startsWith('/api/');
  const client = request.headers.get('x-request-id');
  const requestId = client && /^[A-Za-z0-9._:-]{1,64}$/.test(client) ? client : crypto.randomUUID();
  console.info(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'info',
      event: api ? 'api_request' : 'page_request',
      requestId,
      method: request.method,
      route: 'malformed-path',
      status: 400,
      ms: 0,
    }),
  );
  const headers = { 'Cache-Control': 'no-store', 'x-request-id': requestId };
  return api
    ? NextResponse.json({ error: 'Invalid request path.' }, { status: 400, headers })
    : new NextResponse(
        '<!doctype html><title>Bad request</title><p>This address is not valid.</p>',
        {
          status: 400,
          headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
        },
      );
}
export function proxy(request: NextRequest) {
  const bad = malformedPath(request);
  if (bad) return bad;
  // SC1: /api reaches the proxy only through the '%' matcher below; no CSP or nonce for it.
  if (request.nextUrl.pathname.startsWith('/api/')) return NextResponse.next();
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}
export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|icon.svg|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
    // SC1: /api stays out of the proxy except for paths with a '%' escape (raw path is matched).
    '/api/:path(.*%.*)',
  ],
};
