// AR1-a hardening (open items of the PR #83 review). Deterministic: no model call, simulator on a
// free port. A correction may only replace a proposal that is still pending when it is replaced;
// replacesApprovalId is a string or null at the boundary; "" means null.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeOpenAI, say } from './helpers/openai';
import { callApi, setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-ar1h-');
const { server } = await fakeOpenAI(() => say('OK.'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { runTool } = await import('../src/agent/tools');
const { cancelApproval, confirmApproval, transferTimelines } =
  await import('../src/banking/actions');
const { caseDetail } = await import('../src/operator/view');
seedApp();
const bank = await startSimulator();
const { newConversation } = await import('./helpers/data');

type Result = {
  status: string;
  code?: string;
  error?: string;
  approval?: { id: string };
  replaced?: { status: string };
  pending?: { approvalId: string; amountCents: number }[];
};
let n = 0;
const args = (amountCents: number, replacesApprovalId?: unknown) => ({
  fromAccountId: 'acc-omar',
  recipient: 'Hugo',
  toAccountId: null,
  amountCents,
  concept: 'Dinner',
  replacesApprovalId,
});
const propose = (conversationId: string, amountCents: number, replacesApprovalId?: unknown) =>
  runTool('transfer_money', args(amountCents, replacesApprovalId), {
    userId: 'omar',
    conversationId,
    runId: `run-ar1h-${n}`,
    intentId: `ar1h-${n++}`,
  }) as Promise<Result>;
const api = (conversationId: string, intentId: string, amountCents: number, replaces?: unknown) =>
  callApi('omar', 'actions', {
    name: 'transfer_money',
    arguments: args(amountCents, replaces),
    conversationId,
    intentId,
  }) as Promise<{ status: number; body: Result }>;
const pending = (conversationId: string) =>
  (
    appDb()
      .prepare(
        `SELECT json_extract(a.payload,'$.amountCents') cents FROM approvals a
         JOIN intents i ON i.id=a.intent_id
         WHERE i.conversation_id=? AND a.consumed_at IS NULL AND a.expires_at>? ORDER BY cents`,
      )
      .all(conversationId, new Date().toISOString()) as { cents: number }[]
  ).map((p) => p.cents);
const notes = (conversationId: string) =>
  (
    appDb()
      .prepare(
        "SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND run_id LIKE 'outcome:%'",
      )
      .get(conversationId) as { n: number }
  ).n;

test('AR1-a: a correction naming an already cancelled proposal is refused and names the live one', async () => {
  const id = newConversation('omar');
  const first = await propose(id, 5000);
  const second = await propose(id, 4000, first.approval!.id);
  assert.equal(second.replaced?.status, 'cancelled');
  // 50 -> 40 -> 30, but the model names the 50 one again (stale id).
  const stale = await propose(id, 3000, first.approval!.id);
  assert.equal(stale.status, 'failed');
  assert.equal(stale.code, 'proposal_not_pending');
  assert.match(stale.error!, /cancelled.*Nothing new was proposed/);
  assert.ok(stale.pending!.some((p) => p.approvalId === second.approval!.id));
  assert.deepEqual(pending(id), [4000]);
  // Naming the live one works.
  const third = await propose(id, 3000, second.approval!.id);
  assert.equal(third.replaced?.status, 'cancelled');
  assert.deepEqual(pending(id), [3000]);
});

test('AR1-a: two concurrent corrections of one proposal leave exactly one pending', async () => {
  const id = newConversation('omar');
  const old = await propose(id, 1010);
  const results = await Promise.all(
    [1020, 1030].map((cents) => propose(id, cents, old.approval!.id)),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), ['failed', 'requires_confirmation']);
  const won = results.find((r) => r.status === 'requires_confirmation')!,
    lost = results.find((r) => r.status === 'failed')!;
  assert.equal(won.replaced?.status, 'cancelled');
  assert.equal(lost.code, 'proposal_not_pending');
  assert.equal(pending(id).length, 1);
  assert.ok(lost.pending!.some((p) => p.approvalId === won.approval!.id));
});

test('AR1-a: a confirm that wins the race refuses the correction and leaves nothing pending', async () => {
  const id = newConversation('omar');
  const old = await propose(id, 1110);
  // runTool runs synchronously up to its first bank call: the old proposal is consumed in the gap.
  const correction = propose(id, 1120, old.approval!.id);
  appDb()
    .prepare('UPDATE approvals SET consumed_at=? WHERE id=?')
    .run(new Date().toISOString(), old.approval!.id);
  appDb()
    .prepare(
      "UPDATE intents SET status='completed' WHERE id=(SELECT intent_id FROM approvals WHERE id=?)",
    )
    .run(old.approval!.id);
  const result = await correction;
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /already confirmed/);
  assert.deepEqual(pending(id), []);
});

test('AR1-a: retrying the same correction intent still converges on one proposal', async () => {
  const id = newConversation('omar');
  const old = (await api(id, 'h-old', 910)).body.approval!.id;
  const sequential = [await api(id, 'h-new', 920, old), await api(id, 'h-new', 920, old)];
  const old2 = (await api(id, 'h-old2', 930)).body.approval!.id;
  const concurrent = await Promise.all([0, 1, 2].map(() => api(id, 'h-new2', 940, old2)));
  for (const group of [sequential, concurrent]) {
    assert.equal(new Set(group.map((r) => r.body.approval?.id)).size, 1);
    for (const r of group) assert.equal(r.body.replaced?.status, 'cancelled');
  }
  assert.deepEqual(pending(id), [920, 940]);
  assert.equal(notes(id), 2, 'one closing line per replaced proposal, none for the retries');
});

test('AR1-a: an expired proposal is not live: the correction is proposed, nothing is double', async () => {
  const id = newConversation('omar');
  const old = await propose(id, 1210);
  appDb()
    .prepare("UPDATE approvals SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?")
    .run(old.approval!.id);
  const next = await propose(id, 1220, old.approval!.id);
  assert.equal(next.status, 'requires_confirmation');
  assert.equal(next.replaced?.status, 'not_cancelled');
  assert.deepEqual(pending(id), [1220]);
});

test('AR1-a: replacesApprovalId that is not a string or null is invalid_request, no driver text', async () => {
  const id = newConversation('omar');
  const old = await propose(id, 510);
  for (const bad of [true, false, 123, {}, { id: old.approval!.id }, [old.approval!.id], []]) {
    const { status, body } = await api(id, `h-bad-${n++}`, 520, bad);
    const label = JSON.stringify(bad);
    assert.equal(status, 200, label); // integration surface: tool errors are not HTTP errors
    assert.equal(body.status, 'failed', label);
    assert.equal(body.code, 'invalid_request', label);
    assert.equal(body.error, 'Some details are missing or invalid: proposal to replace.', label);
  }
  assert.deepEqual(pending(id), [510]);
});

test('AR1-a: an empty replacesApprovalId is null: a separate proposal, nothing replaced', async () => {
  const id = newConversation('omar');
  await propose(id, 610);
  for (const [i, empty] of ['', '  '].entries()) {
    const next = await propose(id, 620 + i, empty);
    assert.equal(next.status, 'requires_confirmation');
    assert.equal(next.replaced, undefined);
  }
  assert.deepEqual(pending(id), [610, 620, 621]);
});

// Reviewer probe R8b of PR #84: who closed a proposal is a recorded fact, not always the customer.
const customerSteps = (cents: number) =>
  transferTimelines('omar', 50)
    .find((t) => t.transfer.amountCents === cents)!
    .steps.map((s) => s.label)
    .join(' | ');
const operatorText = async (conversationId: string) => {
  const opened = (await runTool(
    'request_human',
    { summary: 'I did not cancel anything' },
    { userId: 'omar', conversationId, runId: `run-ar1h-case-${n}`, intentId: `ar1h-case-${n++}` },
  )) as { incidentId: string };
  return JSON.stringify(await caseDetail('marta', opened.incidentId));
};

test('AR1-a: a proposal withdrawn by the server is not attributed to the customer', async () => {
  const id = newConversation('omar');
  const old = await propose(id, 7000);
  // The customer confirms the old one while its correction is reading the bank: the confirm wins.
  const [correction, confirmed] = await Promise.all([
    propose(id, 7100, old.approval!.id),
    confirmApproval('omar', old.approval!.id),
  ]);
  assert.equal(confirmed.status, 'completed');
  assert.equal(correction.code, 'proposal_not_pending');
  assert.match(customerSteps(7100), /Withdrawn automatically.*No money moved/);
  assert.doesNotMatch(customerSteps(7100), /by you/i);
  const operator = await operatorText(id);
  assert.match(operator, /Correction withdrawn by the app/);
  assert.doesNotMatch(operator, /cancelled by the customer/i);
});

test('AR1-a: a replaced proposal says replaced; a customer cancel keeps its wording', async () => {
  const id = newConversation('omar');
  const old = await propose(id, 7200);
  const next = await propose(id, 7300, old.approval!.id);
  assert.equal(next.replaced?.status, 'cancelled');
  assert.match(customerSteps(7200), /Replaced by a corrected proposal\. No money moved/);
  assert.doesNotMatch(customerSteps(7200), /by you/i);
  await cancelApproval('omar', next.approval!.id);
  assert.match(customerSteps(7300), /Cancelled by you\. No money moved/);
  const operator = await operatorText(id);
  // One replaced proposal and one customer cancel: each wording appears equally often (the case
  // view renders a step in more than one place).
  const count = (re: RegExp) => operator.match(re)?.length ?? 0;
  assert.ok(count(/Proposal replaced by a corrected proposal\. No money moved/g) > 0);
  assert.equal(
    count(/Proposal cancelled by the customer/g),
    count(/Proposal replaced by a corrected proposal/g),
  );
});

after(() => {
  bank.kill();
  closeAppDb();
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
