import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-idempotency-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { appDb, closeAppDb } = await import('../src/db');
const { transferMoney } = await import('../src/banking/actions');
const input = {
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-bruno',
  amountCents: 1000,
  concept: 'Test',
};
let bank: ChildProcess;
before(async () => {
  seedBank();
  bank = await startSimulator();
});
const { operations: countOperations } = await import('./helpers/data');
const operations = () => countOperations('lucia');
const ctx = (intentId: string) => ({
  userId: 'lucia',
  conversationId: null,
  runId: `run-${intentId}`,
  intentId,
});
for (const profile of ['lost-response', 'slow-response', 'read-unavailable'] as const)
  test(`${profile}: the retry reuses the reference and creates one operation`, async () => {
    setScenario(profile);
    const before = operations();
    const result = await transferMoney(ctx(`intent-${profile}`), input);
    assert.equal(operations() - before, 1);
    assert.equal(result.status, 'completed');
  });
test('the same intentId called twice creates one operation and returns it again', async () => {
  setScenario('normal');
  const before = operations();
  const first = await transferMoney(ctx('intent-twice'), input);
  const second = await transferMoney(ctx('intent-twice'), input);
  assert.equal(operations() - before, 1);
  assert.equal((second.operation as any).id, (first.operation as any).id);
  assert.equal((second.operation as any).replay, true);
  const row = appDb()
    .prepare('SELECT bank_reference FROM intents WHERE id=?')
    .get('intent-twice') as {
    bank_reference: string;
  };
  assert.equal((first.operation as any).reference, row.bank_reference);
});
test('different intents with the same payload remain separate operations', async () => {
  setScenario('normal');
  const before = operations();
  await transferMoney(ctx('intent-a'), input);
  await transferMoney(ctx('intent-b'), input);
  assert.equal(operations() - before, 2);
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
