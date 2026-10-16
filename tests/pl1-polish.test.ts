// PL1 (round 6 polish): retry step copy and the public health response.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-pl1-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { recordEvent } = await import('../src/telemetry');
const { transferTimelines } = await import('../src/banking/actions');
const { caseDetail } = await import('../src/operator/view');
const { GET } = await import('../app/api/[...path]/route');
let bank: ChildProcess;
before(async () => {
  seedBank();
  seedApp();
  bank = await startSimulator();
});
after(() => {
  bank.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('PL1: a retry after a 503 answer (reject-before) is not described as "no answer"', async () => {
  const db = appDb(),
    now = new Date().toISOString();
  const conversationId = (
    db.prepare("SELECT conversation_id FROM incidents WHERE id='case-lucia'").get() as {
      conversation_id: string;
    }
  ).conversation_id;
  const payload = {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    amountCents: 500,
    concept: 'PL1',
  };
  db.prepare('INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    'i-pl1',
    'lucia',
    conversationId,
    'run-pl1',
    JSON.stringify(payload),
    'completed',
    'ref-pl1',
    null,
    null,
    now,
  );
  // As dispatchTransfer records it when the bank answers 503 before creating the operation.
  recordEvent(
    { userId: 'lucia', conversationId, runId: 'run-pl1', intentId: 'i-pl1' },
    'transfer.retry',
    {
      status: 'retrying',
      attempt: 2,
      reason: '503 Service temporarily unavailable',
      intentId: 'i-pl1',
    },
  );
  const step = transferTimelines('lucia')
    .find((t) => t.intentId === 'i-pl1')!
    .steps.find((s) => s.kind === 'retry')!;
  const d = (await caseDetail('marta', 'case-lucia')) as any;
  const operatorLine = d.events.find((e: any) => e.kind === 'transfer.retry').description;
  for (const text of [step.label, operatorLine]) {
    assert.doesNotMatch(text, /no answer/i);
    assert.equal(text, 'The bank did not confirm; sent again with the same reference');
  }
});

test('PL1: GET /api/health without a session says only that the app is up', async () => {
  const response = await GET(new Request('http://localhost/api/health'), {
    params: Promise.resolve({ path: ['health'] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
