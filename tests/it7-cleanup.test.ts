// IT7: the small checks of the round 7 cleanup. The alt bank with the demo seed, the fake OpenAI
// server as the chat model and an HTTP stub of the System One wire format as the decider, with a
// daily budget of one merchant. No model is called.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { call, fakeOpenAI, say, type ModelBody } from './helpers/openai';
import { callApi, setupEnv, startSimulator } from './helpers/bank';
import type { MovementInput } from '../src/insights/taxonomy';

for (const level of ['info', 'warn', 'error'] as const) console[level] = () => {};
// Every merchant it is asked about is `health` at 0.95.
const decider = http.createServer(async (req, res) => {
  for await (const _ of req);
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        category: { choice: 'health', confidence: 0.95, probabilities: { health: 0.95 } },
      },
    }),
  );
});
await new Promise<void>((r) => decider.listen(0, '127.0.0.1', () => r()));

const { temp } = await setupEnv('banana-it7-');
Object.assign(process.env, {
  DECIDER: 'systemone',
  DECIDER_API_KEY: 'it7-test-key',
  DECIDER_BASE_URL: `http://127.0.0.1:${(decider.address() as AddressInfo).port}`,
  DECIDER_DAILY_ITEMS: '1',
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { server, modelRequests, script } = await fakeOpenAI(() => say('OK.'));
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { classifyMovements } = await import('../src/insights/classify');
const { cleanDescription, merchantKey } = await import('../src/insights/normalize');
const { fingerprint, saveCategories, storedCategories } = await import('../src/insights/store');
const { reclassify } = await import('../src/insights/summary');
const { insightsInstructions } = await import('../src/agent/insights');
seedApp();
const bank = await startSimulator('alt');
const link = '.data-it7-link';
after(() => {
  fs.rmSync(link, { force: true });
  bank.kill();
  server.close();
  decider.closeAllConnections();
  decider.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('IT7 item 5: `npm run demo -- --fresh` refuses a directory that is not a demo folder of the repository', () => {
  const marker = `${temp}/app.sqlite`; // this test's own database, outside the repository
  // A link inside the repository by name, outside in fact (removed by the `after` above).
  fs.rmSync(link, { force: true });
  fs.symlinkSync(temp, link);
  for (const dir of ['.', '..', '.data', temp, os.tmpdir(), link]) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/demo.ts', '--fresh'], {
      env: { ...process.env, DEMO_DATA_DIR: dir, DEMO_APP_PORT: '1', DEMO_BANK_PORT: '2' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(run.status, 1, `${dir}: ${run.stderr}`);
    assert.match(run.stderr, /^--fresh refused: /, dir);
    assert.equal(run.stdout, '', `${dir}: nothing was seeded or started`);
  }
  assert.ok(fs.existsSync(marker), 'a refused directory is left as it was');
});

test('IT7 item 6: a generic key is marked in the tool results the model reads, and only there', async () => {
  const injected = await fetch(`${process.env.BANK_URL}/_control/movement`, {
    method: 'POST',
    headers: { 'x-alt-control': 'alt-control' },
    body: JSON.stringify({
      accountId: 'acc-lucia',
      amountCents: -990,
      description: 'Card payment 77',
    }),
  });
  assert.equal(injected.status, 200);
  const { id } = (await callApi('lucia', 'conversations', {})).body;
  script.push(
    () => call('list_unresolved_movements', {}),
    () => call('get_spending_summary', { from: null, to: null }),
    () => say('You have payments with no merchant name to review.'),
  );
  const sent = await callApi('lucia', `conversations/${id}/messages`, { content: 'What is left?' });
  assert.equal(sent.status, 200);
  const last: ModelBody = modelRequests.at(-1)!;
  assert.match(
    last.instructions,
    /genericKey true .* describe it as payments with no merchant name/,
  );
  assert.ok(last.instructions.includes(insightsInstructions));
  const [unresolved, summary] = last.input
    .filter((i) => i.type === 'function_call_output')
    .map((i) => JSON.parse(i.output!));
  const rows = [
    ...unresolved.groups,
    ...summary.unresolved.groups,
    ...summary.categories.flatMap((c: any) => c.movements),
  ];
  const merchant = (row: any) => row.merchant ?? row.merchantKey;
  const generic = rows.filter((row) => merchant(row) === 'CARD PAYMENT');
  assert.equal(generic.length, 3, 'the group in both tools and the movement under Other');
  for (const row of generic) assert.equal(row.genericKey, true);
  const named = rows.filter((row) => merchant(row) !== 'CARD PAYMENT');
  assert.ok(named.length > 5);
  for (const row of named) assert.ok(!('genericKey' in row), merchant(row));
});

test('IT7 item 8: `queued` counts the movements sent, not the ones the daily budget left out', async () => {
  const movements: MovementInput[] = ['ALFA', 'BRAVO'].map((name) => ({
    id: `it7-${name}`,
    accountId: 'acc-it7',
    amountCents: -1250,
    description: `ZZQXV ${name}`,
    createdAt: '2026-09-16T10:00:00.000Z',
  }));
  // Two merchants a decider failed on five minutes ago, never asked today; the budget is one.
  saveCategories(
    'it7-queue',
    movements.map((m) => ({
      movementId: m.id,
      fingerprint: fingerprint(m),
      merchantKey: merchantKey(m.description),
      id: 'other',
      state: 'needs_review',
      source: 'none',
      reason: 'decider_unavailable',
      confidence: null,
      threshold: null,
      candidates: [],
      model: null,
      updatedAt: new Date(Date.now() - 300_000).toISOString(),
    })),
  );
  const view = { accounts: [{ id: 'acc-it7' }], movements, categories: new Map() };
  assert.deepEqual(await reclassify('it7-queue', view), { queued: 1 });
  await classifyMovements({
    userId: 'it7-queue',
    movements,
    ownAccountIds: new Set(['acc-it7']),
    wait: true,
  });
  const rows = storedCategories('it7-queue', movements);
  assert.deepEqual(movements.map((m) => rows.get(m.id)!.source).sort(), ['model', 'none']);
  assert.ok(movements.some((m) => rows.get(m.id)!.reason === 'decider_budget'));
  // Nothing is left to try again: the one over the budget waits for the day to have room.
  assert.deepEqual(await reclassify('it7-queue', view), { queued: 0 });
});

test('IT7 item 7: a run of digit-only tokens does not reach a decider; a lone number does', () => {
  for (const [raw, clean] of [
    ['Bizum Ana 600 123 456', 'BIZUM ANA'], // a phone number in groups
    ['COMPRA 12-09 BAR PEPE', 'COMPRA BAR PEPE'], // a date
    ['100 MONTADITOS SEVILLA', '100 MONTADITOS SEVILLA'], // a lone number is a name
    ['FARMACIA 24H GRAN VIA', 'FARMACIA 24H GRAN VIA'], // a number glued to letters
  ])
    assert.equal(cleanDescription(raw), clean, raw);
  // The merchant key (and the rules) still read the whole description.
  assert.equal(merchantKey('100 MONTADITOS SEVILLA'), '100 MONTADITOS');
});
