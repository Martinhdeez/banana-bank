// F2 / F2b: transfers are proposed first and execute once, only on explicit confirmation.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
const { temp } = await setupEnv('banana-review-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { appDb, closeAppDb } = await import('../src/db');
const { runTool } = await import('../src/agent/tools');
const input = {
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-bruno',
  amountCents: 1000,
  concept: 'Review test',
};
let bank: ChildProcess;
before(async () => {
  seedBank();
  bank = await startSimulator();
  setScenario('normal');
});
const { operations: countOperations } = await import('./helpers/data');
const operations = () => countOperations('lucia');
const propose = (intentId?: string) =>
  callApi('lucia', 'actions', { name: 'transfer_money', arguments: input, intentId });
test('transfer_money via /api/actions proposes and moves no money', async () => {
  const before = operations();
  const { status, body } = await propose();
  assert.equal(status, 200);
  assert.equal(body.status, 'requires_confirmation');
  assert.ok(body.approval?.id);
  assert.equal(body.approval.amountCents, 1000);
  assert.equal(body.approval.fromAccountId, 'acc-lucia');
  assert.equal(body.approval.toAccountId, 'acc-bruno');
  assert.ok(Date.parse(body.approval.expiresAt) > Date.now());
  assert.equal(operations(), before);
});
test('confirm executes exactly once and a second confirm returns the same operation', async () => {
  const { body: proposed } = await propose();
  const before = operations();
  const first = await callApi('lucia', `approvals/${proposed.approval.id}/confirm`, {});
  assert.equal(first.body.status, 'completed');
  assert.equal(operations(), before + 1);
  const second = await callApi('lucia', `approvals/${proposed.approval.id}/confirm`, {});
  assert.equal(second.body.status, 'completed');
  assert.equal(second.body.operation.id, first.body.operation.id);
  assert.equal(operations(), before + 1);
  const row = appDb()
    .prepare('SELECT consumed_at FROM approvals WHERE id=?')
    .get(proposed.approval.id) as { consumed_at: string | null };
  assert.ok(row.consumed_at);
});
test('an expired approval cannot be confirmed', async () => {
  const { body: proposed } = await propose();
  appDb()
    .prepare('UPDATE approvals SET expires_at=? WHERE id=?')
    .run('2000-01-01T00:00:00.000Z', proposed.approval.id);
  const before = operations();
  const result = await callApi('lucia', `approvals/${proposed.approval.id}/confirm`, {});
  assert.equal(result.status, 410);
  assert.equal(operations(), before);
});
test("another customer cannot confirm someone else's approval", async () => {
  const { body: proposed } = await propose();
  const before = operations();
  const result = await callApi('bruno', `approvals/${proposed.approval.id}/confirm`, {});
  assert.equal(result.status, 404);
  assert.equal(operations(), before);
});
test('the agent tool proposes instead of executing', async () => {
  const before = operations();
  // T5: a distinct amount, so the chat duplicate check does not match earlier proposals.
  const result = (await runTool(
    'transfer_money',
    { ...input, amountCents: 1001 },
    {
      userId: 'lucia',
      conversationId: null,
      runId: 'run-agent',
      intentId: 'run-agent:call-1',
    },
  )) as any;
  assert.equal(result.status, 'requires_confirmation');
  assert.equal(operations(), before);
});
test('a double submit of the manual form yields one proposal and no money moves', async () => {
  const before = operations();
  const [a, b] = await Promise.all([propose('form-intent-1'), propose('form-intent-1')]);
  assert.equal(a.body.status, 'requires_confirmation');
  assert.equal(b.body.status, 'requires_confirmation');
  assert.equal(a.body.approval.id, b.body.approval.id);
  const rows = appDb()
    .prepare("SELECT COUNT(*) n FROM approvals WHERE intent_id='lucia:form-intent-1'")
    .get() as { n: number };
  assert.equal(rows.n, 1);
  assert.equal(operations(), before);
});
test('a confirm that cannot reach the bank before dispatch is failed, not processing', async () => {
  const { body: proposed } = await propose();
  const before = operations();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    const first = await callApi('lucia', `approvals/${proposed.approval.id}/confirm`, {});
    assert.equal(first.body.status, 'failed');
  } finally {
    globalThis.fetch = realFetch;
  }
  const second = await callApi('lucia', `approvals/${proposed.approval.id}/confirm`, {});
  assert.equal(second.body.status, 'failed');
  assert.equal(operations(), before);
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
