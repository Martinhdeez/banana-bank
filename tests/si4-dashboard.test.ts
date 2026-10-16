// SI4: the dashboard carries categories and the summary, and never waits for a decider. The alt
// bank (it can inject a movement) and an HTTP stub of the System One wire format (contracts.md
// §6) that answers only when the test lets it. No model is called.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { callApi, setupEnv, startSimulator } from './helpers/bank';

const KEY = 'si4-test-key';
const requests: any[] = [];
let release!: () => void;
const gate = new Promise<void>((r) => (release = r));
const stub = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  await gate;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        category: {
          type: 'choice',
          choice: 'health',
          confidence: 0.93,
          probabilities: { health: 0.95, shopping: 0.05 },
        },
      },
      usage: { input_tokens: 300, output_tokens: 40 },
    }),
  );
});
await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));

const { temp } = await setupEnv('banana-si4-dash-');
Object.assign(process.env, {
  DECIDER: 'systemone',
  DECIDER_API_KEY: KEY,
  DECIDER_BASE_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
});
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
seedApp();
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  stub.closeAllConnections();
  stub.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const inject = (body: unknown) =>
  fetch(`${process.env.BANK_URL}/_control/movement`, {
    method: 'POST',
    headers: { 'x-alt-control': 'alt-control' },
    body: JSON.stringify(body),
  });
const unknownOf = (body: any) =>
  body.movements.find((m: any) => m.description === 'ZZQXV OMEGA').category;

test('SI4 dashboard: every movement has a category and the summary comes from the same read', async () => {
  const { status, body } = await callApi('lucia', 'dashboard');
  assert.equal(status, 200);
  assert.ok(body.movements.length > 0);
  for (const m of body.movements) {
    assert.deepEqual(m.category.movementIds, [m.id]);
    assert.notEqual(m.category.state, 'pending');
    assert.deepEqual(Object.keys(m.category).sort(), [
      'candidates',
      'confidence',
      'id',
      'merchantKey',
      'model',
      'movementIds',
      'reason',
      'source',
      'state',
      'threshold',
    ]);
  }
  assert.equal(body.insights.window.returned, body.movements.length);
  assert.equal('limit' in body.insights.window, false);
  assert.deepEqual([body.insights.pending, body.insights.decider], [0, 'systemone']);
  assert.equal(
    body.insights.unresolved.count,
    body.movements.filter((m: any) => m.category.state === 'needs_review').length,
  );
  assert.equal(requests.length, 0, 'rules and empty merchant keys need no decider');
  // The fields the dashboard had are still there.
  for (const key of ['accounts', 'contacts', 'approvals', 'transfers', 'recipients'])
    assert.ok(key in body, key);
});

test('SI4 dashboard: answers at once while the decider hangs, then shows the decision', async () => {
  assert.equal(
    (await inject({ accountId: 'acc-lucia', amountCents: -1234, description: 'ZZQXV OMEGA' }))
      .status,
    200,
  );
  const started = Date.now();
  const first = await callApi('lucia', 'dashboard');
  const ms = Date.now() - started;
  assert.equal(first.status, 200);
  assert.ok(ms < 500, `dashboard took ${ms} ms`);
  assert.deepEqual(
    [unknownOf(first.body).id, unknownOf(first.body).state, unknownOf(first.body).reason],
    ['other', 'pending', 'pending'],
  );
  assert.equal(first.body.insights.pending, 1);
  assert.equal(
    first.body.insights.categories.some((c: any) => c.id === 'health'),
    false,
  );
  // The page reads again while it waits: still pending, and no second request for the item.
  const second = await callApi('lucia', 'dashboard');
  assert.equal(unknownOf(second.body).state, 'pending');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(requests.length, 1);
  // The provider is told the cleaned text and labels only, and no response carries the key.
  assert.deepEqual(Object.keys(requests[0].state).sort(), [
    'description',
    'direction',
    'occurrences',
    'typical_amount',
    'typical_day',
    'typical_time',
  ]);
  assert.equal(JSON.stringify(second.body).includes(KEY), false);

  release();
  let decided: any;
  for (let i = 0; i < 40 && decided?.state !== 'estimated'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const { body } = await callApi('lucia', 'dashboard');
    decided = { ...unknownOf(body), insights: body.insights };
  }
  assert.deepEqual(
    [decided.id, decided.state, decided.source, decided.model, decided.confidence],
    ['health', 'estimated', 'model', 'systemone:jev-1.13.0', 0.93],
  );
  assert.equal(decided.reason.startsWith('model'), true);
  assert.equal(decided.insights.pending, 0);
  const health = decided.insights.categories.find((c: any) => c.id === 'health');
  assert.deepEqual(
    [health.spentCents, health.estimatedCents, health.confirmedCents],
    [1234, 1234, 0],
  );
  assert.equal(requests.length, 1, 'a stored decision is not asked again');
});

test('SI4 dashboard: another customer and an operator are not affected', async () => {
  const bruno = await callApi('bruno', 'dashboard');
  assert.equal(
    bruno.body.movements.some((m: any) => m.description === 'ZZQXV OMEGA'),
    false,
  );
  const operator = await callApi('marta', 'dashboard');
  assert.equal(operator.status, 200);
  assert.deepEqual(Object.keys(operator.body), ['incidents']);
});

// Last: it stops the bank.
test('SI4 dashboard: with the bank unavailable it fails as before, and asks no decider', async () => {
  bank.kill();
  await new Promise((r) => bank.once('exit', r));
  const { status, body } = await callApi('lucia', 'dashboard');
  assert.equal(status, 504); // the app's answer to an unreachable bank, as before SI4
  assert.equal(typeof body.error, 'string');
  assert.equal('insights' in body, false);
  assert.equal(requests.length, 1);
});
