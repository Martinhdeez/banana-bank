// T1–T4, O2, T7: verified transfer status against any bank that implements docs/contracts.md.
// A stub bank with scripted replies produces the 404/409/503 sequences the simulator cannot.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { setupEnv } from './helpers/bank';
type Reply = { status: number; body: string };
const json = (status: number, body: unknown): Reply => ({ status, body: JSON.stringify(body) });
const input = {
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-bruno',
  amountCents: 4200,
  concept: 'Reliability',
};
const found = (reference: string) =>
  json(200, { ...input, id: `op-${reference}`, userId: 'lucia', reference, status: 'completed' });
const missing = () => json(404, { error: 'Operation not found.' });
const unavailable = () => json(503, { error: 'Query unavailable.' });
const timeout = json(504, { error: 'Upstream request timed out' });
// Scripted replies, consumed in order; defaults: POST times out, lookup unavailable.
const script = { post: [] as Reply[], lookup: [] as ((reference: string) => Reply)[] };
const server = http.createServer((req, res) => {
  const url = req.url!;
  const reply =
    url === '/v1/accounts'
      ? json(200, [
          { id: 'acc-lucia', userId: 'lucia', label: 'Aurora account', balanceCents: 1e6 },
        ])
      : req.method === 'POST'
        ? script.post.shift() || timeout
        : (script.lookup.shift() || unavailable)(
            decodeURIComponent(url.slice('/v1/operations/'.length)),
          );
  res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const { temp } = await setupEnv('banana-reliability-', (server.address() as any).port);
const { appDb, closeAppDb } = await import('../src/db');
const { transferMoney } = await import('../src/banking/actions');
const { runTool } = await import('../src/agent/tools');
const ctx = (intentId: string) => ({ userId: 'lucia', conversationId: null, runId: 'r', intentId });
const intent = (id: string) =>
  appDb().prepare('SELECT status,bank_reference FROM intents WHERE id=?').get(id) as {
    status: string;
    bank_reference: string;
  };
const status = async (intentId: string) =>
  (await runTool(
    'operation_status',
    { reference: intent(intentId).bank_reference },
    ctx('q'),
  )) as any;
const backdate = (intentId: string, ms: number, events = true) => {
  const at = new Date(Date.now() - ms).toISOString();
  appDb().prepare('UPDATE intents SET created_at=? WHERE id=?').run(at, intentId);
  if (events)
    appDb()
      .prepare("UPDATE events SET created_at=? WHERE json_extract(data,'$.intentId')=?")
      .run(at, intentId);
};
test('T1: a 404 right after a timeout keeps the transfer pending', async () => {
  script.post = [timeout, timeout];
  script.lookup = [missing, missing, missing];
  const result = await transferMoney(ctx('t1-pending'), input);
  assert.equal(result.status, 'pending_verification');
  assert.match(String(result.message), /do not repeat/i);
  assert.doesNotMatch(String(result.message), /no money moved/i);
  assert.equal(intent('t1-pending').status, 'pending_verification');
});
test('T1: a lookup that is unavailable then found completes in the same call', async () => {
  script.post = [timeout, timeout];
  script.lookup = [unavailable, found];
  const result = await transferMoney(ctx('t1-retry-lookup'), input);
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
});
test('T1: absence is accepted only after the signature window', async () => {
  script.lookup = [missing];
  assert.equal((await status('t1-pending')).status, 'pending_verification');
  // The window runs from the last (re-signed) attempt, not from the dispatch start.
  backdate('t1-pending', 3 * 60_000, false);
  script.lookup = [missing];
  assert.equal((await status('t1-pending')).status, 'pending_verification');
  backdate('t1-pending', 3 * 60_000);
  script.lookup = [missing];
  const result = await status('t1-pending');
  assert.equal(result.status, 'failed');
  assert.equal(result.verified, true);
  assert.match(String(result.error), /no money moved/);
});
test('T2: a completed transfer stays verified when the re-lookup is unavailable', async () => {
  script.post = [found('x')];
  assert.equal((await transferMoney(ctx('t2-done'), input)).status, 'completed');
  script.lookup = [unavailable];
  const result = await status('t2-done');
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
});
test('T2: a later 404 never downgrades a completed transfer', async () => {
  script.lookup = [missing];
  backdate('t2-done', 3 * 60_000);
  const result = await status('t2-done');
  assert.equal(result.status, 'completed');
  assert.equal(intent('t2-done').status, 'completed');
});
test('T3: a 409 on the retry after a timeout is verified, not failed', async () => {
  script.post = [
    timeout,
    json(409, { error: 'The reference already belongs to a different operation.' }),
  ];
  script.lookup = [found];
  const result = await transferMoney(ctx('t3-conflict'), input);
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
});
test('T3: a 4xx on the retry after a timeout without a record stays pending', async () => {
  script.post = [timeout, json(422, { error: 'Insufficient funds.' })];
  script.lookup = [missing, missing, missing];
  const result = await transferMoney(ctx('t3-pending'), input);
  assert.equal(result.status, 'pending_verification');
  assert.equal(intent('t3-pending').status, 'pending_verification');
});
test('T3: a first-attempt 409 is still a failure', async () => {
  script.post = [json(409, { error: 'conflict' })];
  const result = await transferMoney(ctx('t3-definitive'), input);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'conflict');
});
test('O2: a dispatch retry records a transfer.retry event with attempt and reason', async () => {
  script.post = [timeout, found('x')];
  const result = await transferMoney(ctx('o2-retry'), input);
  assert.equal(result.status, 'completed');
  const events = appDb()
    .prepare("SELECT data FROM events WHERE kind='transfer.retry' AND data LIKE ?")
    .all('%o2-retry%') as { data: string }[];
  assert.equal(events.length, 1);
  const data = JSON.parse(events[0].data);
  assert.equal(data.attempt, 2);
  assert.match(data.reason, /504/);
  assert.doesNotMatch(events[0].data, /signature|secret/i);
});
test('T7: an unknown 400 is not explained with a guessed reason', async () => {
  script.post = [json(400, { error: 'Invalid concept.' })];
  const result = await transferMoney(ctx('t7-400'), input);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid_request');
  assert.doesNotMatch(String(result.error), /destination|amount between/);
  assert.match(String(result.error), /No money moved/);
});
// T4: the state a restart leaves behind: reference saved, POST outcome never recorded.
function stuckIntent(id: string, consumedMsAgo: number) {
  const db = appDb(),
    at = new Date(Date.now() - consumedMsAgo).toISOString();
  db.prepare('INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    id,
    'lucia',
    null,
    'r',
    JSON.stringify(input),
    'processing',
    `ref-${id}`,
    null,
    null,
    at,
  );
  db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?)').run(
    `approval-${id}`,
    'lucia',
    id,
    JSON.stringify(input),
    new Date(Date.now() + 60_000).toISOString(),
    at,
  );
}
test('T4: a stale processing intent is reconciled through its saved reference', async () => {
  stuckIntent('t4-stuck', 60_000);
  script.lookup = [found];
  const result = await status('t4-stuck');
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
  assert.equal(intent('t4-stuck').status, 'completed');
});
test('T4: a repeated confirm of a stale processing intent verifies it', async () => {
  const { confirmApproval } = await import('../src/banking/actions');
  stuckIntent('t4-confirm', 60_000);
  script.lookup = [found];
  const result = await confirmApproval('lucia', 'approval-t4-confirm');
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
});
test('T4: a fresh processing intent is still reported as processing', async () => {
  const { confirmApproval } = await import('../src/banking/actions');
  stuckIntent('t4-live', 0);
  assert.equal((await confirmApproval('lucia', 'approval-t4-live')).status, 'processing');
});
after(() => {
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
