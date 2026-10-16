// AR1 (two parked assistant defects). Deterministic: fake OpenAI server, simulator on a free port.
// AR1-a: a corrected proposal left the old one confirmable. AR1-b: the conversation state told
// the model that a cancelled transfer had been sent.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { call, fakeOpenAI, say } from './helpers/openai';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-ar1-');
const { server, modelRequests, script } = await fakeOpenAI(() => say('OK.'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const run = await import('../src/agent/run');
const { runTool, toolDefinitions, transferInstructions } = await import('../src/agent/tools');
const { confirmApproval, cancelApproval } = await import('../src/banking/actions');
const { INTENT_STATUSES } = await import('../src/types');
seedApp();
const bank = await startSimulator();
const { newConversation, operations } = await import('./helpers/data');

type Proposal = { status: string; approval: { id: string }; replaced?: { status: string } };
let n = 0;
const propose = (userId: string, conversationId: string, args: object) =>
  runTool(
    'transfer_money',
    { fromAccountId: `acc-${userId}`, toAccountId: null, concept: 'Dinner', ...args },
    { userId, conversationId, runId: 'run-ar1', intentId: `ar1-${n++}` },
  ) as Promise<Proposal>;
const pending = (conversationId: string) =>
  appDb()
    .prepare(
      `SELECT a.id, json_extract(a.payload,'$.amountCents') cents FROM approvals a
       JOIN intents i ON i.id=a.intent_id
       WHERE i.conversation_id=? AND a.consumed_at IS NULL ORDER BY cents`,
    )
    .all(conversationId) as { id: string; cents: number }[];
const stateLines = (userId: string, conversationId: string) =>
  run
    .conversationState(userId, conversationId, [], [])
    .split('\n')
    .filter((l) => l.startsWith('- €'));

test('AR1-b: a cancelled proposal is stated as never sent, not as sent and being verified', async () => {
  const id = newConversation('lucia');
  const { approval } = await propose('lucia', id, { recipient: 'Bruno', amountCents: 1500 });
  await cancelApproval('lucia', approval.id);
  const [line] = stateLines('lucia', id);
  assert.match(line, /cancelled.*never sent.*no money moved/i);
  assert.doesNotMatch(line, /being verified|do not repeat/);
});

test('AR1-b: every intent status has its own wording; only sent ones say "do not repeat"', () => {
  const id = newConversation('lucia');
  const payload = JSON.stringify({
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    amountCents: 100,
    concept: 'x',
  });
  const text: Record<string, string> = {};
  for (const status of INTENT_STATUSES) {
    appDb().prepare('DELETE FROM intents WHERE conversation_id=?').run(id);
    appDb()
      .prepare('INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(`ar1-s-${status}`, 'lucia', id, 'r', payload, status, null, null, null, '2026-01-01');
    text[status] = stateLines('lucia', id)[0].split(': ').slice(1).join(': ');
  }
  assert.equal(new Set(Object.values(text)).size, INTENT_STATUSES.length, JSON.stringify(text));
  assert.match(text.created, /not sent/);
  assert.doesNotMatch(text.created, /being verified/);
  assert.match(text.processing, /outcome not known yet; do not repeat/);
  assert.match(text.pending_verification, /being verified.*do not repeat/);
});

test('AR1-a: a correction in the chat closes the earlier proposal; only the new one can be confirmed', async () => {
  const id = newConversation('omar');
  const transfer = (amountCents: number, replacesApprovalId: string | null) => ({
    fromAccountId: 'acc-omar',
    recipient: 'Hugo',
    toAccountId: null,
    amountCents,
    concept: 'Dinner',
    secondTransfer: null,
    replacesApprovalId,
  });
  script.push(
    () => call('transfer_money', transfer(5000, null)),
    () => say('Please review the €50.00 proposal.'),
  );
  await run.sendMessage('omar', id, 'Send 50 euros to Hugo for dinner');
  const [old] = pending(id);
  assert.equal(old.cents, 5000);
  const before = operations('omar');
  script.push(
    () => call('transfer_money', transfer(4000, old.id)),
    () => say('I cancelled the €50.00 proposal; please review the €40.00 one.'),
  );
  await run.sendMessage('omar', id, 'No, 40 not 50');
  const output = JSON.parse(
    modelRequests.at(-1)!.input.find((i) => i.type === 'function_call_output')!.output!,
  );
  assert.equal(output.status, 'requires_confirmation');
  assert.equal(output.replaced?.status, 'cancelled');
  assert.equal(output.replaced?.approvalId, old.id);
  assert.deepEqual(
    pending(id).map((p) => p.cents),
    [4000],
  );
  // The superseded proposal can never move money.
  await assert.rejects(confirmApproval('omar', old.id), /cancelled\. No money moved/);
  assert.equal(operations('omar'), before);
  // Clear state: the customer and the operator see the closing line; the next turn's digest too.
  const notes = appDb()
    .prepare("SELECT content FROM messages WHERE conversation_id=? AND run_id LIKE 'outcome:%'")
    .all(id) as { content: string }[];
  assert.equal(notes.length, 1);
  assert.match(notes[0].content, /€50\.00 to Hugo.*cancelled/i);
  const lines = stateLines('omar', id);
  assert.match(lines[0], /€40\.00 .*awaiting the customer's confirmation/);
  assert.match(lines[1], /€50\.00 .*cancelled.*never sent/);
  // The only pending proposal still executes.
  assert.equal((await confirmApproval('omar', pending(id)[0].id)).status, 'completed');
  assert.equal(operations('omar'), before + 1);
});

test('AR1-a: a refused correction leaves the earlier proposal as it was (new first, then close)', async () => {
  const id = newConversation('omar');
  const old = await propose('omar', id, { recipient: 'Hugo', amountCents: 5100 });
  const refused = await propose('omar', id, {
    recipient: 'Hugo',
    amountCents: 9_000_000,
    replacesApprovalId: old.approval.id,
  });
  assert.equal(refused.status, 'failed');
  assert.equal(refused.replaced, undefined);
  assert.deepEqual(pending(id), [{ id: old.approval.id, cents: 5100 }]);
});

test("AR1-a: another customer's proposal cannot be replaced, and nothing is proposed", async () => {
  const mine = newConversation('omar'),
    theirs = newConversation('lucia');
  const foreign = await propose('lucia', theirs, { recipient: 'Bruno', amountCents: 5200 });
  const result = await propose('omar', mine, {
    recipient: 'Hugo',
    amountCents: 4200,
    replacesApprovalId: foreign.approval.id,
  });
  assert.equal(result.status, 'failed');
  assert.equal(pending(mine).length, 0);
  assert.deepEqual(pending(theirs), [{ id: foreign.approval.id, cents: 5200 }]);
});

test('AR1-a: a confirmed proposal cannot be replaced: nothing new is proposed', async () => {
  const id = newConversation('omar');
  const old = await propose('omar', id, { recipient: 'Hugo', amountCents: 300 });
  assert.equal((await confirmApproval('omar', old.approval.id)).status, 'completed');
  const result = (await propose('omar', id, {
    recipient: 'Hugo',
    amountCents: 400,
    replacesApprovalId: old.approval.id,
  })) as Proposal & { error: string };
  assert.equal(result.status, 'failed');
  assert.match(result.error, /already confirmed/);
  assert.equal(pending(id).length, 0);
});

test('AR1-a: two separate transfers in one conversation both stay pending', async () => {
  const id = newConversation('omar');
  await propose('omar', id, { recipient: 'Hugo', amountCents: 2000, replacesApprovalId: null });
  await propose('omar', id, { recipient: 'Carla', amountCents: 3000, replacesApprovalId: null });
  assert.deepEqual(
    pending(id).map((p) => p.cents),
    [2000, 3000],
  );
});

test('AR1-a: the model must answer replacesApprovalId on every call and is told how', () => {
  const tool = toolDefinitions.find((t) => t.name === 'transfer_money')!;
  assert.ok((tool.parameters!.required as string[]).includes('replacesApprovalId'));
  assert.match(transferInstructions, /replacesApprovalId/);
});

after(() => {
  bank.kill();
  closeAppDb();
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
