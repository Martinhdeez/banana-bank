// FX1: "Customer-facing status should match verified facts." A `failed` intent that carries a bank
// reference and that neither a bank rejection nor a lookup vouches for (the seeded
// intent-historic-lucia) is looked up when the customer's transfers or its receipt are read, once.
// A fake bank that counts the lookups; no simulator, no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { setupEnv, callApi } from './helpers/bank';
const { temp, port } = await setupEnv('banana-fx1-');
const lookups: Record<string, number> = {};
const bank = http
  .createServer((req, res) => {
    const send = (status: number, data: unknown) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    const reference = req.url?.match(/^\/v1\/operations\/(.+)$/)?.[1];
    if (!reference) return send(200, []);
    lookups[reference] = (lookups[reference] ?? 0) + 1;
    // ref-fx1-ok-flip: found by the first lookup, a late 404 for the second (an inconsistent bank).
    if (reference === 'ref-fx1-ok-flip' && lookups[reference] > 1)
      return void setTimeout(() => send(404, { error: 'x' }), 50);
    if (reference === 'ref-historic-lucia' || reference.startsWith('ref-fx1-ok-'))
      return send(200, {
        id: reference.replace('ref-', 'op-'),
        reference,
        status: 'completed',
        createdAt: '2026-09-23T16:41:13.000Z',
      });
    send(reference === 'ref-fx1-down' ? 503 : 404, { error: 'x' });
  })
  .listen(port, '127.0.0.1');
const { appDb, closeAppDb } = await import('../src/db');
const { seedApp } = await import('../src/seed');
seedApp();
after(() => {
  bank.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const failed = (id: string, userId: string, reference: string | null) =>
  appDb()
    .prepare(
      "INSERT INTO intents(id,user_id,payload,status,bank_reference,error,created_at) VALUES(?,?,?,'failed',?,'No response received from the bank.',?)",
    )
    .run(
      id,
      userId,
      JSON.stringify({
        fromAccountId: `acc-${userId}`,
        toAccountId: 'acc-carla',
        amountCents: 100,
        concept: 'fx1',
      }),
      reference,
      new Date().toISOString(),
    );
const shown = async (userId: string, intentId: string) => {
  const { status, body } = await callApi(userId, 'dashboard');
  assert.equal(status, 200);
  return body.transfers.find((t: { intentId: string }) => t.intentId === intentId).status;
};
const receipt = (userId: string, intentId: string) =>
  callApi(userId, `transfers/${intentId}/receipt`);

test('FX1 the seeded failed intent with a reference reads as completed, with one bank lookup', async () => {
  assert.equal(await shown('lucia', 'intent-historic-lucia'), 'completed');
  assert.equal(await shown('lucia', 'intent-historic-lucia'), 'completed');
  assert.equal(await shown('lucia', 'intent-historic-lucia'), 'completed');
  assert.equal(lookups['ref-historic-lucia'], 1);
  // The same record the chat path writes: the step of the timelines and of the operator's case.
  const events = appDb()
    .prepare("SELECT data FROM events WHERE kind='transfer.verified'")
    .all() as { data: string }[];
  assert.deepEqual(
    events.map((e) => JSON.parse(e.data)),
    [
      {
        status: 'completed',
        from: 'failed',
        intentId: 'intent-historic-lucia',
        executedAt: '2026-09-23T16:41:13.000Z',
      },
    ],
  );
});

test('FX1 its receipt is served', async () => {
  const { status, body } = await receipt('lucia', 'intent-historic-lucia');
  assert.equal(status, 200);
  assert.equal(body.status, 'completed');
  assert.equal(body.operationId, 'op-historic-lucia');
});

test('FX1 the receipt alone verifies it', async () => {
  appDb()
    .prepare(
      "UPDATE intents SET status='failed',operation_id=NULL WHERE id='intent-historic-lucia'",
    )
    .run();
  appDb().prepare("DELETE FROM events WHERE kind='transfer.verified'").run();
  assert.equal((await receipt('lucia', 'intent-historic-lucia')).status, 200);
});

test('FX1 failed with no reference, or rejected by the bank: no bank lookup', async () => {
  failed('intent-fx1-unsent', 'bruno', null);
  failed('intent-fx1-rejected', 'bruno', 'ref-fx1-rejected');
  appDb()
    .prepare(
      "INSERT INTO events(id,run_id,user_id,kind,data,created_at) VALUES('ev-fx1','run-fx1','bruno','transfer.failed',?,?)",
    )
    .run(
      JSON.stringify({ status: 'failed', intentId: 'intent-fx1-rejected' }),
      new Date().toISOString(),
    );
  assert.equal(await shown('bruno', 'intent-fx1-unsent'), 'failed');
  assert.equal(await shown('bruno', 'intent-fx1-rejected'), 'failed');
  assert.equal((await receipt('bruno', 'intent-fx1-rejected')).status, 409);
  assert.deepEqual(Object.keys(lookups), ['ref-historic-lucia']);
});

test('FX1 the bank has no such operation: it stays failed and is not looked up again', async () => {
  failed('intent-fx1-absent', 'hugo', 'ref-fx1-absent');
  assert.equal(await shown('hugo', 'intent-fx1-absent'), 'failed');
  // The receipt path has no throttle: only the recorded verification stops a second lookup.
  assert.equal((await receipt('hugo', 'intent-fx1-absent')).status, 409);
  assert.equal(lookups['ref-fx1-absent'], 1);
});

test('FX1 the lookup fails: the status is unchanged and the dashboard still answers', async () => {
  failed('intent-fx1-down', 'elena', 'ref-fx1-down');
  assert.equal(await shown('elena', 'intent-fx1-down'), 'failed');
  assert.equal(lookups['ref-fx1-down'], 1);
  // Unverified, so the receipt does not claim "no money moved".
  const { status, body } = await receipt('elena', 'intent-fx1-down');
  assert.equal(status, 503);
  assert.doesNotMatch(JSON.stringify(body), /no money moved/i);
});

// Follow-up after review: a verification is recorded by the one call that made the transition.
const sent = (id: string, status: string) =>
  appDb()
    .prepare(
      "INSERT INTO intents(id,user_id,conversation_id,payload,status,bank_reference,error,created_at) VALUES(?,'lucia','conv-lucia-support',?,?,?,'No response received from the bank.',?)",
    )
    .run(
      id,
      JSON.stringify({
        fromAccountId: 'acc-lucia',
        toAccountId: 'acc-bruno',
        amountCents: 100,
        concept: id,
      }),
      status,
      id.replace('intent-', 'ref-'),
      new Date().toISOString(),
    );
const recorded = (id: string) => {
  const count = (sql: string, arg: string) => (appDb().prepare(sql).get(arg) as { n: number }).n;
  return {
    status: (appDb().prepare('SELECT status FROM intents WHERE id=?').get(id) as any).status,
    events: count(
      "SELECT COUNT(*) n FROM events WHERE kind='transfer.verified' AND json_extract(data,'$.intentId')=?",
      id,
    ),
    notes: count('SELECT COUNT(*) n FROM messages WHERE run_id LIKE ?', `outcome:%:${id}`),
  };
};
const once = { status: 'completed', events: 1, notes: 1 };

test('FX1 ten parallel receipts record one verification and one note', async () => {
  sent('intent-fx1-ok-receipts', 'failed');
  const answers = await Promise.all(
    Array.from({ length: 10 }, () => receipt('lucia', 'intent-fx1-ok-receipts')),
  );
  assert.deepEqual([...new Set(answers.map((a) => a.status))], [200]);
  assert.deepEqual(recorded('intent-fx1-ok-receipts'), once);
});

test('FX1 a dashboard read and a receipt at once record one verification and one note', async () => {
  sent('intent-fx1-ok-both', 'failed');
  await Promise.all([callApi('lucia', 'dashboard'), receipt('lucia', 'intent-fx1-ok-both')]);
  assert.deepEqual(recorded('intent-fx1-ok-both'), once);
});

test('FX1 a pending_verification intent verified twice at once is recorded once', async () => {
  sent('intent-fx1-ok-pending', 'pending_verification');
  const { verifyIntent } = await import('../src/banking/actions');
  await Promise.all([
    verifyIntent('lucia', 'intent-fx1-ok-pending'),
    verifyIntent('lucia', 'intent-fx1-ok-pending'),
  ]);
  assert.deepEqual(recorded('intent-fx1-ok-pending'), once);
});

test('FX1 a late 404 never overwrites the completed a concurrent lookup wrote', async () => {
  sent('intent-fx1-ok-flip', 'failed');
  const { verifyIntent } = await import('../src/banking/actions');
  const results = await Promise.all([
    verifyIntent('lucia', 'intent-fx1-ok-flip'),
    verifyIntent('lucia', 'intent-fx1-ok-flip'),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['completed', 'completed'],
  );
  assert.deepEqual(recorded('intent-fx1-ok-flip'), once);
});

test("FX1 the list's date is the transfer's own, not the time it was verified", async () => {
  failed('intent-fx1-never-sent', 'lucia', null);
  const { body } = await callApi('lucia', 'dashboard');
  const date = (id: string) => body.transfers.find((t: any) => t.intentId === id).date;
  assert.equal(date('intent-historic-lucia'), '2026-09-23T16:41:13.000Z');
  const { created_at } = appDb()
    .prepare("SELECT created_at FROM intents WHERE id='intent-fx1-never-sent'")
    .get() as { created_at: string };
  assert.equal(date('intent-fx1-never-sent'), created_at);
});
