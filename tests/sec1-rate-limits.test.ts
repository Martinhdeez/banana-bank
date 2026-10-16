// SEC1: token-bucket rate limits (per minute) on session, transfer, actions, approvals, chat,
// search and preview; 429 + Retry-After, status failed on money routes; RATE_LIMIT_SCALE.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator } from './helpers/bank';
process.env.RATE_LIMIT_SCALE = '1';
const { temp } = await setupEnv('banana-sec1-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { appDb, closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const { GET, POST } = await import('../app/api/[...path]/route');
let bank: ChildProcess;
before(async () => {
  seedBank();
  bank = await startSimulator();
  setScenario('normal');
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const tooMany = 'Too many requests. Wait a moment and try again.';
async function call(route: string, body?: unknown, as?: string, ip = '10.0.0.1') {
  const request = new Request(`http://localhost/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': `${ip}, 10.9.9.9`,
      ...(as ? { cookie: `banana_actor=${sessionToken(as)}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await (body === undefined ? GET : POST)(request, {
    params: Promise.resolve({ path: route.split('/') }),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: (await response.json()) as any,
  };
}
const statuses = async (n: number, f: (i: number) => Promise<{ status: number }>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await f(i)).status);
  return out;
};

// 120, not the plan's 30: e2e runs posted up to 45 sessions/min from one IP (every page load
// re-selects the remembered person, D6), and every local browser shares 127.0.0.1.
test('SEC1: POST /api/session allows 120 per minute per IP, then 429 with Retry-After', async () => {
  const ok = await statuses(120, () => call('session', { userId: 'lucia' }, undefined, '10.1.1.1'));
  assert.deepEqual(new Set(ok), new Set([200]));
  const r = await call('session', { userId: 'lucia' }, undefined, '10.1.1.1');
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { error: tooMany });
  assert.match(r.retryAfter ?? '', /^[1-9]\d*$/);
  assert.equal((await call('session', { userId: 'lucia' }, undefined, '10.1.1.2')).status, 200);
});

test('SEC1: confirm/cancel share one bucket per customer and carry status failed', async () => {
  const misses = await statuses(30, () => call('approvals/nope/confirm', {}, 'bruno'));
  assert.deepEqual(new Set(misses), new Set([404]));
  const r = await call('approvals/nope/cancel', {}, 'bruno');
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { status: 'failed', error: tooMany });
  assert.ok(Number(r.retryAfter) >= 1);
  assert.equal((await call('approvals/nope/confirm', {}, 'carla')).status, 404);
});

test('SEC1: transfer_money is limited separately from other actions and a 429 writes nothing', async () => {
  const intents = () =>
    (appDb().prepare("SELECT COUNT(*) n FROM intents WHERE user_id='lucia'").get() as { n: number })
      .n;
  const before = intents();
  const propose = (i: number) =>
    call(
      'actions',
      {
        name: 'transfer_money',
        arguments: {
          fromAccountId: 'acc-lucia',
          toAccountId: 'acc-carla',
          amountCents: 100 + i,
          concept: `SEC1 ${i}`,
        },
      },
      'lucia',
    );
  const ok = [];
  for (let i = 0; i < 20; i++) ok.push((await propose(i)).body.status);
  assert.deepEqual(new Set(ok), new Set(['requires_confirmation']));
  const r = await propose(20);
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { status: 'failed', error: tooMany });
  assert.equal(intents(), before + 20);
  const list = await call('actions', { name: 'list_accounts', arguments: {} }, 'lucia');
  assert.equal(list.status, 200);
  assert.notEqual(list.body.status, 'failed');
});

test('SEC1: search is limited per actor; other actors are unaffected', async () => {
  // Invalid bodies (400) still take a search token: the limit runs before the handler.
  const bad = await statuses(60, () => call('search', { query: '' }, 'diego'));
  assert.deepEqual(new Set(bad), new Set([400]));
  assert.equal((await call('search', { query: '' }, 'diego')).status, 429);
  assert.equal((await call('search', { query: '' }, 'elena')).status, 400);
});

test('SEC1: tokens refill over time (approvals 30/min = one every 2 s)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await statuses(30, () => call('approvals/nope/confirm', {}, 'ines'));
  const r = await call('approvals/nope/confirm', {}, 'ines');
  assert.equal(r.status, 429);
  assert.equal(r.retryAfter, '2');
  t.mock.timers.tick(2000);
  assert.equal((await call('approvals/nope/confirm', {}, 'ines')).status, 404);
  assert.equal((await call('approvals/nope/confirm', {}, 'ines')).status, 429);
});

test('SEC1: RATE_LIMIT_SCALE parses as a non-negative whole number', () => {
  const load = (value: string) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        `const { config } = await import(${JSON.stringify(path.resolve('src/config.ts'))}); console.log(config.rateLimitScale);`,
      ],
      { cwd: temp, env: { ...process.env, RATE_LIMIT_SCALE: value }, encoding: 'utf8' },
    );
  assert.equal(load('0').stdout.trim(), '0');
  assert.equal(load('100').stdout.trim(), '100');
  const bad = load('abc');
  assert.notEqual(bad.status, 0);
  assert.match(
    bad.stderr,
    /RATE_LIMIT_SCALE must be a whole number \(0 disables rate limits\), got "abc"/,
  );
});
