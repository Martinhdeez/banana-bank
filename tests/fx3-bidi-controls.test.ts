// FX3: a bidi control (U+202E) in a transfer concept was stored as typed and painted the app's own
// words backwards on the same line. The controls are removed at the input; nothing else is.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { z } from 'zod';
import { setupEnv } from './helpers/bank';
const server = http.createServer((req, res) => {
  const rows =
    req.url === '/v1/accounts'
      ? [{ id: 'acc-lucia', userId: 'lucia', label: 'Aurora account', balanceCents: 1e6 }]
      : [{ id: 'acc-carla', userId: 'carla', name: 'Carla Ríos', label: 'Aurora account' }];
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(rows));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const { temp } = await setupEnv('banana-fx3-', (server.address() as any).port);
const { appDb, closeAppDb } = await import('../src/db');
const { proposeTransfer } = await import('../src/banking/actions');
const { text } = await import('../src/http');
const { stripBidi } = await import('../src/ui-helpers');
const RLO = '\u202E';

test('the sanitizer removes the bidi controls and nothing else', () => {
  assert.equal(
    stripBidi('Rent \u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069October'),
    'Rent October',
  );
  // A right-to-left name with its mark, accents and an emoji joined by U+200D are kept.
  for (const kept of ['محمد علي', 'שלום\u200F!', 'Ríos', '👩‍👩‍👧‍👦']) assert.equal(stripBidi(kept), kept);
  const required = text(z.string().trim().min(1).max(5));
  assert.equal(required.parse(`${RLO}abcde${RLO}`), 'abcde'); // the limit applies after cleaning
  assert.equal(required.safeParse(`${RLO} \u2066`).success, false); // only controls: empty
});

test('a transfer proposed with U+202E in the concept is stored without it', async () => {
  const ctx = { userId: 'lucia', conversationId: null, runId: 'r', intentId: 'i-fx3' };
  const transfer = { fromAccountId: 'acc-lucia', toAccountId: 'acc-carla', amountCents: 1100 };
  const proposed = (await proposeTransfer(ctx, {
    ...transfer,
    concept: `Rent ${RLO}مرحبا`,
  })) as any;
  assert.equal(proposed.approval.concept, 'Rent مرحبا');
  const stored = appDb()
    .prepare('SELECT payload FROM intents UNION ALL SELECT payload FROM approvals')
    .all() as { payload: string }[];
  assert.equal(stored.length, 2);
  for (const row of stored) assert.equal(JSON.parse(row.payload).concept, 'Rent مرحبا');
  // A concept of controls only is the usual "add a description" refusal, and proposes nothing.
  const empty = (await proposeTransfer(
    { ...ctx, intentId: 'i-fx3-b' },
    { ...transfer, concept: RLO },
  )) as any;
  assert.equal(empty.status, 'failed');
  assert.match(empty.error, /short description/);
});
after(() => {
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
