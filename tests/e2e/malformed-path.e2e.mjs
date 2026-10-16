// SC1: against a production server (`npm start`; dev already answers 400), a path that does not
// percent-decode is a 400 (JSON for /api) with the SEC2 headers and an x-request-id, not a bare 500.
// Run: APP_URL=http://127.0.0.1:3800 node tests/e2e/malformed-path.e2e.mjs
import { APP_URL as URL } from './env.mjs';
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const secured = (h) =>
  h.get('x-frame-options') === 'DENY' &&
  h.get('x-content-type-options') === 'nosniff' &&
  /frame-ancestors 'none'/.test(h.get('content-security-policy') ?? '');

for (const path of ['/api/transfers/%zz/receipt', '/api/conversations/%zz', '/api/incidents/%zz']) {
  const r = await fetch(URL + path, { headers: { 'x-request-id': 'sc1-e2e' } });
  const body = await r.text();
  check(
    `${path} is a 400 JSON`,
    r.status === 400 && /application\/json/.test(r.headers.get('content-type')),
    `${r.status} ${body.slice(0, 60)}`,
  );
  check(`${path} has SEC2 headers`, secured(r.headers));
  check(`${path} echoes x-request-id`, r.headers.get('x-request-id') === 'sc1-e2e');
}
for (const path of ['/receipt/%zz', '/receipt/%E0%A4%A']) {
  const r = await fetch(URL + path);
  check(
    `${path} is a 400 page`,
    r.status === 400 && /text\/html/.test(r.headers.get('content-type')),
    String(r.status),
  );
  check(
    `${path} has SEC2 headers and a request id`,
    secured(r.headers) && !!r.headers.get('x-request-id'),
  );
}
// Well-formed paths are unchanged: the page keeps its nonce CSP, /api its normal answer.
const page = await fetch(URL + '/');
check(
  '/ keeps the nonce CSP',
  page.ok && /'nonce-/.test(page.headers.get('content-security-policy')),
);
const health = await fetch(URL + '/api/health');
check('/api/health is 200', health.ok && !!health.headers.get('x-request-id'));
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
