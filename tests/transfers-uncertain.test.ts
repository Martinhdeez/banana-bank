// F3 / F8: an uncertain bank outcome is verified by reference, never reported as failed.
// A stub bank with scripted responses stands in for failures the simulator no longer
// produces after F1 (every simulator profile succeeds on the same-reference retry).
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
  amountCents: 8500,
  concept: 'Dinner',
};
const found = (reference: string) =>
  json(200, { ...input, id: `op-${reference}`, userId: 'lucia', reference, status: 'completed' });
// Scripted replies, consumed in order; defaults: POST times out, lookup unavailable.
const script = {
  post: [] as Reply[],
  lookup: [] as ((reference: string) => Reply)[],
};
const server = http.createServer((req, res) => {
  const url = req.url!;
  const reply =
    url === '/v1/accounts'
      ? json(200, [
          { id: 'acc-lucia', userId: 'lucia', label: 'Aurora account', balanceCents: 1e6 },
        ])
      : req.method === 'POST'
        ? script.post.shift() || json(504, { error: 'Upstream request timed out' })
        : (script.lookup.shift() || (() => json(503, { error: 'Query unavailable.' })))(
            decodeURIComponent(url.slice('/v1/operations/'.length)),
          );
  res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const { temp } = await setupEnv('banana-uncertain-', (server.address() as any).port);
const { appDb, closeAppDb } = await import('../src/db');
const { transferMoney } = await import('../src/banking/actions');
const { runTool } = await import('../src/agent/tools');
const ctx = (intentId: string) => ({ userId: 'lucia', conversationId: null, runId: 'r', intentId });
const intent = (id: string) =>
  appDb().prepare('SELECT status,bank_reference FROM intents WHERE id=?').get(id) as {
    status: string;
    bank_reference: string;
  };
test('timeouts after commit are verified as completed, not failed', async () => {
  script.lookup = [found];
  const result = await transferMoney(ctx('i-verified'), input);
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
  assert.equal((result.operation as any).reference, intent('i-verified').bank_reference);
  assert.equal(intent('i-verified').status, 'completed');
});
test('when verification is unavailable the transfer stays pending and never says failed', async () => {
  script.lookup = [];
  const result = await transferMoney(ctx('i-pending'), input);
  assert.equal(result.status, 'pending_verification');
  assert.equal(result.reference, intent('i-pending').bank_reference);
  assert.doesNotMatch(String(result.message), /try again|retry/i);
  assert.match(String(result.message), /do not repeat/i);
  assert.equal(intent('i-pending').status, 'pending_verification');
});
test('a later status check resolves a pending transfer', async () => {
  script.lookup = [found, found, found];
  const result = (await runTool('operation_status', { reference: null }, ctx('x'))) as any;
  const pending = result.transfers.find((t: any) => t.intentId === 'i-pending');
  assert.equal(pending.status, 'completed');
  assert.equal(pending.verified, true);
  assert.equal(intent('i-pending').status, 'completed');
});
// T1: a 404 right after a timeout does not prove absence (see transfers-reliability.test.ts).
test('a 404 right after a timeout is not a verified absence', async () => {
  const missing = () => json(404, { error: 'Operation not found.' });
  script.lookup = [missing, missing, missing];
  const result = await transferMoney(ctx('i-absent'), input);
  assert.equal(result.status, 'pending_verification');
  assert.doesNotMatch(String(result.message), /no money moved/i);
});
const html = (status: number): Reply => ({ status, body: '<html>Bad gateway</html>' });
test('a non-JSON bank error becomes a BankError with its status (F8)', async () => {
  const { bankRequest, BankError } = await import('../src/banking/client');
  script.lookup = [() => html(502)];
  await assert.rejects(bankRequest('lucia', '/v1/operations/x'), (e: unknown) => {
    assert.ok(e instanceof BankError);
    assert.equal(e.status, 502);
    return true;
  });
});
test('a non-JSON response to a transfer is treated as uncertain and verified (F8)', async () => {
  script.post = [html(502), html(502)];
  script.lookup = [found];
  const result = await transferMoney(ctx('i-html'), input);
  assert.equal(result.status, 'completed');
  assert.equal(result.verified, true);
});
after(() => {
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
