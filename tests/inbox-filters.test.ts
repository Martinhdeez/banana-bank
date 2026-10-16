// OPX3: server-side inbox filters on GET /api/incidents (q, status, money, reason) and the
// `reasons` codes on every inbox row. Round-5 query-parameter rule: unknown key, repeated key or
// bad value → 400 "Invalid request data.".
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-inbox-filters-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const { inbox } = await import('../src/operator/view');
const { runTool } = await import('../src/agent/tools');
const { shortRef } = await import('../src/ui-helpers');
const { GET } = await import('../app/api/[...path]/route');
let bank: ChildProcess;
before(async () => {
  seedBank();
  seedApp();
  bank = await startSimulator();
  // A case whose only fact is a transfer refused by the app (insufficient funds).
  appDb()
    .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
    .run('conv-opx3', 'diego', 'Rent', new Date().toISOString());
  const ctx = (n: number) => ({
    userId: 'diego',
    conversationId: 'conv-opx3',
    runId: 'run-opx3',
    intentId: `run-opx3:call-${n}`,
  });
  const args = { fromAccountId: 'acc-diego', toAccountId: 'acc-bruno', concept: 'Rent' };
  await runTool('transfer_money', { ...args, amountCents: 2_000_000 }, ctx(1));
  await runTool('request_human', { summary: 'Diego asks why the rent failed.' }, ctx(2));
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
async function list(userId: string | null, query = '') {
  const request = new Request(`http://localhost/api/incidents${query}`, {
    headers: userId ? { cookie: `banana_actor=${sessionToken(userId)}` } : {},
  });
  const response = await GET(request, { params: Promise.resolve({ path: ['incidents'] }) });
  return { status: response.status, body: await response.json() };
}
const ids = (rows: Record<string, any>[]) => rows.map((r) => r.id as string);

test('OPX3: no params → the same ids in the same order as inbox()', async () => {
  const r = await list('marta');
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r.body), ids(inbox()));
});

test('OPX3: q matches folded name, summary word and short ref with or without #', async () => {
  const all = inbox();
  const lucia = all.filter((c) => c.user_id === 'lucia');
  assert.ok(lucia.length);
  const byName = (await list('marta', '?q=lucia')).body;
  assert.deepEqual(ids(byName), ids(lucia), 'accent-insensitive name');
  assert.deepEqual(ids((await list('marta', '?q=LUC%C3%8DA%20MART')).body), ids(lucia));
  const target = all.find((c) => c.id === 'conv-opx3' || c.conversation_id === 'conv-opx3')!;
  const bySummary = (await list('marta', '?q=RENT%20failed')).body;
  assert.ok(ids(bySummary).includes(target.id), 'summary substring');
  const ref = shortRef(target.id);
  for (const q of [ref, ref.slice(1), ref.slice(1, 5).toLowerCase()]) {
    const rows = (await list('marta', `?q=${encodeURIComponent(q)}`)).body;
    assert.ok(ids(rows).includes(target.id), `short ref ${q}`);
  }
  assert.deepEqual((await list('marta', `?q=${encodeURIComponent(ref)}`)).body.length, 1);
  assert.deepEqual((await list('marta', '?q=nobody-by-that-name')).body, []);
  // Only spaces: treated as absent.
  assert.deepEqual(ids((await list('marta', '?q=%20%20')).body), ids(all));
});

test('OPX3: status, money and reason filters', async () => {
  const closed = (await list('marta', '?status=closed')).body;
  assert.ok(closed.length);
  assert.ok(closed.every((c: any) => c.status === 'closed'));
  const open = (await list('marta', '?status=open')).body;
  assert.equal(open.length + closed.length, inbox().length);
  const money = (await list('marta', '?money=true')).body;
  assert.ok(money.length);
  assert.ok(money.every((c: any) => c.priority === 'money'));
  const notMoney = (await list('marta', '?money=false')).body;
  assert.ok(notMoney.every((c: any) => c.priority !== 'money'));
  assert.equal(money.length + notMoney.length, inbox().length);
  const rejected = (await list('marta', '?reason=rejected_attempt')).body;
  assert.ok(rejected.some((c: any) => c.conversation_id === 'conv-opx3'));
  assert.ok(rejected.every((c: any) => c.reasons.includes('rejected_attempt')));
  const waiting = (await list('marta', '?reason=waiting&status=open')).body;
  assert.ok(waiting.every((c: any) => c.priority === 'open'));
  assert.deepEqual((await list('marta', '?money=true&reason=waiting')).body, []);
  const q = '?q=lucia&status=open&money=true&reason=sent_failed';
  assert.ok((await list('marta', q)).body.every((c: any) => c.user_id === 'lucia'));
});

test('OPX3: unknown key, repeated key or bad value → 400; customer 403; anonymous 401', async () => {
  for (const q of [
    '?status=bogus',
    '?money=yes',
    '?reason=late',
    '?q=' + 'x'.repeat(101),
    '?foo=1',
    '?status=open&status=closed',
    '?q=a&q=b',
  ]) {
    const r = await list('marta', q);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.error, 'Invalid request data.');
  }
  assert.equal((await list('lucia', '?q=lucia')).status, 403);
  assert.equal((await list(null, '?q=lucia')).status, 401);
});

test('OPX3: every row has non-empty reasons consistent with its priority', () => {
  const money = ['pending_verification', 'sent_failed', 'rejected_attempt'];
  for (const c of inbox()) {
    assert.ok(Array.isArray(c.reasons) && c.reasons.length, c.id);
    if (c.priority === 'closed') assert.deepEqual(c.reasons, ['resolved']);
    else if (c.priority === 'open') assert.deepEqual(c.reasons, ['waiting']);
    else assert.ok(c.reasons.every((r: string) => money.includes(r)));
  }
});
