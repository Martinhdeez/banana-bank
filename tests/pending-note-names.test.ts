// DV7-B: the outcome note written to the chat names the destination from what the proposal
// recorded, not from a live bank read. With the bank unreachable after dispatch, the
// pending-verification note said "to acc-carla" instead of "to Carla Ríos · Aurora account".
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { setupEnv } from './helpers/bank';
let down = false;
const server = http.createServer((req, res) => {
  const reply = (status: number, body: unknown) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  // The bank goes silent once the transfer is sent: the POST times out and every read fails.
  if (req.method === 'POST') {
    down = true;
    return reply(504, { error: 'Upstream request timed out' });
  }
  if (down) return reply(503, { error: 'Bank unavailable.' });
  if (req.url === '/v1/accounts')
    return reply(200, [
      { id: 'acc-lucia', userId: 'lucia', label: 'Aurora account', balanceCents: 1e6 },
    ]);
  if (req.url === '/v1/contacts')
    return reply(200, [
      { id: 'acc-carla', userId: 'carla', name: 'Carla Ríos', label: 'Aurora account' },
    ]);
  reply(404, { error: 'Not found.' });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const { temp } = await setupEnv('banana-pending-note-', (server.address() as any).port);
const { appDb, insert, closeAppDb } = await import('../src/db');
const { proposeTransfer, confirmApproval } = await import('../src/banking/actions');
test('the pending-verification note names the recipient while the bank is down', async () => {
  insert('conversations', {
    id: 'c-note',
    user_id: 'lucia',
    title: 'Note',
    created_at: new Date().toISOString(),
  });
  const ctx = { userId: 'lucia', conversationId: 'c-note', runId: 'r', intentId: 'i-note' };
  const proposed = (await proposeTransfer(ctx, {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-carla',
    amountCents: 1100,
    concept: 'Lunch',
  })) as any;
  assert.equal(proposed.status, 'requires_confirmation');
  const result = await confirmApproval('lucia', proposed.approval.id);
  assert.equal(result.status, 'pending_verification');
  const { content } = appDb()
    .prepare(
      "SELECT content FROM messages WHERE conversation_id='c-note' AND run_id LIKE 'outcome:%'",
    )
    .get() as { content: string };
  assert.match(content, /to Carla Ríos · Aurora account \(Lunch\)/);
  assert.doesNotMatch(content, /acc-carla/);
});
after(() => {
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
