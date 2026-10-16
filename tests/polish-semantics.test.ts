// S1–S6 (round 4, block 2): strict transfer inputs, readable transfer and case texts, confirmed
// resolve. Deterministic, no OpenAI calls: the route handler runs against a spawned simulator.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
const { temp } = await setupEnv('banana-polish-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
let bank: ChildProcess;
before(async () => {
  seedBank();
  seedApp();
  bank = await startSimulator();
});
const propose = (userId: string, args: Record<string, unknown>, conversationId?: string) =>
  callApi(userId, 'actions', { name: 'transfer_money', arguments: args, conversationId });
const lucia = { fromAccountId: 'acc-lucia', toAccountId: 'acc-bruno', concept: 'Dinner' };
const intents = () => (appDb().prepare('SELECT COUNT(*) n FROM intents').get() as { n: number }).n;

test('S1: amounts in exponent, hex, signed, non-finite or over-precise form are refused', async () => {
  const before = intents();
  for (const amount of [
    '1e3',
    '1E3',
    '0x10',
    '-5',
    '+5',
    'Infinity',
    'NaN',
    '1.234',
    '',
    ' ',
    '0',
    '0.00',
    '100000.01',
    '1,2,3',
  ] as const) {
    const { status, body } = await propose('lucia', { ...lucia, amount });
    assert.equal(status, 200, amount);
    assert.equal(body.status, 'failed', `"${amount}" must be refused`);
    assert.equal(body.code, 'invalid_request', amount);
    assert.match(body.error, /No money moved/, amount);
    assert.doesNotMatch(body.error, /amountCents|cents/, 'plain words, no field names');
  }
  for (const amountCents of [1.5, 0, -1, 10000001, '100', '1e3', null])
    assert.equal((await propose('lucia', { ...lucia, amountCents })).body.code, 'invalid_request');
  const both = (await propose('lucia', { ...lucia, amountCents: 500, amount: '50.00' })).body;
  assert.equal(both.code, 'invalid_request');
  assert.match(both.error, /given twice/);
  assert.equal(intents(), before, 'nothing was proposed');
});

test('S1: decimal text in euros is converted exactly (dot or comma, up to 2 decimals)', async () => {
  for (const [amount, cents] of [
    ['12.5', 1250],
    ['0,07', 7],
    ['19.99', 1999],
  ] as const) {
    const { body } = await propose('lucia', { ...lucia, amount, concept: `S1 ${amount}` });
    assert.equal(body.status, 'requires_confirmation', amount);
    assert.equal(body.approval.amountCents, cents, amount);
  }
  // The maximum is a valid amount (refused here only because Lucía cannot pay it).
  assert.equal(
    (await propose('lucia', { ...lucia, amount: '100000.00' })).body.code,
    'insufficient_funds',
  );
  // The chat tool keeps sending integer cents.
  const { body } = await propose('lucia', { ...lucia, amountCents: 321, concept: 'S1 cents' });
  assert.equal(body.approval.amountCents, 321);
});

test('S1: the concept is trimmed and must not be empty', async () => {
  const before = intents();
  for (const concept of ['', '   ', '\n\t'] as const) {
    const { body } = await propose('lucia', { ...lucia, amount: '2', concept });
    assert.equal(body.status, 'failed');
    assert.equal(body.code, 'invalid_request');
    assert.match(body.error, /description/i);
  }
  assert.equal(intents(), before);
  const { body } = await propose('lucia', { ...lucia, amount: '2.10', concept: '  Pizza  ' });
  assert.equal(body.approval.concept, 'Pizza');
});

test('S2: insufficient funds uses the money format, no document ids, and says the app refused it', async () => {
  const { body } = await propose('diego', {
    fromAccountId: 'acc-diego',
    toAccountId: 'acc-bruno',
    amountCents: 200000,
    concept: 'Rent',
  });
  assert.equal(body.code, 'insufficient_funds');
  assert.match(body.error, /€2,000\.00/);
  assert.match(body.error, /€75\.00 available/);
  assert.doesNotMatch(body.error, /faq-|\(faq/);
  assert.doesNotMatch(body.error, /bank rejects/i);
  assert.match(body.error, /not sent|did not send/i);
  assert.equal(body.sources[0].documentId, 'faq-insufficient-funds', 'source stays as data');
});

// A case with a rejected transfer to a person named by the customer (no account id).
async function diegoCase() {
  const conv = `conv-s3-${Date.now()}`;
  appDb()
    .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
    .run(conv, 'diego', 'Rent', new Date().toISOString());
  const refused = await propose(
    'diego',
    {
      fromAccountId: 'acc-diego',
      recipient: 'Lucía',
      toAccountId: null,
      amountCents: 50000,
      concept: 'Rent',
    },
    conv,
  );
  assert.equal(refused.body.code, 'insufficient_funds');
  const { body } = await callApi('diego', 'actions', {
    name: 'request_human',
    arguments: { summary: 'Diego asks why the **rent** transfer was refused.' },
    conversationId: conv,
  });
  appDb()
    .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)')
    .run(
      `${conv}-m`,
      conv,
      'assistant',
      'I have **opened** a case:\n- a person will [reply](https://x.test)',
      new Date().toISOString(),
      null,
    );
  return body.incidentId as string;
}

test('S3: rejected attempts to a person name the recipient and format money', async () => {
  const id = await diegoCase();
  const { body: d } = await callApi('marta', `incidents/${id}`);
  const text = d.summary.text.join('\n');
  assert.doesNotMatch(text, /\bnull\b|undefined|no destination/);
  assert.match(text, /€500\.00 to Lucía Martín/);
  assert.doesNotMatch(text, /\d EUR\b/);
  const [attempt] = d.rejectedAttempts;
  assert.match(attempt.destination, /^Lucía Martín/);
  assert.match(attempt.source, /Diego Salas/);
});

test('S4: server texts carry no time zone; the resolution note has no time', async () => {
  const list = (await callApi('marta', 'incidents')).body as any[];
  for (const c of list) assert.doesNotMatch(c.priorityReason, /UTC|\d{2}:\d{2}/);
  const { body: d } = await callApi('marta', 'incidents/case-carla');
  assert.doesNotMatch(d.summary.text.join('\n'), /UTC/);
  await callApi('marta', 'incidents/case-carla/resolve', { confirm: true });
  const note = appDb()
    .prepare(
      "SELECT content FROM messages WHERE conversation_id=? AND content LIKE 'A support agent%'",
    )
    .get(d.incident.conversation_id) as { content: string };
  assert.equal(note.content, 'A support agent marked your request as resolved.');
});

test('S5: one status vocabulary, plain latest message, readable steps', async () => {
  const id = await diegoCase();
  const list = (await callApi('marta', 'incidents')).body as any[];
  const labels = new Set(list.map((c) => `${c.status}:${c.statusLabel}`));
  assert.deepEqual([...labels].sort(), ['closed:Resolved', 'open:Open']);
  const { body: d } = await callApi('marta', `incidents/${id}`);
  assert.equal(d.incident.statusLabel, 'Open');
  assert.match(d.summary.text[0], / · Open$/);
  assert.equal(d.lastMessage.text, 'I have opened a case:\na person will reply');
  for (const e of d.events) {
    assert.equal(typeof e.description, 'string', e.kind);
    assert.doesNotMatch(e.description, /[{}\n]|\bnull\b|undefined/, e.description);
    assert.ok(e.data, 'raw data kept');
  }
  const refused = d.events.find(
    (e: any) => e.kind === 'tool.completed' && e.data.tool === 'transfer_money',
  );
  assert.match(refused.description, /€500\.00 to Lucía Martín/);
  assert.match(refused.description, /Insufficient funds/);
});

test('S6: resolving requires an explicit confirmation', async () => {
  const count = () =>
    (
      appDb().prepare("SELECT COUNT(*) n FROM events WHERE kind='case.resolved'").get() as {
        n: number;
      }
    ).n;
  const before = count();
  for (const body of [{}, { confirm: 'yes' }, { confirm: false }]) {
    const res = await callApi('marta', 'incidents/case-elena/resolve', body);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /confirm/i);
  }
  assert.equal(
    (appDb().prepare('SELECT status FROM incidents WHERE id=?').get('case-elena') as any).status,
    'open',
  );
  const ok = await callApi('marta', 'incidents/case-elena/resolve', { confirm: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.incident.status, 'closed');
  assert.equal(
    (await callApi('marta', 'incidents/case-elena/resolve', { confirm: true })).status,
    200,
  );
  assert.equal(count(), before + 1, 'audited once');
});

after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
