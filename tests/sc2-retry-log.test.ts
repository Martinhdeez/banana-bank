// SC2: a transfer attempt that is retried after a 5xx/timeout writes one `transfer_retry` log line
// (request id, intent id, first failure, retry result), never the transfer body.
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
  amountCents: 4242,
  concept: 'Secret concept',
};
const ok = json(200, {
  ...input,
  id: 'op-1',
  userId: 'lucia',
  reference: 'r',
  createdAt: 'now',
  status: 'completed',
});
const timeout = json(504, { error: 'Upstream request timed out' });
const posts: Reply[] = [];
const server = http.createServer((req, res) => {
  const reply = posts.shift() ?? timeout;
  res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const { temp } = await setupEnv('banana-sc2-', (server.address() as any).port);
const { appDb, closeAppDb } = await import('../src/db');
const { dispatchTransfer } = await import('../src/banking/dispatch');
const { requestContext } = await import('../src/http');
after(() => {
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

async function dispatch(t: test.TestContext, intentId: string, replies: Reply[]) {
  appDb()
    .prepare('INSERT INTO intents(id,user_id,payload,status,created_at) VALUES(?,?,?,?,?)')
    .run(intentId, 'lucia', '{}', 'executing', new Date().toISOString());
  posts.splice(0, posts.length, ...replies);
  const warn = t.mock.method(console, 'warn', () => {});
  const ctx = { userId: 'lucia', conversationId: null, runId: 'r', intentId };
  const result = await requestContext
    .run({ requestId: `sc2-${intentId}` }, () => dispatchTransfer(ctx, input))
    .catch((e: Error) => e);
  const lines = warn.mock.calls
    .map((c) => JSON.parse(String(c.arguments[0])))
    .filter((l) => l.event === 'transfer_retry');
  const raw = warn.mock.calls.map((c) => String(c.arguments[0])).join('\n');
  warn.mock.restore();
  return { result, lines, raw };
}

test('SC2: a retry that succeeds logs one transfer_retry line with its outcome', async (t) => {
  const { result, lines, raw } = await dispatch(t, 'sc2-ok', [timeout, ok]);
  assert.equal((result as { status: string }).status, 'completed');
  assert.equal(lines.length, 1);
  assert.deepEqual(
    { ...lines[0], time: undefined },
    {
      time: undefined,
      level: 'warn',
      event: 'transfer_retry',
      requestId: 'sc2-sc2-ok',
      intentId: 'sc2-ok',
      attempt: 2,
      reason: '504 Upstream request timed out',
      outcome: 'completed',
    },
  );
  for (const secret of ['4242', 'Secret concept', 'acc-bruno'])
    assert.ok(!raw.includes(secret), `no ${secret} in the log`);
});

test('SC2: a retry that fails again logs the bank status as its outcome', async (t) => {
  const { result, lines } = await dispatch(t, 'sc2-fail', [timeout, timeout]);
  assert.equal((result as unknown as { status: number }).status, 504);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].outcome, 'bank 504');
  assert.equal(lines[0].requestId, 'sc2-sc2-fail');
});

test('SC2: a first attempt that succeeds or is rejected logs no retry', async (t) => {
  assert.equal((await dispatch(t, 'sc2-first', [ok])).lines.length, 0);
  const rejected = json(422, { error: 'Insufficient funds' });
  assert.equal((await dispatch(t, 'sc2-rejected', [rejected])).lines.length, 0);
});
