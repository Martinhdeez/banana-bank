// SEC3: session token v2 `<userId>.<issuedAt>.<hmac>` with Max-Age and server-side expiry,
// Secure over https (or COOKIE_SECURE=1), and a graceful 401 for pre-SEC3 or expired cookies.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-sec3-'));
process.env.DATA_DIR = temp;
process.env.RATE_LIMIT_SCALE = '0';
const { closeAppDb } = await import('../src/db');
const { config } = await import('../src/config');
const { sessionToken, sign } = await import('../src/auth');
const { GET, POST } = await import('../app/api/[...path]/route');
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const expired = 'Your session expired. Select a person again.';
const now = () => Math.floor(Date.now() / 1000);
async function select(userId: string, headers: Record<string, string> = {}) {
  const response = await POST(
    new Request('http://localhost/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ userId }),
    }),
    { params: Promise.resolve({ path: ['session'] }) },
  );
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie') || '';
}
async function whoAmI(token: string) {
  const response = await GET(
    new Request('http://localhost/api/session', { headers: { cookie: `banana_actor=${token}` } }),
    { params: Promise.resolve({ path: ['session'] }) },
  );
  return { status: response.status, body: (await response.json()) as any };
}
const tokenOf = (setCookie: string) => /banana_actor=([^;]+)/.exec(setCookie)![1];

test('SEC3: the session cookie has Max-Age, HttpOnly, SameSite=Strict and no Secure over http', async () => {
  const cookie = await select('lucia');
  assert.match(cookie, /Max-Age=43200/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.equal(tokenOf(cookie).split('.').length, 3, 'v2 token: id.issuedAt.signature');
});

test('SEC3: Secure is set over https or with COOKIE_SECURE=1', async () => {
  assert.match(await select('lucia', { 'x-forwarded-proto': 'https' }), /; Secure/);
  config.cookieSecure = true;
  try {
    assert.match(await select('lucia'), /; Secure/);
  } finally {
    config.cookieSecure = false;
  }
});

test('SEC3: each selection issues a new token, both accepted', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const first = tokenOf(await select('lucia'));
  t.mock.timers.tick(1000);
  const second = tokenOf(await select('lucia'));
  assert.notEqual(first, second);
  assert.equal((await whoAmI(first)).body.person.id, 'lucia');
  assert.equal((await whoAmI(second)).body.person.id, 'lucia');
});

test('SEC3: an expired token is refused with a re-select message', async () => {
  const old = await whoAmI(sessionToken('lucia', now() - 43201));
  assert.equal(old.status, 401);
  assert.equal(old.body.error, expired);
  assert.equal((await whoAmI(sessionToken('lucia', now() - 43199))).status, 200);
});

test('SEC3: a pre-SEC3 cookie is refused gracefully', async () => {
  const v1 = await whoAmI(`lucia.${sign('lucia', config.sessionSecret)}`);
  assert.equal(v1.status, 401);
  assert.equal(v1.body.error, expired);
});

test('SEC3: a tampered or future issued-at is invalid', async () => {
  const [id, issuedAt, signature] = sessionToken('lucia').split('.');
  const tampered = await whoAmI(`${id}.${Number(issuedAt) - 100}.${signature}`);
  assert.equal(tampered.status, 401);
  assert.equal(tampered.body.error, 'Invalid session.');
  const future = await whoAmI(sessionToken('lucia', now() + 120));
  assert.equal(future.status, 401);
  assert.equal((await whoAmI(sessionToken('lucia', now() + 30))).status, 200, 'clock skew');
  const fraction = `lucia.1.5`;
  assert.equal((await whoAmI(`${fraction}.${sign(fraction, config.sessionSecret)}`)).status, 401);
  assert.equal((await whoAmI('')).body.error, 'Select a person to continue.');
});
