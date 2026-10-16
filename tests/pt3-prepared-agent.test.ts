// PT3 (plan 25 §5, REQ-PT-15, 16): prepared transfers in the chat. Scripted turns on the fake
// OpenAI server (no paid call), the demo bank, DECIDER=none. One check per real risk of a money
// path: preparing writes no proposal and sends nothing; sending only proposes, once, and money
// moves once through confirmApproval; another customer's id is not found; nothing is guessed;
// the customer's note never becomes instructions; no product suggestion on these turns.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { call, fakeOpenAI, say, type ModelBody } from './helpers/openai';
import { callApi, setupEnv, startSimulator } from './helpers/bank';

const { temp } = await setupEnv('banana-pt3-');
Object.assign(process.env, {
  DECIDER: 'none',
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { server, modelRequests, script } = await fakeOpenAI(() => say('OK.'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { prepareTransfer, preparedList, today } = await import('../src/banking/prepared');
const { preparedInstructions } = await import('../src/agent/prepared');
const { runTool, toolDefinitions } = await import('../src/agent/tools');
const { newConversation } = await import('./helpers/data');
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

type Any = Record<string, any>;
// Hugo holds one account; Lucía holds two. Bank requests are counted here by method and path.
const USER = 'hugo';
const NOTE = 'when I get the keys ZZNOTE';
const CONCEPT = 'ZZCONCEPT rent';
const TOOLS = ['prepare_transfer', 'list_prepared_transfers', 'send_prepared_transfer'];
const bankCalls: string[] = [];
const realFetch = globalThis.fetch;
let twins = false;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(process.env.BANK_URL!)) return realFetch(input, init);
  const path = new URL(url).pathname;
  bankCalls.push(`${init?.method ?? 'GET'} ${path}`);
  // The seeded names are all distinct: two people called Ana make a first name ambiguous.
  if (twins && path === '/v1/contacts')
    return Response.json([
      { id: 'acc-ana-1', userId: 'ana1', name: 'Ana Ruiz', label: 'Horizon account' },
      { id: 'acc-ana-2', userId: 'ana2', name: 'Ana Soto', label: 'Horizon account' },
    ]);
  return realFetch(input, init);
};
const sent = () => bankCalls.filter((c) => c === 'POST /v1/transfers').length;
const A = 'GET /v1/accounts',
  C = 'GET /v1/contacts';
// Accounts and contacts reads of a turn (a movements read is the digest's or the offer chooser's:
// tests/it1-agent-bank-reads.test.ts; the prepared tools never read movements).
const reads = () => bankCalls.filter((c) => c === A || c === C).sort();
const count = (table: string) =>
  (appDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
// The seed holds one historic intent of Lucía's: only Hugo's are counted.
const intents = () => count(`intents WHERE user_id='${USER}'`);
const events = (kind: string) => count(`events WHERE kind='${kind}'`);
const ctx = (userId: string, intentId = 'pt3') => ({
  userId,
  conversationId: null,
  runId: 'run-pt3',
  intentId,
});
const rent = (extra: object = {}) => ({
  fromAccountId: null,
  recipient: 'Lucia',
  toAccountId: null,
  amountCents: 85000,
  concept: CONCEPT,
  note: NOTE,
  when: 'manual',
  date: null,
  inDays: null,
  day: null,
  ...extra,
});
// What the model was handed back for its tool calls in the turn's last request.
const outputs = (body: ModelBody) =>
  body.input.filter((i) => i.type === 'function_call_output').map((i) => JSON.parse(i.output!));
const prepare = () => call('prepare_transfer', rent());
const list = () => call('list_prepared_transfers', {});
// The id is the one list_prepared_transfers returned in this turn, as the model would read it.
const send = (body: ModelBody) =>
  call('send_prepared_transfer', {
    preparedId: outputs(body)
      .reverse()
      .find((o) => o.prepared)!.prepared[0].id,
  });
const PARAGRAPH =
  'A suggestion: the Savings Pot is a separate account to set money aside, which may fit because you keep a balance in your main account.';
const suggest = () => say(`Done.\n\n[offer-savings-pot] ${PARAGRAPH}`);
// One turn through the HTTP route, as the page sends it.
async function turn(
  conversationId: string,
  content: string,
  calls: ((b: ModelBody) => object)[] = [],
) {
  script.push(...calls);
  bankCalls.length = 0;
  const post = await callApi(USER, `conversations/${conversationId}/messages`, { content });
  assert.equal(post.status, 200, JSON.stringify(post.body));
  const { messages } = (await callApi(USER, `conversations/${conversationId}`)).body;
  const last = modelRequests.at(-1)!;
  return {
    message: messages.at(-1) as { content: string; extras: Any | null },
    instructions: last.instructions,
    outputs: outputs(last),
    reads: reads(),
  };
}
// A fresh app and a conversation whose first turn is done (a first turn never gets a suggestion).
async function opened() {
  seedApp();
  const conversationId = newConversation(USER);
  await turn(conversationId, 'Hello');
  return conversationId;
}

test('PT3 definitions: three strict tools; POST /api/actions refuses them', async () => {
  const defined = new Map(toolDefinitions.map((t) => [t.name, t]));
  for (const name of TOOLS) {
    assert.equal(defined.get(name)?.strict, true, name);
    assert.equal((await callApi(USER, 'actions', { name, arguments: {} })).status, 400, name);
  }
  assert.equal(count('prepared_transfers') + intents() + count('approvals'), 0);
});

test('REQ-PT-15 prepare_transfer stores the row with the note: no intent, no approval, nothing sent; the note never reaches the instructions', async () => {
  const conversationId = await opened();
  const t = await turn(conversationId, 'Prepare the rent for Lucía, 850, for when I get the keys', [
    prepare,
    () => say('It is prepared, not sent.'),
  ]);
  assert.equal(t.outputs[0].status, 'prepared');
  assert.match(t.outputs[0].notice, /not sent/);
  const [row] = preparedList(USER);
  assert.deepEqual(
    [row.to, row.amountCents, row.note, row.state, row.when.kind],
    ['Lucía Martín · Aurora account', 85000, NOTE, 'ready', 'manual'],
  );
  assert.equal(intents() + count('approvals') + sent(), 0);
  // The turn's two reads plus the two of prepareTransfer (resolveTransfer); no movements read.
  assert.deepEqual(t.reads, [A, A, C, C]);
  assert.equal(t.message.extras, null);

  // The server makes the date of "in 7 days".
  const dated = (await runTool(
    'prepare_transfer',
    rent({ when: 'on_date', inDays: 7 }),
    ctx(USER),
  )) as Any;
  const inSeven = new Date(Date.parse(today()) + 7 * 864e5).toISOString().slice(0, 10);
  assert.deepEqual(dated.prepared.when, { kind: 'on_date', date: inSeven });

  // A later turn lists them: the customer's text is in the tool result (data), never in the
  // instructions, which are the fixed block. A list reads no bank beyond the turn's own reads.
  const next = await turn(conversationId, 'What do I have prepared?', [list, () => say('Two.')]);
  assert.equal(next.outputs[0].prepared.length, 2);
  assert.equal(next.outputs[0].prepared[0].note, NOTE);
  assert.deepEqual(next.reads, [A, C]);
  assert.ok(next.instructions.includes(preparedInstructions));
  assert.ok(!next.instructions.includes('ZZNOTE') && !next.instructions.includes('ZZCONCEPT'));
});

test('PT3 nothing is guessed: a missing source, an ambiguous or unknown recipient and a missing amount prepare nothing', async () => {
  seedApp();
  const run = async (userId: string, extra: object) =>
    (await runTool('prepare_transfer', rent(extra), ctx(userId))) as Any;
  assert.equal((await run('lucia', { recipient: 'Hugo' })).status, 'needs_source_account');
  twins = true;
  const ambiguous = await run(USER, { recipient: 'Ana' }).finally(() => (twins = false));
  assert.equal(ambiguous.code, 'ambiguous_recipient');
  assert.deepEqual(ambiguous.recipients, ['Ana Ruiz', 'Ana Soto']);
  assert.equal((await run(USER, { recipient: 'Nobody' })).code, 'invalid_destination');
  assert.equal((await run(USER, { amountCents: null })).code, 'invalid_request');
  assert.equal((await run(USER, { when: 'on_date' })).code, 'invalid_date');
  assert.equal(count('prepared_transfers') + intents() + count('approvals'), 0);
});

test('REQ-PT-15 send_prepared_transfer only proposes, once: the transfer_money proposal, confirmed through the usual card, money moves once', async () => {
  const conversationId = await opened();
  await prepareTransfer(ctx(USER), rent());
  const [{ id }] = preparedList(USER);

  // Another customer's id is "not found" and creates nothing.
  bankCalls.length = 0;
  const foreign = (await runTool(
    'send_prepared_transfer',
    { preparedId: id },
    ctx('bruno'),
  )) as Any;
  assert.deepEqual(foreign, { status: 'failed', error: 'Prepared transfer not found.' });
  assert.equal(intents() + count('approvals') + sent(), 0);

  // The model lists, then sends twice in the same turn: one proposal.
  const t = await turn(conversationId, 'I have the keys, send it', [
    list,
    send,
    send,
    () => say('Review the proposal.'),
  ]);
  const [, first, second] = t.outputs;
  assert.equal(first.status, 'requires_confirmation');
  assert.equal(second.approval.id, first.approval.id);
  assert.deepEqual([intents(), count('approvals'), sent()], [1, 1, 0]);
  assert.equal(events('transfer.proposed'), 1);
  // The turn's two reads plus the two of each proposeTransfer.
  assert.deepEqual(t.reads, [A, A, A, C, C, C]);
  // The same result shape as a transfer_money proposal, no extras, and the chat's confirmation
  // card reads the same list (dashboard.approvals).
  const plain = (await runTool(
    'transfer_money',
    {
      fromAccountId: null,
      recipient: 'Lucia',
      toAccountId: null,
      amountCents: 100,
      concept: 'other',
      secondTransfer: null,
      replacesApprovalId: null,
    },
    ctx(USER, 'pt3-plain'),
  )) as Any;
  assert.deepEqual(Object.keys(first).sort(), Object.keys(plain).sort());
  assert.deepEqual(Object.keys(first.approval).sort(), Object.keys(plain.approval).sort());
  assert.equal(t.message.extras, null);
  const { approvals } = (await callApi(USER, 'dashboard')).body;
  assert.ok(approvals.some((a: Any) => a.id === first.approval.id));
  // The note is not in the instructions after a send either.
  assert.ok(!t.instructions.includes('ZZNOTE'));

  // A second turn sends again: still the same proposal.
  const again = await turn(conversationId, 'Send it', [list, send, () => say('Review it.')]);
  assert.equal(again.outputs[1].approval.id, first.approval.id);
  assert.deepEqual(
    [count("intents WHERE id LIKE 'prepared:%'"), count('approvals'), sent()],
    [1, 2, 0],
  );

  // The customer confirms in the usual card: money moves once, and never again.
  bankCalls.length = 0;
  const confirmed = await callApi(USER, `approvals/${first.approval.id}/confirm`, {});
  assert.equal(confirmed.body.status, 'completed', JSON.stringify(confirmed.body));
  await callApi(USER, `approvals/${first.approval.id}/confirm`, {});
  assert.deepEqual(preparedList(USER), []);
  const after = (await runTool('send_prepared_transfer', { preparedId: id }, ctx(USER))) as Any;
  assert.equal(after.code, 'not_active');
  assert.equal(sent(), 1);
});

test('REQ-PT-16 a turn with any of the three tools carries no product suggestion', async () => {
  const cases: Record<string, ((b: ModelBody) => object)[]> = {
    prepare_transfer: [prepare, suggest],
    list_prepared_transfers: [list, suggest],
    send_prepared_transfer: [list, send, suggest],
  };
  for (const [name, calls] of Object.entries(cases)) {
    const conversationId = await opened();
    await prepareTransfer(ctx(USER), rent());
    const t = await turn(conversationId, 'Which accounts do I have?', calls);
    assert.match(t.instructions, /PRODUCT SUGGESTION/, `${name}: the offer was chosen`);
    assert.equal(t.message.content, 'Done.', name);
    assert.equal(t.message.extras, null, name);
    assert.equal(events('offer.shown'), 0, name);
  }
});

// Review fix (src/operator/view.ts describeEvent): contract "status should match verified facts".
test('PT3 the operator reads a refused send as refused, never as "completed"', async () => {
  const conversationId = await opened();
  appDb()
    .prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)')
    .run('case-pt3', USER, conversationId, 'Rent', 'open', new Date().toISOString());
  // Above the balance: accepted when preparing (D8), refused when sending.
  await prepareTransfer(ctx(USER), rent({ amountCents: 500_000 }));
  const t = await turn(conversationId, 'Send it', [list, send, () => say('Not enough funds.')]);
  assert.equal(t.outputs[1].code, 'insufficient_funds');
  const { caseDetail } = await import('../src/operator/view');
  const steps = ((await caseDetail('marta', 'case-pt3')) as Any).runs
    .flatMap((r: Any) => r.events)
    .map((e: Any) => e.description as string)
    .filter((s: string) => s.startsWith('Prepared transfer proposal') && !s.endsWith('started'));
  assert.equal(steps.length, 1);
  assert.match(steps[0], /^Prepared transfer proposal refused by the app: Insufficient funds/);
});

// PT4 review fixes (src/operator/view.ts), on the demo bank, where the operator's bank reads do
// not name another customer's account.
const caseSteps = async (id: string, conversationId: string) => {
  appDb()
    .prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)')
    .run(id, USER, conversationId, 'Rent', 'open', new Date().toISOString());
  const { caseDetail } = await import('../src/operator/view');
  const detail = (await caseDetail('marta', id)) as Any;
  const steps: string[] = detail.runs.flatMap((r: Any) => r.events).map((e: Any) => e.description);
  return { detail, steps };
};
test('PT4 the operator reads a saved prepare as prepared and not sent, never "completed"', async () => {
  const conversationId = await opened();
  await turn(conversationId, 'Prepare the rent', [prepare, () => say('Prepared, not sent.')]);
  const { steps } = await caseSteps('case-pt4a', conversationId);
  assert.ok(steps.includes('Transfer prepared for later: not sent'), steps.join(' | '));
  assert.ok(!steps.some((s) => /^Prepared transfer.* completed$/.test(s)), steps.join(' | '));
});
test('PT4 the operator reads the destination of a proposal by its recorded name, not the account id', async () => {
  const conversationId = await opened();
  await prepareTransfer(ctx(USER), rent({ amountCents: 2000 }));
  await turn(conversationId, 'Send it', [list, send, () => say('Review it.')]);
  const { detail, steps } = await caseSteps('case-pt4b', conversationId);
  const proposed = steps.find((s) => s.startsWith('Transfer proposed'));
  assert.equal(
    proposed,
    "Transfer proposed: €20.00 to Lucía Martín · Aurora account, awaiting the customer's confirmation",
  );
  // The summary reads the same recorded name.
  assert.ok(
    detail.summary.text.some((l: string) => l.includes('€20.00 to Lucía Martín · Aurora account')),
    detail.summary.text.join(' | '),
  );
});
