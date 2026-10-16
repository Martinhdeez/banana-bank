// T5–T8: proposals are duplicate-aware, validated and explained in plain words.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
const { temp } = await setupEnv('banana-proposals-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { appDb, closeAppDb } = await import('../src/db');
const { runTool } = await import('../src/agent/tools');
let bank: ChildProcess;
before(async () => {
  seedBank();
  bank = await startSimulator();
  setScenario('normal');
});
let n = 0;
// A chat tool call: fresh intentId per call, as src/agent/run.ts does.
const chat = (userId: string, name: string, args: unknown) =>
  runTool(name, args, {
    userId,
    conversationId: null,
    runId: 'run-proposals',
    intentId: `chat-${++n}`,
  }) as Promise<any>;
const approvals = () =>
  (appDb().prepare('SELECT COUNT(*) n FROM approvals').get() as { n: number }).n;
const cinema = {
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-carla',
  amountCents: 1500,
  concept: 'Cinema',
};
test('T5: an identical chat request returns the pending proposal instead of a new one', async () => {
  const first = await chat('lucia', 'transfer_money', cinema);
  assert.equal(first.status, 'requires_confirmation');
  const count = approvals();
  const second = await chat('lucia', 'transfer_money', { ...cinema, concept: 'cinema' });
  assert.equal(second.status, 'possible_duplicate');
  assert.equal(second.approval.id, first.approval.id);
  assert.match(second.message, /second, separate transfer/);
  assert.equal(approvals(), count);
});
test('T5: a confirmed second transfer creates a second proposal', async () => {
  const count = approvals();
  const second = await chat('lucia', 'transfer_money', { ...cinema, secondTransfer: true });
  assert.equal(second.status, 'requires_confirmation');
  assert.equal(approvals(), count + 1);
});
test('T5: an identical request while the first is unverified is flagged', async () => {
  const args = { ...cinema, amountCents: 1600 };
  const first = await chat('lucia', 'transfer_money', args);
  appDb()
    .prepare("UPDATE intents SET status='pending_verification',bank_reference='ref-t5' WHERE id=?")
    .run(first.intentId);
  appDb()
    .prepare('UPDATE approvals SET consumed_at=? WHERE id=?')
    .run(new Date().toISOString(), first.approval.id);
  const second = await chat('lucia', 'transfer_money', args);
  assert.equal(second.status, 'possible_duplicate');
  assert.equal(second.intentId, first.intentId);
  assert.match(second.message, /not to repeat/);
});
test('T5: /api/actions with distinct intentIds keeps two proposals', async () => {
  const args = { ...cinema, amountCents: 1700 };
  const a = await callApi('lucia', 'actions', {
    name: 'transfer_money',
    arguments: args,
    intentId: 'a',
  });
  const b = await callApi('lucia', 'actions', {
    name: 'transfer_money',
    arguments: args,
    intentId: 'b',
  });
  assert.equal(a.body.status, 'requires_confirmation');
  assert.equal(b.body.status, 'requires_confirmation');
  assert.notEqual(a.body.approval.id, b.body.approval.id);
});
test('T6: a self-transfer is refused at proposal time', async () => {
  const count = approvals();
  const result = await chat('bruno', 'transfer_money', {
    fromAccountId: 'acc-bruno',
    toAccountId: 'acc-bruno',
    amountCents: 500,
    concept: 'manual',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'same_account');
  assert.match(result.error, /No money moved/);
  assert.equal(approvals(), count);
});
test('T6: an unknown destination is refused at proposal time', async () => {
  const count = approvals();
  const result = await chat('bruno', 'transfer_money', {
    fromAccountId: 'acc-bruno',
    toAccountId: 'acc-nobody',
    amountCents: 500,
    concept: 'manual',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid_destination');
  assert.equal(approvals(), count);
});
test('T6: a transfer to another own account is still proposed', async () => {
  const result = await chat('lucia', 'transfer_money', {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-lucia-savings',
    amountCents: 500,
    concept: 'Savings',
  });
  assert.equal(result.status, 'requires_confirmation');
});
test('T7: validation errors are plain words, not zod JSON', async () => {
  const result = await chat('lucia', 'transfer_money', { ...cinema, amountCents: 0 });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid_request');
  assert.doesNotMatch(result.error, /[[{]|"code"/);
  assert.match(result.error, /€0\.01/);
});
test('T7: operation_status with an unknown reference says not found', async () => {
  const result = await chat('lucia', 'operation_status', { reference: 'does-not-exist' });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reference, 'does-not-exist');
});
test('T7: reusing an executed intentId returns its outcome, not a SQL error', async () => {
  const { transferMoney } = await import('../src/banking/actions');
  const ctx = { userId: 'bruno', conversationId: null, runId: 'r', intentId: 'bruno:executed' };
  const args = {
    fromAccountId: 'acc-bruno',
    toAccountId: 'acc-lucia',
    amountCents: 300,
    concept: 'x',
  };
  assert.equal((await transferMoney(ctx, args)).status, 'completed');
  const again = await callApi('bruno', 'actions', {
    name: 'transfer_money',
    arguments: args,
    intentId: 'executed',
  });
  assert.equal(again.body.status, 'completed');
  assert.doesNotMatch(JSON.stringify(again.body), /UNIQUE|constraint/i);
});
test('T7: the same client intentId from two customers is two intents', async () => {
  const propose = (userId: string, fromAccountId: string, toAccountId: string) =>
    callApi(userId, 'actions', {
      name: 'transfer_money',
      arguments: { fromAccountId, toAccountId, amountCents: 200, concept: 'shared id' },
      intentId: 'shared-intent',
    });
  assert.equal(
    (await propose('lucia', 'acc-lucia', 'acc-bruno')).body.status,
    'requires_confirmation',
  );
  const other = await propose('bruno', 'acc-bruno', 'acc-lucia');
  assert.equal(other.status, 200);
  assert.equal(other.body.status, 'requires_confirmation');
});
test('T8: insufficient funds carries the FAQ as a citable source', async () => {
  const { citedSources } = await import('../src/agent/run');
  const result = await chat('diego', 'transfer_money', {
    fromAccountId: 'acc-diego',
    toAccountId: 'acc-bruno',
    amountCents: 20000,
    concept: 'Rent',
  });
  assert.equal(result.code, 'insufficient_funds');
  assert.equal(result.sources[0].documentId, 'faq-insufficient-funds');
  // S2: the id is not in the customer text; an answer citing it resolves to the attached source.
  assert.doesNotMatch(result.error, /faq-insufficient-funds/);
  assert.deepEqual(
    citedSources('See [faq-insufficient-funds].', result.sources).map((s) => s.documentId),
    ['faq-insufficient-funds'],
  );
});
test('T8: another account is suggested only when one can pay', async () => {
  const diego = await chat('diego', 'transfer_money', {
    fromAccountId: 'acc-diego',
    toAccountId: 'acc-bruno',
    amountCents: 20000,
    concept: 'Rent',
  });
  assert.doesNotMatch(diego.error, /another/);
  assert.match(diego.error, /smaller amount/);
  const { listAccounts } = await import('../simulator/bank');
  const [low, high] = listAccounts('lucia').sort((a, b) => a.balanceCents - b.balanceCents);
  const amountCents = low.balanceCents + 1;
  assert.ok(high.balanceCents >= amountCents, 'seed: the other account covers the amount');
  const lucia = await chat('lucia', 'transfer_money', {
    fromAccountId: low.id,
    toAccountId: 'acc-bruno',
    amountCents,
    concept: 'Big',
  });
  assert.equal(lucia.code, 'insufficient_funds');
  assert.match(lucia.error, /another of your accounts/);
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
