// K6: banking failures are logged server-side, never swallowed silently, and customer text never
// carries the bank's or the app's raw error text. A fake bank; no simulator, no OpenAI calls.
import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { setupEnv } from './helpers/bank';
const { temp, port } = await setupEnv('banana-k6-');
const RAW = 'SQLITE_BUSY: database table is locked (ledger_shard_7)';
const bank = http
  .createServer((req, res) => {
    const send = (status: number, data: unknown) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (req.url === '/v1/accounts')
      return send(200, [
        { id: 'acc-lucia', userId: 'lucia', label: 'Main', iban: 'x', balanceCents: 1e6 },
      ]);
    if (req.url === '/v1/transfers') return send(418, { error: RAW });
    if (req.url?.startsWith('/v1/operations/'))
      return send(200, { id: 'op-k6', reference: 'ref-k6', status: 'completed' });
    send(503, { error: RAW });
  })
  .listen(port, '127.0.0.1');
const { appDb, closeAppDb } = await import('../src/db');
const { transferMoney, recheckPending } = await import('../src/banking/actions');
after(() => {
  bank.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const logged = (fn: ReturnType<typeof mock.method>) =>
  fn.mock.calls.map((c) => JSON.stringify(c.arguments)).join('\n');

test('K6 an unmapped bank rejection reaches the customer in plain words; the bank text is logged', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const result = await transferMoney(
      { userId: 'lucia', conversationId: null, runId: 'run-k6', intentId: 'intent-k6-reject' },
      { fromAccountId: 'acc-lucia', toAccountId: 'acc-bruno', amountCents: 100, concept: 'k6' },
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'The bank rejected the transfer. No money moved.');
    assert.match(logged(warn), /transfer_rejected_unmapped.*SQLITE_BUSY/);
  } finally {
    warn.mock.restore();
  }
});

test('K6 a failed background recheck is logged and stays non-fatal', async () => {
  // One stored payload is corrupt, so its verification throws. The other is confirmed by the bank:
  // its note's contacts read fails (503) and the note's conversation does not exist (FK error).
  const insert = appDb().prepare(
    'INSERT INTO intents(id,user_id,payload,status,bank_reference,created_at) VALUES(?,?,?,?,?,?)',
  );
  const payload = JSON.stringify({
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    amountCents: 100,
    concept: 'k6',
  });
  insert.run(
    'intent-k6-recheck',
    'lucia',
    '{corrupt',
    'pending_verification',
    'ref-k6-a',
    new Date().toISOString(),
  );
  insert.run(
    'intent-k6-note',
    'lucia',
    payload,
    'pending_verification',
    'ref-k6',
    new Date().toISOString(),
  );
  appDb()
    .prepare("UPDATE intents SET conversation_id='conv-missing' WHERE id='intent-k6-note'")
    .run();
  const warn = mock.method(console, 'warn', () => {});
  try {
    await recheckPending('lucia');
    const text = logged(warn);
    assert.match(text, /transfer_recheck_failed.*intent-k6-recheck.*SyntaxError/);
    // The contacts read for the note's names failed too (503): logged, not swallowed.
    assert.match(text, /transfer_note_names_unavailable.*\/v1\/contacts/);
    assert.match(text, /transfer_verify_failed.*intent-k6-note.*FOREIGN KEY/);
  } finally {
    warn.mock.restore();
  }
});
