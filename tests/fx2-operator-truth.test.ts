// FX2-b, FX2-c, FX2-d: what the operator reads in a case. Deterministic, no model: the tools and
// caseDetail are called directly against a simulator on a free port. FX2-a is in case-export.test.ts.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-fx2-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { runTool } = await import('../src/agent/tools');
const { caseDetail } = await import('../src/operator/view');
const { exportCase } = await import('../src/operator/export');
const ui = (await import('../src/ui-helpers')) as any;
let bank: ChildProcess;
before(async () => {
  seedBank();
  seedApp();
  bank = await startSimulator();
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
let call = 0;
function conversation(userId: string, id: string) {
  appDb()
    .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
    .run(id, userId, 'Help', new Date().toISOString());
  return () => ({
    userId,
    conversationId: id,
    runId: `run-${id}`,
    intentId: `run-${id}:${call++}`,
  });
}

test('FX2-b: bank operations are listed newest first, whatever order the bank returns', () => {
  const ops = ['03', '06', '01', '05', '02', '04'].map((d) => ({
    id: d,
    createdAt: `2026-10-${d}T10:00:00.000Z`,
  }));
  assert.deepEqual(
    ui.newestFirst(ops).map((o: any) => o.id),
    ['06', '05', '04', '03', '02', '01'],
  );
  assert.equal(ops[0].id, '03', 'the bank listing itself is not reordered');
});

test('FX2-c: the summary and the export name an intent status in the customer UI words', async () => {
  const ctx = conversation('omar', 'conv-fx2c');
  const proposed = (await runTool(
    'transfer_money',
    { fromAccountId: 'acc-omar', toAccountId: 'acc-bruno', amountCents: 111, concept: 'Coffee' },
    ctx(),
  )) as any;
  assert.equal(proposed.status, 'requires_confirmation');
  const { incidentId } = (await runTool('request_human', { summary: 'Help' }, ctx())) as any;
  const d = (await caseDetail('marta', incidentId)) as any;
  assert.equal(d.intents[0].status, 'awaiting_confirmation', 'the machine field keeps the value');
  const line = d.summary.text.find((t: string) => t.startsWith('Transfer intent'));
  assert.equal(
    line,
    "Transfer intent €1.11 to Bruno Vidal · Horizon account: pending the customer's confirmation, never sent to the bank.",
  );
  const html = (await exportCase('marta', incidentId, 'html')).body;
  assert.ok(html.includes('App status: Pending the customer&#39;s confirmation'));
  // An operator is not the "you" of the customer's labels: no status reads in the second person.
  for (const s of Object.keys(ui.TRANSFER_STATUS_LABELS))
    assert.doesNotMatch(ui.operatorTransferStatusLabel(s), /\byou(r)?\b/i, s);
  assert.ok(!html.includes('awaiting_confirmation'));
});

test('FX2-c: a validation message names the field in words', async () => {
  const ctx = conversation('omar', 'conv-fx2c-fields');
  const missing = (await runTool(
    'transfer_money',
    { toAccountId: 'acc-bruno', amountCents: 111, concept: 'Coffee' },
    ctx(),
  )) as any;
  assert.equal(missing.code, 'invalid_request');
  assert.equal(missing.error, 'Some details are missing or invalid: source account.');
  // The model reads this result: the argument to fix stays named beside the words.
  assert.deepEqual(missing.fields, ['fromAccountId']);
  const bad = (await runTool('cancel_transfer', { approvalId: 7 }, ctx())) as any;
  assert.equal(bad.error, 'Some details are missing or invalid: proposal.');
});

test('FX2-d: every recorded handoff summary is listed, in order, with its time', async () => {
  const ctx = conversation('omar', 'conv-fx2d');
  const first = (await runTool('request_human', { summary: 'Omar disputes a charge.' }, ctx())) as {
    incidentId: string;
  };
  const second = (await runTool(
    'request_human',
    { summary: 'Omar now also asks for a call back.' },
    ctx(),
  )) as { incidentId: string };
  assert.equal(second.incidentId, first.incidentId);
  const d = (await caseDetail('marta', first.incidentId)) as any;
  assert.deepEqual(
    d.summary.handoffs.map((h: any) => h.summary),
    ['Omar disputes a charge.', 'Omar now also asks for a call back.'],
  );
  for (const h of d.summary.handoffs) assert.match(h.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(
    d.summary.text.filter((t: string) => t.startsWith('Assistant handoff: ')),
    [
      'Assistant handoff: Omar disputes a charge.',
      'Assistant handoff: Omar now also asks for a call back.',
    ],
  );
  // The inbox keeps the summary the case was opened with.
  assert.equal(d.incident.summary, 'Omar disputes a charge.');
});
