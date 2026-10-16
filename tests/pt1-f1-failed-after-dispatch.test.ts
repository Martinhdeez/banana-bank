// PT1-F1: "A transport error or timeout does not prove that the bank rejected the operation.
// Customer-facing status should match verified facts." An intent is written `failed` only when no
// money moved: a local write error after the bank was (or may have been) called is an unknown
// outcome to verify, never a failure. The write error is a real SQLite abort (a trigger).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-pt1-f1-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { appDb, closeAppDb } = await import('../src/db');
const { confirmApproval, proposeTransfer, transferMoney, verifyIntent } =
  await import('../src/banking/actions');
const { operations } = await import('./helpers/data');
let bank: ChildProcess;
before(async () => {
  seedBank();
  bank = await startSimulator();
});
const input = {
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-bruno',
  amountCents: 1000,
  concept: 'PT1-F1',
};
const cases = [
  // The bank accepted; the app cannot store the result.
  ['normal', "BEFORE UPDATE OF status ON intents WHEN NEW.status='completed'"],
  // The bank accepted and the result is stored; the step that follows cannot be recorded.
  ['normal', "BEFORE INSERT ON events WHEN NEW.kind='transfer.completed'"],
  // The first attempt got no answer (the bank committed it); the retry cannot be recorded.
  ['lost-response', "BEFORE INSERT ON events WHEN NEW.kind='transfer.retry'"],
] as const;
for (const [i, [profile, trigger]] of cases.entries())
  test(`PT1-F1 ${profile}: a local write error (${trigger}) never ends in failed`, async () => {
    setScenario(profile);
    const intentId = `pt1-f1-${i}`,
      sent = operations('lucia');
    const status = () =>
      (appDb().prepare('SELECT status FROM intents WHERE id=?').get(intentId) as { status: string })
        .status;
    appDb().exec(`CREATE TRIGGER local_error ${trigger} BEGIN SELECT RAISE(ABORT,'disk'); END`);
    const result = await transferMoney(
      { userId: 'lucia', conversationId: null, runId: 'run', intentId },
      input,
    ).finally(() => appDb().exec('DROP TRIGGER local_error'));
    assert.equal(operations('lucia') - sent, 1, 'the bank holds the transfer');
    assert.notEqual(result.status, 'failed');
    assert.notEqual(status(), 'failed');
    // With the database writable again, verification settles on the bank's fact.
    setScenario('normal');
    assert.equal((await verifyIntent('lucia', intentId)).status, 'completed');
    assert.equal(status(), 'completed');
    assert.equal(operations('lucia') - sent, 1);
  });
// The reviewer's addition: when not even `pending_verification` can be stored, transferMoney
// throws; the confirm must still not answer "not sent… No money moved" for a dispatched transfer.
test('PT1-F1 a confirm whose result cannot be stored answers "being verified", never "not sent"', async () => {
  setScenario('normal');
  const sent = operations('lucia');
  const proposed = await proposeTransfer(
    { userId: 'lucia', conversationId: null, runId: 'run', intentId: 'pt1-f1-confirm' },
    { ...input, concept: 'PT1-F1 confirm' },
  );
  appDb().exec(
    "CREATE TRIGGER local_error BEFORE UPDATE OF status ON intents WHEN NEW.status IN ('completed','pending_verification') BEGIN SELECT RAISE(ABORT,'disk'); END",
  );
  const result = await confirmApproval('lucia', (proposed.approval as { id: string }).id).finally(
    () => appDb().exec('DROP TRIGGER local_error'),
  );
  assert.equal(operations('lucia') - sent, 1, 'the bank holds the transfer');
  assert.equal(result.status, 'pending_verification');
  assert.doesNotMatch(JSON.stringify(result), /not sent|No money moved/);
});
after(() => {
  setScenario('intermittent', 17);
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
