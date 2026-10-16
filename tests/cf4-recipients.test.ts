// CF4-api: favourite recipients (pinned contact account ids, owner-only) and recent recipients
// (destinations of the customer's own completed app transfers only: never invented, R4).
// Runs against the simulator or, with BANK_IMPL=alt, the alt bank.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
const { temp } = await setupEnv('banana-cf4-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { appDb, closeAppDb, insert } = await import('../src/db');
const { groupRecipients, rankRecipients } = await import('../src/banking/recipients');
const { seedApp } = await import('../src/seed');
let bank: ChildProcess;
before(async () => {
  seedBank();
  bank = await startSimulator();
  setScenario('normal');
});
const propose = async (toAccountId: string, amountCents: number) => {
  const { body } = await callApi('lucia', 'actions', {
    name: 'transfer_money',
    arguments: { fromAccountId: 'acc-lucia', toAccountId, amountCents, concept: 'CF4 test' },
  });
  assert.equal(body.status, 'requires_confirmation');
  return { approvalId: body.approval.id as string, intentId: body.intentId as string };
};
const send = async (toAccountId: string, amountCents: number) => {
  const p = await propose(toAccountId, amountCents);
  const { body } = await callApi('lucia', `approvals/${p.approvalId}/confirm`, {});
  assert.equal(body.status, 'completed');
  return p;
};
const pin = (accountId: string, favourite = true, userId = 'lucia') =>
  callApi(userId, 'recipients/favourites', { accountId, favourite });
const recipients = async (userId = 'lucia') => (await callApi(userId, 'dashboard')).body.recipients;

test('CF4 rankRecipients: favourites (pin order), then recent (newest first), then bank order', () => {
  const contacts = [
    { id: 'a1', userId: 'a', name: 'Ana' },
    { id: 'b1', userId: 'b', name: 'Ben' },
    { id: 'b2', userId: 'b', name: 'Ben', label: 'Personal savings' },
    { id: 'c1', userId: 'c', name: 'Cai' },
    { id: 'd1', userId: 'd', name: 'Dan' },
  ];
  const people = groupRecipients(contacts);
  const none = rankRecipients(people, { favourites: [], recent: [] });
  assert.deepEqual(
    none.map((r) => r.key),
    people.map((r) => r.key),
  );
  assert.ok(none.every((r) => r.favourite === false && r.lastAt === null));
  const ranked = rankRecipients(people, {
    favourites: ['d1', 'b2'], // Ben pinned through his savings account only
    recent: [
      { accountId: 'c1', lastAt: '2026-09-02T00:00:00.000Z', lastAmountCents: 1 },
      { accountId: 'b1', lastAt: '2026-09-01T00:00:00.000Z', lastAmountCents: 2 },
    ],
  });
  assert.deepEqual(
    ranked.map((r) => r.key),
    ['d', 'b', 'c', 'a'],
  );
  assert.deepEqual(
    ranked.map((r) => r.favourite),
    [true, true, false, false],
  );
  assert.equal(ranked[1].main.id, 'b1'); // picking still selects the main account (R2)
  assert.equal(ranked[1].lastAt, '2026-09-01T00:00:00.000Z');
  assert.equal(ranked[2].lastAt, '2026-09-02T00:00:00.000Z');
});

test('CF4 a fresh customer has no favourites and no recent recipients', async () => {
  assert.deepEqual(await recipients('lucia'), { favourites: [], recent: [] });
});

test('CF4 recent: completed app transfers only, newest first, no own accounts', async () => {
  await send('acc-bruno', 101);
  await send('acc-carla', 102);
  await send('acc-carla', 103);
  await send('acc-lucia-savings', 104); // internal move: excluded
  const cancelled = await propose('acc-diego', 105);
  await callApi('lucia', `approvals/${cancelled.approvalId}/cancel`, {});
  // Outcome unknown (a reference the bank never saw, still inside the absence window): not recent.
  insert('intents', {
    id: randomUUID(),
    user_id: 'lucia',
    payload: JSON.stringify({
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-elena',
      amountCents: 106,
      concept: 'CF4 test',
    }),
    status: 'pending_verification',
    bank_reference: randomUUID(),
    created_at: new Date().toISOString(),
  });
  const { recent } = await recipients('lucia');
  assert.deepEqual(
    recent.map((r: any) => [r.accountId, r.lastAmountCents]),
    [
      ['acc-carla', 103],
      ['acc-bruno', 101],
    ],
  );
  assert.ok(!Number.isNaN(Date.parse(recent[0].lastAt)));
  assert.deepEqual((await recipients('hugo')).recent, []);
});

test('CF4 favourites: pin, idempotent, validated, unpin, limit, owner-only', async () => {
  let r = await pin('acc-bruno');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.favourites, ['acc-bruno']);
  r = await pin('acc-bruno');
  assert.deepEqual(r.body.favourites, ['acc-bruno']);
  await pin('acc-carla');
  assert.deepEqual((await recipients('lucia')).favourites, ['acc-bruno', 'acc-carla']);
  for (const own of ['acc-lucia', 'acc-zzz']) {
    r = await pin(own);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'This person is not in your contacts.');
  }
  for (const bad of [
    { accountId: '', favourite: true },
    { accountId: 'x'.repeat(121), favourite: true },
    { accountId: 'acc-bruno' },
    { accountId: 'acc-bruno', favourite: true, userId: 'hugo' },
  ]) {
    r = await callApi('lucia', 'recipients/favourites', bad);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Invalid request data.');
  }
  assert.equal((await pin('acc-bruno', true, 'marta')).status, 403);
  assert.equal((await callApi('lucia', 'recipients/favourites')).status, 405); // POST only (IT2)
  assert.deepEqual((await recipients('hugo')).favourites, []);
  r = await pin('acc-carla', false);
  assert.deepEqual(r.body.favourites, ['acc-bruno']);
  r = await pin('acc-nobody', false); // unpinning what is not pinned is a no-op
  assert.deepEqual(r.body.favourites, ['acc-bruno']);
  const stmt = appDb().prepare('INSERT INTO favourite_recipients VALUES(?,?,?)');
  for (let i = 0; i < 19; i++) stmt.run('lucia', `acc-gone-${i}`, new Date().toISOString());
  r = await pin('acc-carla');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'You can pin up to 20 favourites.');
  // Ids no longer among the contacts are kept but not shown.
  assert.deepEqual((await recipients('lucia')).favourites, ['acc-bruno']);
});

test('CF4 a pin with the bank down stores nothing; an unpin still works', async () => {
  bank.kill();
  await new Promise((r) => bank.once('exit', r));
  const count = () =>
    (appDb().prepare('SELECT COUNT(*) n FROM favourite_recipients').get() as { n: number }).n;
  const before = count();
  const r = await pin('acc-diego');
  assert.ok(r.status >= 500, `status ${r.status}`);
  assert.equal(count(), before);
  assert.equal((await pin('acc-bruno', false)).status, 200);
  assert.equal(count(), before - 1);
});

test('CF4 migration is version 5 and the access log labels the favourites route', async () => {
  const { migrations } = await import('../src/db');
  const { routeLabel } = await import('../src/http');
  assert.equal(migrations.findIndex((m) => m.name === 'cf4-favourite-recipients') + 1, 5);
  assert.equal(routeLabel(['recipients', 'favourites']), 'recipients/favourites');
  assert.equal(routeLabel(['approvals', 'a1', 'confirm']), 'approvals/:id/confirm');
});

test('CF4 reset clears favourites', () => {
  seedApp();
  assert.equal(
    (appDb().prepare('SELECT COUNT(*) n FROM favourite_recipients').get() as { n: number }).n,
    0,
  );
});

after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
