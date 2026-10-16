// T9: the transfer endpoints always answer with a status, and confirm executes once through the
// route under concurrency and under the simulator's uncertain-response profiles.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
const { temp } = await setupEnv('banana-routes-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { appDb, closeAppDb } = await import('../src/db');
let bank: ChildProcess;
before(async () => {
  seedBank();
  bank = await startSimulator();
  setScenario('normal');
});
const { operations: countOperations } = await import('./helpers/data');
const operations = () => countOperations('lucia');
let n = 0;
const propose = async () => {
  const { body } = await callApi('lucia', 'actions', {
    name: 'transfer_money',
    arguments: {
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-bruno',
      amountCents: 100 + ++n,
      concept: 'Routes test',
    },
  });
  assert.equal(body.status, 'requires_confirmation');
  return body.approval.id as string;
};
const confirm = (userId: string, id: string) => callApi(userId, `approvals/${id}/confirm`, {});
test('T9: confirm and action errors include status failed', async () => {
  const unknown = await confirm('lucia', 'no-such-approval');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.status, 'failed');
  const expiredId = await propose();
  appDb()
    .prepare('UPDATE approvals SET expires_at=? WHERE id=?')
    .run('2000-01-01T00:00:00.000Z', expiredId);
  const expired = await confirm('lucia', expiredId);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.status, 'failed');
  const operator = await confirm('marta', await propose());
  assert.equal(operator.status, 403);
  assert.equal(operator.body.status, 'failed');
  const invalid = await callApi('lucia', 'actions', { name: 'nope' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.status, 'failed');
});
test('T9: concurrent confirms through the route create one operation', async () => {
  const id = await propose();
  const before = operations();
  const results = await Promise.all([confirm('lucia', id), confirm('lucia', id)]);
  assert.equal(operations(), before + 1);
  assert.ok(results.some((r) => r.body.status === 'completed'));
  for (const r of results) assert.ok(['completed', 'processing'].includes(r.body.status));
});
for (const profile of ['lost-response', 'slow-response'] as const)
  test(`T9: confirm under ${profile} completes once`, async () => {
    const id = await propose();
    setScenario(profile);
    const before = operations();
    const first = await confirm('lucia', id);
    assert.equal(first.body.status, 'completed');
    const again = await confirm('lucia', id);
    assert.equal(again.body.status, 'completed');
    assert.equal(operations(), before + 1);
    setScenario('normal');
  });
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
