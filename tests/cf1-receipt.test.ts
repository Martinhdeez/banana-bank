// CF1-api: a transfer receipt exists only for an intent sent to the bank, states the verified
// status (pending is "not final"), and is owner-only. Contract: "Customer-facing status should
// match verified facts". Runs against the simulator or, with BANK_IMPL=alt, the alt bank.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
const { temp } = await setupEnv('banana-cf1-');
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
const propose = async (amountCents: number, toAccountId = 'acc-carla') => {
  const { body } = await callApi('lucia', 'actions', {
    name: 'transfer_money',
    arguments: { fromAccountId: 'acc-lucia', toAccountId, amountCents, concept: 'Receipt test' },
  });
  assert.equal(body.status, 'requires_confirmation');
  return { approvalId: body.approval.id as string, intentId: body.intentId as string };
};
const send = async (amountCents: number) => {
  const p = await propose(amountCents);
  const { body } = await callApi('lucia', `approvals/${p.approvalId}/confirm`, {});
  return { ...p, result: body };
};
const receipt = (intentId: string, userId = 'lucia') =>
  callApi(userId, `transfers/${encodeURIComponent(intentId)}/receipt`);
const intent = (id: string) =>
  appDb().prepare('SELECT * FROM intents WHERE id=?').get(id) as {
    bank_reference: string;
    operation_id: string | null;
  };
// Makes a completed intent look like one whose outcome was never learned (lost response).
const forgetOutcome = (id: string, reference?: string) => {
  appDb()
    .prepare(
      "UPDATE intents SET status='pending_verification',operation_id=NULL,bank_reference=COALESCE(?,bank_reference) WHERE id=?",
    )
    .run(reference ?? null, id);
  appDb()
    .prepare(
      "DELETE FROM events WHERE kind='transfer.completed' AND json_extract(data,'$.intentId')=?",
    )
    .run(id);
};
test('CF1: a completed transfer has a final receipt with verified facts', async () => {
  const { intentId, result } = await send(110);
  assert.equal(result.status, 'completed');
  const { status, body } = await receipt(intentId);
  assert.equal(status, 200);
  assert.equal(body.status, 'completed');
  assert.equal(body.final, true);
  assert.equal(body.reference, intent(intentId).bank_reference);
  assert.equal(body.operationId, intent(intentId).operation_id);
  assert.ok(body.operationId);
  assert.equal(body.amountCents, 110);
  assert.equal(body.concept, 'Receipt test');
  assert.equal(body.to.accountId, 'acc-carla');
  assert.equal(body.to.name, 'Carla Ríos · Aurora account');
  assert.equal(body.from.accountId, 'acc-lucia');
  assert.equal(body.from.label, 'Aurora account');
  assert.match(body.from.iban, /^ES/);
  for (const k of ['proposedAt', 'confirmedAt', 'sentAt', 'executedAt', 'verifiedAt', 'issuedAt'])
    assert.ok(!Number.isNaN(Date.parse(body[k])), `${k} is a date`);
});
test('CF1: an unverified transfer is marked not final', async () => {
  const { intentId } = await send(111);
  forgetOutcome(intentId, randomUUID()); // a reference the bank never saw: lookup 404, too early
  const { status, body } = await receipt(intentId);
  assert.equal(status, 200);
  assert.equal(body.status, 'pending_verification');
  assert.equal(body.final, false);
  assert.equal(body.operationId, null);
  assert.equal(body.verifiedAt, null);
  assert.equal(body.executedAt, null);
});
test('CF1: a later verification settles the receipt, with the execution time from the bank', async () => {
  const { intentId } = await send(112);
  forgetOutcome(intentId);
  const { status, body } = await receipt(intentId);
  assert.equal(status, 200);
  assert.equal(body.status, 'completed');
  assert.equal(body.final, true);
  assert.ok(body.operationId);
  assert.ok(!Number.isNaN(Date.parse(body.executedAt)));
  assert.ok(!Number.isNaN(Date.parse(body.verifiedAt)));
});
test('CF1: owner-only (404), operators 403, no receipt when nothing was sent (409)', async () => {
  const { intentId } = await send(113);
  const other = await receipt(intentId, 'bruno');
  assert.equal(other.status, 404);
  assert.equal(other.body.error, 'Transfer not found.');
  assert.equal((await receipt('no-such-intent')).status, 404);
  assert.equal((await receipt(intentId, 'marta')).status, 403);
  const neverSent = 'This transfer was never sent, so there is no receipt.';
  const unconfirmed = await propose(114);
  const r1 = await receipt(unconfirmed.intentId);
  assert.equal(r1.status, 409);
  assert.equal(r1.body.error, neverSent);
  const cancelled = await propose(115);
  await callApi('lucia', `approvals/${cancelled.approvalId}/cancel`, {});
  const r2 = await receipt(cancelled.intentId);
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, neverSent);
  // Rejected by the bank: two proposals that each fit the balance, but not both.
  const { body: accounts } = await callApi('lucia', 'dashboard');
  const balance = accounts.accounts.find((a: any) => a.id === 'acc-lucia').balanceCents;
  const a = await propose(Math.floor(balance * 0.6));
  const b = await propose(Math.floor(balance * 0.6) + 1);
  await callApi('lucia', `approvals/${a.approvalId}/confirm`, {});
  const rejected = await callApi('lucia', `approvals/${b.approvalId}/confirm`, {});
  assert.equal(rejected.body.status, 'failed');
  const r3 = await receipt(b.intentId);
  assert.equal(r3.status, 409);
  assert.equal(r3.body.error, 'No money moved, so there is no receipt.');
  assert.equal((await callApi('lucia', `transfers/${intentId}`)).status, 404);
});
test('CF1: bank reads failing only degrade fields', async () => {
  const { intentId } = await send(116);
  bank.kill();
  await new Promise((r) => bank.once('exit', r));
  const { status, body } = await receipt(intentId);
  assert.equal(status, 200);
  assert.equal(body.status, 'completed');
  assert.equal(body.from.label, 'acc-lucia');
  assert.equal(body.from.iban, null);
  assert.equal(body.to.name, 'Carla Ríos · Aurora account'); // recorded with the proposal
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
