// F6 / F7: bank rejections explained in plain words; the source account is never guessed.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-errors-');
const { seedBank } = await import('../simulator/seed');
const { bankDb, closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { closeAppDb } = await import('../src/db');
const { runTool } = await import('../src/agent/tools');
const actions = await import('../src/banking/actions');
let bank: ChildProcess;
before(async () => {
  seedBank();
  bank = await startSimulator();
  setScenario('normal');
});
let n = 0;
const tool = (userId: string, name: string, args: unknown) =>
  runTool(name, args, {
    userId,
    conversationId: null,
    runId: 'run-errors',
    intentId: `errors-${++n}`,
  }) as Promise<any>;
const { operations } = await import('./helpers/data');
const diego = (amountCents: number, toAccountId = 'acc-hugo') => ({
  fromAccountId: 'acc-diego',
  toAccountId,
  amountCents,
  concept: 'Errors test',
});
test('insufficient funds is explained with the available balance and next step', async () => {
  const before = operations();
  const result = await tool('diego', 'transfer_money', diego(10000));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'insufficient_funds');
  assert.equal(result.availableCents, 7500);
  assert.match(result.error, /€75\.00 available/);
  assert.match(result.error, /No money moved/);
  // S2: the FAQ is attached as a source, never printed as an id in customer text.
  assert.doesNotMatch(result.error, /faq-insufficient-funds/);
  assert.equal(result.sources[0].documentId, 'faq-insufficient-funds');
  assert.match(result.error, /smaller amount/);
  assert.equal(operations(), before);
});
test('a 422 at execution time is also explained', async () => {
  const proposed = await tool('diego', 'transfer_money', diego(5000));
  assert.equal(proposed.status, 'requires_confirmation');
  bankDb().prepare("UPDATE accounts SET balanceCents=1000 WHERE id='acc-diego'").run();
  const before = operations();
  const result = await actions.confirmApproval('diego', proposed.approval.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'insufficient_funds');
  assert.match(String(result.error), /€10\.00 available/);
  assert.equal(operations(), before);
});
// T6: the destination is now checked at proposal time, before any review.
test('an invalid destination is explained in plain words', async () => {
  const result = await tool('lucia', 'transfer_money', {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-nobody',
    amountCents: 100,
    concept: 'Errors test',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid_destination');
  assert.match(String(result.error), /destination account does not exist/);
});
test('a two-account customer without a named source is asked which account', async () => {
  const { appDb } = await import('../src/db');
  const approvals = () =>
    (appDb().prepare('SELECT COUNT(*) n FROM approvals').get() as { n: number }).n;
  const before = approvals();
  const result = await tool('lucia', 'transfer_money', {
    fromAccountId: null,
    toAccountId: 'acc-bruno',
    amountCents: 2000,
    concept: 'Source test',
  });
  assert.equal(result.status, 'needs_source_account');
  assert.deepEqual(
    result.accounts.map((a: any) => a.id),
    ['acc-lucia', 'acc-lucia-savings'],
  );
  assert.equal(approvals(), before);
});
test('a single-account customer without a named source gets a proposal from that account', async () => {
  const result = await tool('bruno', 'transfer_money', {
    fromAccountId: null,
    toAccountId: 'acc-lucia',
    amountCents: 2000,
    concept: 'Source test',
  });
  assert.equal(result.status, 'requires_confirmation');
  assert.equal(result.approval.fromAccountId, 'acc-bruno');
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
