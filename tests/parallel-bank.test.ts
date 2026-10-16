// K2: independent bank calls run concurrently. A fake bank counts the requests in flight and
// answers later references first; no simulator, no OpenAI calls.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { setupEnv, callApi } from './helpers/bank';
const { temp, port } = await setupEnv('banana-parallel-');
let inFlight = 0,
  maxInFlight = 0;
const reply = (res: http.ServerResponse, data: unknown, ms: number) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  setTimeout(() => {
    inFlight--;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  }, ms);
};
const bank = http
  .createServer((req, res) => {
    const url = new URL(req.url!, 'http://bank');
    const ref = /^\/v1\/operations\/ref-par-(\d+)$/.exec(url.pathname);
    // Later references answer first, so completion order is the reverse of the request order.
    if (ref)
      return reply(
        res,
        { id: `op-par-${ref[1]}`, reference: `ref-par-${ref[1]}`, status: 'completed' },
        60 * (10 - Number(ref[1])),
      );
    if (url.pathname === '/v1/operator/customer')
      return reply(res, { accounts: [], operations: [] }, 150);
    reply(res, [], 150);
  })
  .listen(port, '127.0.0.1');
const { appDb, closeAppDb } = await import('../src/db');
const { recentTransfers } = await import('../src/banking/actions');
after(() => {
  bank.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
let n = 0;
// Transfers sent just now whose outcome is unknown: each verification is one bank lookup.
function pending(count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `par-${++n}`;
    appDb()
      .prepare(
        'INSERT INTO intents(id,user_id,payload,status,bank_reference,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id,
        'lucia',
        JSON.stringify({ fromAccountId: 'a', toAccountId: 'b', amountCents: 100, concept: 'k2' }),
        'pending_verification',
        `ref-${id}`,
        new Date(Date.now() + n).toISOString(),
      );
    ids.push(id);
  }
  return ids;
}
const run = async (fn: () => Promise<unknown>) => {
  maxInFlight = 0;
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started, max: maxInFlight };
};

test('K2 recentTransfers verifies concurrently and keeps the newest-first order', async () => {
  const ids = pending(5);
  const { value, max } = await run(() => recentTransfers('lucia'));
  const transfers = (value as { transfers: { intentId: string; status: string }[] }).transfers;
  assert.deepEqual(
    transfers.map((t) => t.intentId),
    [...ids].reverse(),
  );
  assert.ok(transfers.every((t) => t.status === 'completed'));
  assert.equal(max, 5);
});

test('K2 the dashboard rechecks pending transfers while it reads the bank', async () => {
  pending(3);
  const { value, max } = await run(() => callApi('lucia', 'dashboard'));
  assert.equal((value as { status: number }).status, 200);
  // 3 reads + 3 recheck lookups in flight together (sequential recheck would cap it at 3).
  assert.equal(max, 6);
  const { transfers } = (value as { body: { transfers: { status: string }[] } }).body;
  // Timelines are built after the recheck: the rechecked transfers already show completed.
  assert.deepEqual(
    transfers.slice(0, 3).map((t) => t.status),
    ['completed', 'completed', 'completed'],
  );
});

test('K2 the operator case detail reads the customer and the contacts concurrently', async () => {
  appDb()
    .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
    .run('conv-par', 'lucia', 'K2', new Date().toISOString());
  appDb()
    .prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)')
    .run('case-par', 'lucia', 'conv-par', 'K2', 'open', new Date().toISOString());
  const { value, max, ms } = await run(() => callApi('marta', 'incidents/case-par'));
  assert.equal((value as { status: number }).status, 200);
  assert.equal(max, 2);
  assert.ok(ms < 290, `${Math.round(ms)} ms for two 150 ms reads`);
});
