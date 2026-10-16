// F5a–F5d: operator view. Deterministic, no OpenAI calls: tools, telemetry, caseDetail and the
// route handler are called directly against a simulator spawned on a free port.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-operator-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { recordEvent } = await import('../src/telemetry');
const { runTool } = await import('../src/agent/tools');
let bank: ChildProcess;
before(async () => {
  seedBank();
  seedApp();
  bank = await startSimulator();
});
const lastEvent = (runId: string, kind: string) => {
  const row = appDb()
    .prepare('SELECT data FROM events WHERE run_id=? AND kind=? ORDER BY rowid DESC LIMIT 1')
    .get(runId, kind) as { data: string };
  return { raw: row.data, data: JSON.parse(row.data) };
};
test('F5a: recordEvent keeps arguments, output and error, redacting secrets and bounding size', () => {
  const ctx = { userId: 'lucia', conversationId: null, runId: 'run-f5a', intentId: 'i-f5a' };
  recordEvent(ctx, 'tool.failed', {
    tool: 'operation_status',
    status: 'failed',
    arguments: { reference: 'ref-123', apiKey: 'abc', nested: { authorization: 'x' } },
    output: {
      note: 'Bearer abcdefghijkl',
      key: 'sk-proj-abcdefghijklmnop',
      long: 'x'.repeat(5000),
    },
    error: 'Operation not found.',
    items: Array.from({ length: 200 }, (_, i) => ({ i, text: 'y'.repeat(400) })),
  });
  const { raw, data } = lastEvent('run-f5a', 'tool.failed');
  assert.equal(data.tool, 'operation_status');
  assert.equal(data.arguments.reference, 'ref-123');
  assert.equal(data.error, 'Operation not found.');
  assert.equal(data.arguments.apiKey, '[redacted]');
  assert.equal(data.arguments.nested.authorization, '[redacted]');
  assert.equal(data.output.note, '[redacted]');
  assert.equal(data.output.key, '[redacted]');
  assert.ok(data.output.long.length < 600, 'long strings are truncated');
  assert.ok(raw.length <= 8000, 'stored event data is bounded');
});
test('F5a: runTool records arguments, outputs and errors of real tools', async () => {
  const ctx = {
    userId: 'bruno',
    conversationId: 'conv-bruno-activity-3',
    runId: 'run-f5a-tools',
    intentId: 'i-f5a-tools',
  };
  const opened = (await runTool('request_human', { summary: 'Check the dinner payment' }, ctx)) as {
    incidentId: string;
  };
  const completed = lastEvent('run-f5a-tools', 'tool.completed').data;
  assert.equal(completed.arguments.summary, 'Check the dinner payment');
  assert.equal(completed.output.incidentId, opened.incidentId);
  // T7: an unknown reference is now `not_found` (not a failure); an empty one still fails.
  await runTool('operation_status', { reference: '' }, ctx);
  const failed = lastEvent('run-f5a-tools', 'tool.failed').data;
  assert.equal(failed.arguments.reference, '');
  assert.ok(failed.error, 'the error is recorded');
});
const { caseDetail } = await import('../src/operator/view');
test("F5b: seeded case-lucia shows history, intent and the bank's verified status", async () => {
  const d = (await caseDetail('marta', 'case-lucia')) as any;
  assert.deepEqual(
    d.history.map((m: any) => m.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal(d.history[0].content, 'Transfer EUR 85 to Bruno for the team dinner.');
  assert.equal(d.intents.length, 1);
  const intent = d.intents[0];
  assert.equal(intent.id, 'intent-historic-lucia');
  assert.equal(intent.status, 'failed', 'the app record is shown as recorded');
  assert.equal(intent.bankReference, 'ref-historic-lucia');
  assert.equal(intent.payload.amountCents, 8500);
  assert.equal(intent.verified.status, 'completed', 'the bank confirms the operation');
  assert.equal(intent.verified.operation.id, 'op-historic-lucia');
  assert.ok(d.bank.operations.length > 0);
  // Nothing was recorded for this seeded history: no invented steps, and the gap is stated.
  assert.deepEqual(d.runs, []);
  assert.deepEqual(d.events, []);
  assert.ok(d.gaps.some((g: string) => /not recorded|no .*recorded/i.test(g)));
});
test('F5b: a new case lists its runs and tool steps in order', async () => {
  const db = appDb(),
    now = new Date().toISOString();
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('conv-f5b', 'hugo', 'Help', now);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(
    'm-f5b-1',
    'conv-f5b',
    'user',
    'I need a person, please.',
    now,
    'run-f5b',
  );
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)').run(
    'run-f5b',
    'hugo',
    'conv-f5b',
    now,
    'completed',
    null,
  );
  const ctx = { userId: 'hugo', conversationId: 'conv-f5b', runId: 'run-f5b', intentId: 'x' };
  await runTool('list_accounts', {}, ctx);
  const { incidentId } = (await runTool(
    'request_human',
    { summary: 'Customer asks for a human about card limits.' },
    ctx,
  )) as { incidentId: string };
  const d = (await caseDetail('pablo', incidentId)) as any;
  assert.equal(d.history.length, 1);
  assert.equal(d.runs.length, 1);
  assert.equal(d.runs[0].id, 'run-f5b');
  assert.equal(d.runs[0].recorded, true);
  assert.deepEqual(
    d.runs[0].events.map((e: any) => `${e.kind}:${e.data.tool}`),
    [
      'tool.started:list_accounts',
      'tool.completed:list_accounts',
      'tool.started:request_human',
      'tool.completed:request_human',
    ],
  );
  assert.equal(d.events.length, 4);
});
test('F5b: customers cannot open case detail', async () => {
  await assert.rejects(caseDetail('lucia', 'case-lucia'), { status: 403 });
});
test('F5c: summary of a seeded case states facts and does not invent a handoff', async () => {
  const d = (await caseDetail('marta', 'case-lucia')) as any;
  assert.equal(d.summary.handoffSource, 'not_recorded');
  assert.equal(d.summary.handoff, null);
  const text = d.summary.text.join('\n');
  assert.match(text, /Lucía Martín/);
  assert.match(text, /Transfer EUR 85 to Bruno for the team dinner\./);
  assert.match(text, /app shows failed, bank confirms completed/i);
  assert.match(text, /no assistant handoff summary was recorded/i);
});
test('F5c: summary of a new case carries the assistant handoff summary', async () => {
  const ctx = { userId: 'omar', conversationId: 'conv-f5c', runId: 'run-f5c', intentId: 'x' };
  appDb()
    .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
    .run('conv-f5c', 'omar', 'Help', new Date().toISOString());
  const { incidentId } = (await runTool(
    'request_human',
    { summary: 'Omar wants to dispute a card charge of EUR 40.' },
    ctx,
  )) as { incidentId: string };
  const d = (await caseDetail('marta', incidentId)) as any;
  assert.equal(d.summary.handoffSource, 'assistant');
  assert.equal(d.summary.handoff, 'Omar wants to dispute a card charge of EUR 40.');
  assert.match(d.summary.text.join('\n'), /Omar wants to dispute a card charge of EUR 40\./);
  assert.match(d.summary.text.join('\n'), /No transfer intents were recorded/);
});
test('O1: transfer attempts rejected before the bank appear in detail and summary', async () => {
  appDb()
    .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
    .run('conv-o1', 'diego', 'Rent', new Date().toISOString());
  const ctx = (n: number) => ({
    userId: 'diego',
    conversationId: 'conv-o1',
    runId: 'run-o1',
    intentId: `run-o1:call-${n}`,
  });
  const args = { fromAccountId: 'acc-diego', toAccountId: 'acc-bruno', concept: 'Rent' };
  // Insufficient funds: pre-check refusal, recorded only as tool.completed with status failed.
  const refused = (await runTool('transfer_money', { ...args, amountCents: 20000 }, ctx(1))) as any;
  assert.equal(refused.status, 'failed');
  // Invalid amount: the tool throws, recorded only as tool.failed.
  await runTool('transfer_money', { ...args, amountCents: -5 }, ctx(2));
  const { incidentId } = (await runTool(
    'request_human',
    { summary: 'Diego asks why the rent transfer failed.' },
    ctx(3),
  )) as { incidentId: string };
  const d = (await caseDetail('marta', incidentId)) as any;
  assert.equal(d.intents.length, 0, 'no intent row was created');
  assert.equal(d.rejectedAttempts.length, 2);
  assert.equal(d.rejectedAttempts[0].arguments.amountCents, 20000);
  assert.equal(d.rejectedAttempts[0].code, 'insufficient_funds');
  assert.ok(d.rejectedAttempts[1].error);
  const text = d.summary.text.join('\n');
  assert.equal(text.match(/rejected before reaching the bank/g)?.length, 2);
  assert.match(text, /€200\.00 to Bruno Vidal/); // S3: shared money format
  assert.doesNotMatch(text, /No transfer intents were recorded/);
});
test('O3: summary and detail use account names and formatted dates', async () => {
  const d = (await caseDetail('marta', 'case-lucia')) as any;
  assert.equal(d.accountNames['acc-bruno'], 'Bruno Vidal · Horizon account');
  assert.match(d.accountNames['acc-lucia'], /^Lucía Martín · /);
  const text = d.summary.text.join('\n');
  assert.match(text, /to Bruno Vidal · Horizon account/);
  assert.doesNotMatch(text, /acc-bruno/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, 'no raw ISO timestamps');
  // S4: no time in server text (the UI formats incident.created_at in local time).
  assert.doesNotMatch(text, /UTC|\d{2}:\d{2}/);
});
test('O4: an operation missing from the operator listing is not verified, never "no such operation"', async () => {
  const db = appDb(),
    now = new Date().toISOString();
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('conv-o4', 'elena', 'Pay', now);
  db.prepare('INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    'intent-o4',
    'elena',
    'conv-o4',
    'run-o4',
    JSON.stringify({
      fromAccountId: 'acc-elena',
      toAccountId: 'acc-hugo',
      amountCents: 1500,
      concept: 'Lunch',
    }),
    'completed',
    'ref-o4-not-in-listing',
    'op-o4',
    null,
    now,
  );
  db.prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)').run(
    'case-o4',
    'elena',
    'conv-o4',
    'Check my lunch payment',
    'open',
    now,
  );
  const d = (await caseDetail('marta', 'case-o4')) as any;
  assert.equal(d.intents[0].verified.status, 'unverified');
  assert.match(d.intents[0].verified.reason, /not verified/i);
  const text = d.summary.text.join('\n');
  assert.doesNotMatch(text, /no such operation|no bank operation/i);
  assert.match(text, /app shows completed, bank status not verified/);
});
const route = await import('../app/api/[...path]/route');
const { sessionToken } = await import('../src/auth');
// S6: POSTs carry the explicit confirmation that resolving requires.
const call = (as: string, method: 'GET' | 'POST', ...path: string[]) =>
  route[method](
    new Request(`http://127.0.0.1/api/${path.join('/')}`, {
      method,
      headers: { cookie: `banana_actor=${sessionToken(as)}` },
      body: method === 'POST' ? JSON.stringify({ confirm: true }) : undefined,
    }),
    { params: Promise.resolve({ path }) },
  );
const resolvedEvents = () =>
  appDb()
    .prepare("SELECT * FROM events WHERE kind='case.resolved' AND conversation_id=?")
    .all('conv-diego-support') as { user_id: string; data: string }[];
test('F5d: an operator resolves a case through the API and it is audited', async () => {
  const res = await call('marta', 'POST', 'incidents', 'case-diego', 'resolve');
  assert.equal(res.status, 200);
  const resolved = await res.json();
  assert.equal(resolved.incident.status, 'closed');
  // The operator's action is not an assistant step: the seeded gap is still stated.
  assert.ok(resolved.gaps.some((g: string) => /No assistant runs/.test(g)));
  const events = resolvedEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].user_id, 'marta');
  assert.equal(JSON.parse(events[0].data).operatorId, 'marta');
  const again = await call('marta', 'POST', 'incidents', 'case-diego', 'resolve');
  assert.equal(again.status, 200);
  assert.equal(resolvedEvents().length, 1, 'resolving twice is audited once');
  const inbox = await (await call('marta', 'GET', 'dashboard')).json();
  assert.equal(inbox.incidents.find((c: any) => c.id === 'case-diego').status, 'closed');
});
test('F5d: a customer cannot resolve a case', async () => {
  const res = await call('diego', 'POST', 'incidents', 'case-elena', 'resolve');
  assert.equal(res.status, 403);
  const row = appDb().prepare('SELECT status FROM incidents WHERE id=?').get('case-elena') as {
    status: string;
  };
  assert.equal(row.status, 'open');
});
test('OP2: cases with money at stake come first, then open cases oldest first, closed last', async () => {
  const db = appDb(),
    now = new Date().toISOString();
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('conv-op2-old', 'hugo', 'Q', now);
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('conv-op2-money', 'ines', 'T', now);
  db.prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)').run(
    'case-op2-old',
    'hugo',
    'conv-op2-old',
    'A question about fees',
    'open',
    '2020-01-01T00:00:00.000Z',
  );
  db.prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)').run(
    'case-op2-money',
    'ines',
    'conv-op2-money',
    'Where is my transfer?',
    'open',
    now,
  );
  db.prepare('INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    'intent-op2',
    'ines',
    'conv-op2-money',
    'run-op2',
    JSON.stringify({ fromAccountId: 'acc-ines', toAccountId: 'acc-hugo', amountCents: 900 }),
    'pending_verification',
    'ref-op2',
    null,
    null,
    now,
  );
  for (const res of [
    await call('marta', 'GET', 'incidents'),
    await call('marta', 'GET', 'dashboard'),
  ]) {
    const body = await res.json();
    const list = (Array.isArray(body) ? body : body.incidents) as any[];
    const at = (id: string) => list.findIndex((c) => c.id === id);
    const money = list[at('case-op2-money')];
    assert.equal(money.priority, 'money');
    assert.match(money.priorityReason, /Transfer pending verification \(1\)/);
    assert.equal(list[at('case-op2-old')].priority, 'open');
    assert.equal(list[at('case-op2-old')].priorityReason, 'Waiting for support');
    assert.ok(at('case-op2-money') < at('case-op2-old'), 'money at stake first');
    // Seeded case-lucia: an intent sent to the bank but recorded as failed is money at stake.
    assert.equal(list[at('case-lucia')].priority, 'money');
    assert.match(list[at('case-lucia')].priorityReason, /not verified/);
    const ranks = list.map((c) => ['money', 'open', 'closed'].indexOf(c.priority));
    assert.deepEqual(ranks, [...ranks].sort(), 'money, then open, then closed');
    const open = list.filter((c) => c.priority === 'open').map((c) => c.created_at);
    assert.deepEqual(open, [...open].sort(), 'open cases oldest first');
  }
});
test('OP3: resolving a case leaves one dated note in the customer conversation', async () => {
  await call('marta', 'POST', 'incidents', 'case-op2-old', 'resolve');
  await call('marta', 'POST', 'incidents', 'case-op2-old', 'resolve');
  const res = await call('hugo', 'GET', 'conversations', 'conv-op2-old');
  assert.equal(res.status, 200);
  const notes = (await res.json()).messages.filter((m: any) => /support agent/i.test(m.content));
  assert.equal(notes.length, 1, 'resolving twice adds one note');
  assert.equal(notes[0].role, 'assistant');
  // S4: the time is the message's created_at, shown by the UI in local time.
  assert.equal(notes[0].content, 'A support agent marked your request as resolved.');
  const event = appDb()
    .prepare("SELECT run_id FROM events WHERE kind='case.resolved' AND conversation_id=?")
    .get('conv-op2-old') as { run_id: string };
  assert.equal(notes[0].run_id, event.run_id, 'the note is linked to the audited event');
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
