// IT4 (audit A1, A2): a customer cannot make the app call the paid decider without limit. The
// real route handlers on the alt bank with the demo seed, rate limits on, and an HTTP stub of the
// System One wire format (contracts.md §6) that counts its requests. No model is called.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupEnv, startSimulator } from './helpers/bank';

for (const level of ['info', 'warn', 'error'] as const) console[level] = () => {};
// `… FAIL…` answers 500 while `failing`; every other description is `transport` at 0.97.
const stub = { requests: [] as string[], failing: true };
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const description = String(JSON.parse(raw).state.description);
  stub.requests.push(description);
  if (description.includes('FAIL') && stub.failing) return void res.writeHead(500).end('{}');
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        category: {
          type: 'choice',
          choice: 'transport',
          confidence: 0.97,
          probabilities: { transport: 0.97, shopping: 0.03 },
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));

process.env.RATE_LIMIT_SCALE = '1';
const { temp } = await setupEnv('banana-it4-');
Object.assign(process.env, {
  DECIDER: 'systemone',
  DECIDER_API_KEY: 'it4-test-key',
  DECIDER_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const { bankView } = await import('../src/banking/view');
const { reclassify } = await import('../src/insights/summary');
const { classifyMovements } = await import('../src/insights/classify');
const api = (await import('../app/api/[...path]/route')) as Record<string, any>;
seedApp();
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  server.closeAllConnections();
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

async function call(userId: string, method: 'GET' | 'POST' | 'DELETE', route: string, body?: any) {
  const request = new Request(`http://localhost/api/${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      cookie: `banana_actor=${sessionToken(userId)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await api[method](request, {
    params: Promise.resolve({ path: route.split('/') }),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: (await response.json()) as any,
  };
}
const inject = async (userId: string, description: string) =>
  assert.equal(
    (
      await fetch(`${process.env.BANK_URL}/_control/movement`, {
        method: 'POST',
        headers: { 'x-alt-control': 'alt-control' },
        body: JSON.stringify({ accountId: `acc-${userId}`, amountCents: -1234, description }),
      })
    ).status,
    200,
  );
// Reads the dashboard until no movement is with the decider (a failing run: about 1.5 s).
async function settled(userId: string) {
  for (let i = 0; i < 200; i++) {
    const { body } = await call(userId, 'GET', 'dashboard');
    if (body.insights.pending === 0) return body;
    await sleep(50);
  }
  throw new Error(`${userId}: still pending`);
}
const calls = () => stub.requests.length;
const category = (d: any, description: string) =>
  d.movements.filter((m: any) => m.description === description).map((m: any) => m.category);
const shape = (c: any) => [c.id, c.state, c.source];
const TOO_MANY = { error: 'Too many requests. Wait a moment and try again.' };
const tally = (statuses: number[]) => {
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
  return counts;
};

// ---- normal use costs what it cost before (.scratch/after/fix-it4-decider-cost-control/01-before-measure.txt)

// CAT1: Bruno's ADOBE and CUOTA AUTONOMOS TGSS are Work & projects by rule: ESPAI NOU is his one
// request (PAYPAL *JGARCIA88 has no merchant key and is never sent).
test('IT4 normal use: the first load of the demo personas costs 4 and 1 decider requests, a second load none', async () => {
  const before = calls();
  await settled('lucia');
  assert.equal(calls() - before, 4);
  await settled('bruno');
  assert.equal(calls() - before, 5);
  const d = await settled('lucia');
  assert.equal(calls() - before, 5);
  assert.equal(
    d.movements.filter((m: any) => m.category.reason === 'decider_budget').length,
    0,
    'nothing of a demo persona is over the daily budget',
  );
});

test('IT4 normal use: a new merchant costs one request, and one "Try again" after an outage one more', async () => {
  await settled('ines');
  let before = calls();
  await inject('ines', 'ZZQ NEWSHOP ONE');
  assert.deepEqual(shape(category(await settled('ines'), 'ZZQ NEWSHOP ONE')[0]), [
    'transport',
    'estimated',
    'model',
  ]);
  assert.equal(calls() - before, 1);

  stub.failing = true;
  before = calls();
  await inject('ines', 'ZZQ FAIL OUTAGE');
  assert.equal(category(await settled('ines'), 'ZZQ FAIL OUTAGE')[0].reason, 'decider_unavailable');
  assert.equal(calls() - before, 3, 'the attempt budget of one item');
  // The first "Try again" is not held back by the cool-down, however soon it comes.
  stub.failing = false;
  before = calls();
  assert.deepEqual((await call('ines', 'POST', 'insights/reclassify', {})).body, { queued: 1 });
  assert.deepEqual(shape(category(await settled('ines'), 'ZZQ FAIL OUTAGE')[0]), [
    'transport',
    'estimated',
    'model',
  ]);
  assert.equal(calls() - before, 1);
});

// ---- layer 2: the default daily budget does not get in the way of a real customer

test('IT4 budget: a new customer with 60 distinct merchants is classified in full on the first load', async () => {
  const movements = Array.from({ length: 60 }, (_, i) => ({
    id: `sixty-${i}`,
    accountId: 'acc-sixty',
    amountCents: -1000 - i,
    description: `ZZQXV SHOPQ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}Q`,
    createdAt: '2026-09-16T10:00:00.000Z',
  }));
  const before = calls();
  const result = await classifyMovements({
    userId: 'sixty',
    movements,
    ownAccountIds: new Set(['acc-sixty']),
    wait: true,
  });
  assert.equal(calls() - before, 60);
  assert.ok([...result.values()].every((c) => c.source === 'model'));
});

// ---- layer 3: what was asked is not asked again

test('IT4 A1: ten rule create + delete loops cost no decider request and give the model decision back', async () => {
  await inject('carla', 'ZZQ LOOPSHOP');
  await inject('carla', 'ZZQ LOOPSHOP');
  const first = category(await settled('carla'), 'ZZQ LOOPSHOP');
  assert.deepEqual(first.map(shape), [
    ['transport', 'estimated', 'model'],
    ['transport', 'estimated', 'model'],
  ]);
  const [hand, similar] = first;
  const before = calls();
  for (let i = 0; i < 10; i++) {
    const set = await call('carla', 'POST', 'insights/categories', {
      movementIds: hand.movementIds,
      category: 'shopping',
      applyToSimilar: true,
    });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.rules, [hand.merchantKey]);
    const removed = await call(
      'carla',
      'DELETE',
      `insights/rules/${encodeURIComponent(hand.merchantKey)}`,
    );
    assert.deepEqual(removed.body, { removed: true, reclassified: 1 });
    // The movement the rule had moved is the model's again, in the same answer: not pending.
    const d = (await call('carla', 'GET', 'dashboard')).body;
    const row = d.movements.find((m: any) => m.id === similar.movementIds[0]).category;
    assert.deepEqual(row, similar);
  }
  await settled('carla');
  assert.equal(calls() - before, 0, 'decider requests in ten create + delete loops');
});

test('IT4 normal use: a later movement of a known merchant is still one request (its profile changed)', async () => {
  await inject('omar', 'ZZQ KNOWNSHOP');
  await settled('omar');
  const before = calls();
  await inject('omar', 'ZZQ KNOWNSHOP');
  const rows = category(await settled('omar'), 'ZZQ KNOWNSHOP');
  assert.deepEqual(rows.map(shape), [
    ['transport', 'estimated', 'model'],
    ['transport', 'estimated', 'model'],
  ]);
  assert.equal(calls() - before, 1);
});

// ---- layer 3: "Try again" spam does not multiply the attempt budget

test('IT4 A2: ten reclassify posts on a failing decider spend one attempt budget; a minute later, one more', async () => {
  stub.failing = true;
  await inject('elena', 'ZZQ FAIL ALPHA');
  await inject('elena', 'ZZQ FAIL BETA');
  await settled('elena');
  const before = calls();
  const queued: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = await call('elena', 'POST', 'insights/reclassify', {});
    assert.equal(r.status, 200);
    queued.push(r.body.queued);
    await settled('elena'); // each post finds the previous run finished, as in the audit
  }
  assert.deepEqual(queued, [2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(calls() - before, 6, '2 merchants x 3 attempts, once (was 60)');
  const d = await settled('elena');
  for (const name of ['ZZQ FAIL ALPHA', 'ZZQ FAIL BETA'])
    assert.equal(category(d, name)[0].reason, 'decider_unavailable');

  // The cool-down is one minute from the failure, on an injectable clock.
  const view = await bankView('elena', { classify: 'none' });
  const at = (ms: number) => () => new Date(Date.now() + ms);
  assert.deepEqual(await reclassify('elena', view, at(50_000)), { queued: 0 });
  assert.equal(calls() - before, 6);
  stub.failing = false;
  assert.deepEqual(await reclassify('elena', view, at(61_000)), { queued: 2 });
  const decided = await settled('elena');
  assert.equal(category(decided, 'ZZQ FAIL ALPHA')[0].source, 'model');
  assert.equal(calls() - before, 8);
});

// ---- layer 1: the `insights` rate-limit bucket

test('IT4 A1: of 60 parallel reclassify posts 30 are answered and 30 are refused, with one retry', async () => {
  stub.failing = true;
  await inject('diego', 'ZZQ FAIL PARALLEL');
  await settled('diego');
  const before = calls();
  const all = await Promise.all(
    Array.from({ length: 60 }, () => call('diego', 'POST', 'insights/reclassify', {})),
  );
  assert.deepEqual(tally(all.map((r) => r.status)), { 200: 30, 429: 30 });
  const refused = all.find((r) => r.status === 429)!;
  assert.deepEqual(refused.body, TOO_MANY);
  assert.match(refused.retryAfter ?? '', /^[1-9]\d*$/);
  assert.equal(
    all.reduce((sum, r) => sum + (r.body.queued ?? 0), 0),
    1,
    'one post queued the movement',
  );
  await settled('diego');
  assert.equal(calls() - before, 3, 'one attempt budget for 60 posts');
});

test('IT4 every non-GET insights route shares one bucket of 30 per minute per customer', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const routes = [
    () => call('hugo', 'POST', 'insights/categories', { nope: true }), // 400: still a token
    () => call('hugo', 'DELETE', 'insights/rules/NO%20SUCH%20RULE'),
    () => call('hugo', 'POST', 'insights/reclassify', {}),
  ];
  const ok: number[] = [];
  for (let i = 0; i < 30; i++) ok.push((await routes[i % 3]()).status);
  assert.deepEqual(tally(ok), { 200: 20, 400: 10 });
  for (const route of routes) {
    const r = await route();
    assert.equal(r.status, 429);
    assert.deepEqual(r.body, TOO_MANY);
    assert.equal(r.retryAfter, '2');
  }
  // Reads are not limited, another customer has its own bucket, an operator is refused as before.
  assert.equal((await call('hugo', 'GET', 'insights/rules')).status, 200);
  assert.equal((await call('hugo', 'GET', 'insights/spending')).status, 200);
  assert.equal((await call('omar', 'POST', 'insights/reclassify', {})).status, 200);
  assert.equal((await call('marta', 'POST', 'insights/reclassify', {})).status, 403);
  // 30 per minute: one token every two seconds.
  t.mock.timers.tick(2000);
  assert.equal((await routes[2]()).status, 200);
  assert.equal((await routes[2]()).status, 429);
});

test('IT4 a throttled request writes nothing', async () => {
  const rules = () =>
    (appDb().prepare("SELECT COUNT(*) n FROM category_rules WHERE user_id='hugo'").get() as any).n;
  const d = (await call('hugo', 'GET', 'dashboard')).body;
  const r = await call('hugo', 'POST', 'insights/categories', {
    movementIds: [d.movements[0].id],
    category: 'other',
    applyToSimilar: true,
  });
  assert.equal(r.status, 429);
  assert.equal(rules(), 0);
});
