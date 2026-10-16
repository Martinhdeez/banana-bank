// CF5-api: notifications derived at read time from recorded or verified facts (a later
// verification, an expiring or expired proposal, a resolved case); only read marks are stored.
// No bank call, no model call. Runs against the simulator or, with BANK_IMPL=alt, the alt bank.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
const { temp } = await setupEnv('banana-cf5-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { appDb, closeAppDb } = await import('../src/db');
const { seedApp } = await import('../src/seed');
const { verifyIntent } = await import('../src/banking/actions');
const { resolveCase } = await import('../src/operator/view');
const { notifications, markRead } = await import('../src/notifications');
let bank: ChildProcess;
before(async () => {
  seedApp();
  seedBank();
  bank = await startSimulator();
  setScenario('normal');
});
const MIN = 60_000;
const propose = async (amountCents: number) => {
  const { body } = await callApi('lucia', 'actions', {
    name: 'transfer_money',
    arguments: {
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-carla',
      amountCents,
      concept: 'CF5',
    },
  });
  assert.equal(body.status, 'requires_confirmation');
  return { approvalId: body.approval.id as string, intentId: body.intentId as string };
};
const expireIn = (approvalId: string, ms: number) =>
  appDb()
    .prepare('UPDATE approvals SET expires_at=? WHERE id=?')
    .run(new Date(Date.now() + ms).toISOString(), approvalId);
const reads = () =>
  (appDb().prepare('SELECT COUNT(*) n FROM notification_reads').get() as { n: number }).n;

test('CF5 proposals: expiring within 3 min, then expired; cancelled gives neither', async () => {
  const p = await propose(201);
  const idOf = (items: { id: string }[], prefix: string) =>
    items.find((i) => i.id === `${prefix}:${p.approvalId}`);
  assert.equal(idOf(notifications('lucia').items, 'expiring'), undefined); // 10 min left
  expireIn(p.approvalId, 2 * MIN);
  const soon = idOf(notifications('lucia').items, 'expiring') as any;
  assert.equal(soon.kind, 'proposal_expiring');
  assert.equal(soon.amountCents, 201);
  assert.equal(soon.to, 'Carla Ríos · Aurora account');
  assert.equal(soon.read, false);
  assert.deepEqual(soon.link, { tab: 'transfers' });
  assert.equal(Date.parse(soon.at), Date.parse(soon.expiresAt) - 3 * MIN);
  const later = notifications('lucia', new Date(Date.now() + 11 * MIN)).items;
  assert.equal(idOf(later, 'expiring'), undefined);
  assert.equal((idOf(later, 'expired') as any).kind, 'proposal_expired');
  const c = await propose(202);
  expireIn(c.approvalId, 2 * MIN);
  await callApi('lucia', `approvals/${c.approvalId}/cancel`, {});
  for (const at of [new Date(), new Date(Date.now() + 11 * MIN)])
    assert.ok(!notifications('lucia', at).items.some((i) => i.id.endsWith(c.approvalId)));
});

test('CF5 a later verification is notified; an immediately completed confirm is not', async () => {
  const now = await propose(203);
  assert.equal(
    (await callApi('lucia', `approvals/${now.approvalId}/confirm`, {})).body.status,
    'completed',
  );
  const verified = () => notifications('lucia').items.filter((i) => i.kind === 'transfer_verified');
  assert.equal(verified().length, 0);
  const p = await propose(204);
  await callApi('lucia', `approvals/${p.approvalId}/confirm`, {});
  // The outcome was never learned (lost response): the intent waits for a later lookup.
  appDb()
    .prepare("UPDATE intents SET status='pending_verification',operation_id=NULL WHERE id=?")
    .run(p.intentId);
  assert.equal((await verifyIntent('lucia', p.intentId)).status, 'completed');
  const [item] = verified() as any[];
  assert.equal(verified().length, 1);
  assert.equal(item.status, 'completed');
  assert.equal(item.amountCents, 204);
  assert.equal(item.to, 'Carla Ríos · Aurora account');
  assert.match(item.id, /^ev:/);
  assert.deepEqual(item.link, { tab: 'transfers' });
});

test('CF5 a resolved case is notified to its customer only', async () => {
  await resolveCase('marta', 'case-elena', true);
  const items = notifications('elena').items.filter((i) => i.kind === 'case_resolved');
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].link, { tab: 'assistant', conversationId: 'conv-elena-support' });
  assert.equal(notifications('hugo').items.length, 0);
});

test('CF5 read marks: own derived ids only, idempotent, all', async () => {
  const before = notifications('lucia');
  assert.ok(before.unread >= 2);
  const id = before.items[0].id;
  assert.equal(markRead('lucia', [id]).unread, before.unread - 1);
  const count = reads();
  assert.equal(markRead('lucia', [id]).unread, before.unread - 1);
  assert.equal(reads(), count);
  const elenaCase = notifications('elena').items[0].id;
  markRead('lucia', [elenaCase, 'ev:made-up']);
  assert.equal(reads(), count);
  assert.equal(notifications('lucia').items.find((i) => i.id === id)?.read, true);
  assert.equal(markRead('lucia', 'all').unread, 0);
  assert.equal(notifications('elena').unread, 1);
});

test('CF5 routes: list, mark read, validation, operator 403', async () => {
  const list = await callApi('elena', 'notifications');
  assert.equal(list.status, 200);
  assert.equal(list.body.unread, 1);
  const r = await callApi('elena', 'notifications/read', { ids: [list.body.items[0].id] });
  assert.deepEqual([r.status, r.body], [200, { unread: 0 }]);
  assert.deepEqual((await callApi('elena', 'notifications/read', { all: true })).body, {
    unread: 0,
  });
  for (const bad of [
    {},
    { ids: [] },
    { ids: Array.from({ length: 51 }, (_, i) => `ev:${i}`) },
    { ids: ['x'.repeat(121)] },
    { ids: ['a'], extra: 1 },
    { all: false },
  ]) {
    const res = await callApi('elena', 'notifications/read', bad);
    assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 60));
    assert.equal(res.body.error, 'Invalid request data.');
  }
  assert.equal((await callApi('marta', 'notifications')).status, 403);
  assert.equal((await callApi('marta', 'notifications/read', { all: true })).status, 403);
});

test('CF5 access-log labels keep the fixed route names', async () => {
  const { routeLabel } = await import('../src/http');
  assert.equal(routeLabel(['notifications']), 'notifications');
  assert.equal(routeLabel(['notifications', 'read']), 'notifications/read');
});

test('CF5 derivation needs no bank', async () => {
  bank.kill();
  await new Promise((r) => bank.once('exit', r));
  const { status, body } = await callApi('lucia', 'notifications');
  assert.equal(status, 200);
  assert.ok(body.items.length > 0);
});

test('CF5 reset clears read marks', () => {
  seedApp();
  assert.equal(reads(), 0);
});

after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
