// R2, R5–R8: recipients by person, cancel, server-side outcome notes, automatic re-check and the
// per-transfer timeline. Simulator bank, no model calls.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
const { temp } = await setupEnv('banana-recipients-');
const { seedBank } = await import('../simulator/seed');
const { bankDb, closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { appDb, closeAppDb } = await import('../src/db');
const { runTool } = await import('../src/agent/tools');
const { findRecipients, groupRecipients } = await import('../src/banking/recipients');
let bank: ChildProcess;
before(async () => {
  seedBank();
  bank = await startSimulator();
  setScenario('normal');
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
let n = 0;
const propose = async (userId: string, args: Record<string, unknown>) =>
  (
    await callApi(userId, 'actions', {
      name: 'transfer_money',
      arguments: { fromAccountId: `acc-${userId}`, amountCents: 100, concept: `R ${++n}`, ...args },
      intentId: `r-${n}`,
    })
  ).body;

test('R2 main account rule: first non-savings account whatever the order; savings-only → first', () => {
  const contacts = [
    { id: 'acc-carla-savings', userId: 'carla', name: 'Carla Ríos', label: 'Personal savings' },
    { id: 'acc-carla', userId: 'carla', name: 'Carla Ríos', label: 'Aurora account' },
    { id: 'acc-x-savings', userId: 'x', name: 'Xavi Soler', label: 'Savings' },
    { id: 'acc-y', name: 'Yago Sanz', label: 'Horizon account' },
  ];
  assert.deepEqual(
    groupRecipients(contacts).map((p) => [p.key, p.main.id, p.accounts.length]),
    [
      ['carla', 'acc-carla', 2],
      ['x', 'acc-x-savings', 1],
      ['Yago Sanz', 'acc-y', 1],
    ],
  );
  for (const ref of ['carla', 'Carla Ríos', 'carla rios', 'CARLA'])
    assert.equal(findRecipients(contacts, ref)[0]?.main.id, 'acc-carla', ref);
  const twins = [
    { id: 'acc-a', userId: 'u1', name: 'Ana Gil', label: 'Aurora account' },
    { id: 'acc-b', userId: 'u2', name: 'Ana Paz', label: 'Aurora account' },
  ];
  assert.equal(findRecipients(twins, 'Ana').length, 2, 'a shared first name is ambiguous');
  assert.equal(findRecipients(twins, 'ana paz')[0].main.id, 'acc-b');
});

test('R2 a person resolves to their main account; the proposal names the exact account', async () => {
  const r = await propose('hugo', { recipient: 'Carla Ríos', toAccountId: null });
  assert.equal(r.status, 'requires_confirmation', JSON.stringify(r));
  assert.equal(r.approval.toAccountId, 'acc-carla');
  assert.deepEqual(r.destination, {
    accountId: 'acc-carla',
    name: 'Carla Ríos',
    label: 'Aurora account',
    main: true,
  });
  const { body } = await callApi('hugo', 'dashboard');
  const stored = body.approvals.find((a: any) => a.id === r.approval.id);
  assert.equal(stored.payload.toAccountId, 'acc-carla');
});

test('R2 an explicit account of the recipient wins over the main account', async () => {
  const r = await propose('hugo', { recipient: 'carla', toAccountId: 'acc-carla-savings' });
  assert.equal(r.approval.toAccountId, 'acc-carla-savings');
  assert.equal(r.destination.main, false);
});

test('R2 the same intent retried with a recipient returns the same proposal', async () => {
  const args = {
    name: 'transfer_money',
    arguments: { fromAccountId: 'acc-hugo', recipient: 'carla', amountCents: 250, concept: 'Same' },
    intentId: 'r-same',
  };
  const a = (await callApi('hugo', 'actions', args)).body;
  const b = (await callApi('hugo', 'actions', args)).body;
  assert.equal(a.status, 'requires_confirmation');
  assert.equal(b.approval.id, a.approval.id);
});

test('R2 unknown or missing recipient: nothing proposed, recipients listed', async () => {
  const r = await propose('hugo', { recipient: 'Zoe' });
  assert.equal(r.status, 'failed');
  assert.equal(r.code, 'invalid_destination');
  assert.ok(r.recipients.includes('Carla Ríos'), JSON.stringify(r.recipients));
  const missing = await propose('hugo', {});
  assert.equal(missing.status, 'failed');
  assert.equal(missing.code, 'invalid_request');
});

test('R2 agent: a two-account customer is still asked for their own source account', async () => {
  const r = (await runTool(
    'transfer_money',
    {
      fromAccountId: null,
      recipient: 'Bruno',
      toAccountId: null,
      amountCents: 100,
      concept: 'x',
      secondTransfer: null,
    },
    { userId: 'lucia', conversationId: null, runId: 'run-r2', intentId: 'run-r2:call' },
  )) as any;
  assert.equal(r.status, 'needs_source_account');
  const ok = (await runTool(
    'transfer_money',
    {
      fromAccountId: 'acc-lucia',
      recipient: 'Bruno',
      toAccountId: null,
      amountCents: 100,
      concept: 'x',
      secondTransfer: null,
    },
    { userId: 'lucia', conversationId: null, runId: 'run-r2', intentId: 'run-r2:call2' },
  )) as any;
  assert.equal(ok.status, 'requires_confirmation');
  assert.equal(ok.approval.toAccountId, 'acc-bruno');
});

const bankOpCount = () =>
  (bankDb().prepare('SELECT COUNT(*) n FROM operations').get() as { n: number }).n;
const eventsOf = (kind: string, intentId: string) =>
  appDb()
    .prepare("SELECT * FROM events WHERE kind=? AND json_extract(data,'$.intentId')=?")
    .all(kind, intentId);

test('R5 cancel: owner only, idempotent, recorded; confirm afterwards fails, no bank call', async () => {
  const ops = bankOpCount();
  const p = await propose('hugo', { recipient: 'carla' });
  assert.equal((await callApi('carla', `approvals/${p.approval.id}/cancel`, {})).status, 404);
  const first = await callApi('hugo', `approvals/${p.approval.id}/cancel`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'cancelled');
  assert.match(first.body.message, /No money moved/);
  const again = await callApi('hugo', `approvals/${p.approval.id}/cancel`, {});
  assert.equal(again.body.status, 'cancelled');
  const confirm = await callApi('hugo', `approvals/${p.approval.id}/confirm`, {});
  assert.equal(confirm.status, 409);
  assert.deepEqual(confirm.body, {
    status: 'failed',
    error: 'This proposal was cancelled. No money moved.',
  });
  const intent = appDb().prepare('SELECT * FROM intents WHERE id=?').get(p.intentId) as any;
  assert.equal(intent.status, 'cancelled');
  assert.equal(intent.bank_reference, null, 'never dispatched');
  assert.equal(bankOpCount(), ops);
  assert.equal(eventsOf('transfer.cancelled', p.intentId).length, 1, 'recorded once');
  const { body } = await callApi('hugo', 'dashboard');
  assert.ok(!body.approvals.some((a: any) => a.id === p.approval.id));
});

test('R5 a confirmed proposal cannot be cancelled; the agent tool cancels a pending one', async () => {
  const done = await propose('hugo', { recipient: 'carla' });
  const c = await callApi('hugo', `approvals/${done.approval.id}/confirm`, {});
  assert.equal(c.body.status, 'completed');
  const late = await callApi('hugo', `approvals/${done.approval.id}/cancel`, {});
  assert.equal(late.status, 409);
  const p = await propose('hugo', { recipient: 'carla' });
  const viaTool = (await runTool(
    'cancel_transfer',
    { approvalId: p.approval.id },
    { userId: 'hugo', conversationId: null, runId: 'run-r5', intentId: 'run-r5:c' },
  )) as any;
  assert.equal(viaTool.status, 'cancelled');
  const old = await propose('hugo', { recipient: 'carla', amountCents: 103 });
  appDb()
    .prepare("UPDATE approvals SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?")
    .run(old.approval.id);
  assert.equal((await callApi('hugo', `approvals/${old.approval.id}/cancel`, {})).status, 410);
});

const conversation = async (userId: string) =>
  (await callApi(userId, 'conversations', {})).body.id as string;
const notes = async (userId: string, id: string) =>
  (await callApi(userId, `conversations/${id}`)).body.messages.filter((m: any) =>
    String(m.run_id).startsWith('outcome:'),
  );
const proposeIn = async (conversationId: string, amountCents: number, concept: string) =>
  (
    await callApi('hugo', 'actions', {
      name: 'transfer_money',
      arguments: { fromAccountId: 'acc-hugo', recipient: 'carla', amountCents, concept },
      intentId: concept,
      conversationId,
    })
  ).body;

test('R6 the confirm outcome is stored in the conversation once, visible to any client', async () => {
  const conv = await conversation('hugo');
  const p = await proposeIn(conv, 321, 'R6');
  await callApi('hugo', `approvals/${p.approval.id}/confirm`, {});
  await callApi('hugo', `approvals/${p.approval.id}/confirm`, {});
  const lines = await notes('hugo', conv);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].role, 'assistant');
  assert.equal(lines[0].run_id, `outcome:notice:${p.intentId}`);
  assert.equal(
    lines[0].content,
    '€3.21 to Carla Ríos · Aurora account (R6): Transfer completed. You can see it under “Your transfers”, on the Transfers page.',
  );
  const p2 = await proposeIn(conv, 322, 'R6b');
  await callApi('hugo', `approvals/${p2.approval.id}/cancel`, {});
  const after = await notes('hugo', conv);
  assert.equal(after.length, 2);
  assert.match(after[1].content, /R6b\): Proposal cancelled\. No money moved\./);
});

const status = (id: string) =>
  (appDb().prepare('SELECT status FROM intents WHERE id=?').get(id) as { status: string }).status;

test('R7 a dashboard load re-checks a pending_verification transfer, throttled', async () => {
  const conv = await conversation('hugo');
  const p = await proposeIn(conv, 401, 'R7');
  await callApi('hugo', `approvals/${p.approval.id}/confirm`, {});
  // The bank committed it but the app lost the answer (as after a timeout).
  const pending = () =>
    appDb()
      .prepare("UPDATE intents SET status='pending_verification',operation_id=NULL WHERE id=?")
      .run(p.intentId);
  pending();
  await callApi('hugo', 'dashboard');
  assert.equal(status(p.intentId), 'completed');
  assert.equal(eventsOf('transfer.verified', p.intentId).length, 1);
  assert.match((await notes('hugo', conv)).at(-1).content, /R7\): Transfer completed/);
  pending();
  await callApi('hugo', 'dashboard');
  assert.equal(status(p.intentId), 'pending_verification', 'no second lookup within 30 s');
});

test('R8 the timeline lists only recorded steps', async () => {
  const ok = await propose('bruno', { recipient: 'carla', concept: 'R8 ok' });
  await callApi('bruno', `approvals/${ok.approval.id}/confirm`, {});
  const off = await propose('bruno', { recipient: 'carla', concept: 'R8 off' });
  await callApi('bruno', `approvals/${off.approval.id}/cancel`, {});
  const waiting = await propose('bruno', { recipient: 'carla', concept: 'R8 wait' });
  const { body } = await callApi('bruno', 'dashboard');
  const kinds = (intentId: string) => {
    const t = body.transfers.find((x: any) => x.intentId === intentId);
    return [t.status, ...t.steps.map((s: any) => s.kind)];
  };
  assert.deepEqual(kinds(ok.intentId), [
    'completed',
    'proposed',
    'confirmed',
    'started',
    'completed',
  ]);
  assert.deepEqual(kinds(off.intentId), ['cancelled', 'proposed', 'cancelled']);
  assert.deepEqual(kinds(waiting.intentId), ['awaiting_confirmation', 'proposed']);
  assert.equal(body.transfers[0].intentId, waiting.intentId, 'newest first');
  // Retries and verification are steps only when recorded (R7 above recorded one for hugo).
  const hugo = (await callApi('hugo', 'dashboard')).body.transfers;
  assert.ok(hugo.some((t: any) => t.steps.some((s: any) => s.kind === 'verified')));
});
