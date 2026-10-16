// Portability: the app against an independent bank (tests/alt-bank/server.ts) that implements
// docs/contracts.md with different wording, error codes, ordering, page sizes, latency and
// failure modes than the simulator. No OpenAI calls. See docs/testing-alt-bank.md.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
process.env.BANK_TIMEOUT_MS = '800';
const { temp } = await setupEnv('banana-alt-bank-');
const { appDb, closeAppDb } = await import('../src/db');
const { bankRequest, BankError } = await import('../src/banking/client');
const { transferMoney } = await import('../src/banking/actions');
const { runTool } = await import('../src/agent/tools');
const BANK = process.env.BANK_URL!;
let bank: ChildProcess;
before(async () => {
  bank = await startSimulator('alt');
});
after(() => {
  bank?.kill();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const control = async (route: string, body?: unknown) =>
  (await (
    await fetch(`${BANK}/_control/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-alt-control': 'alt-control' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  ).json()) as { accounts: any[]; operations: any[] };
beforeEach(() => control('reset', {}));
const configure = (options: Record<string, unknown>) => control('config', options);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opsOf = async (userId = 'lucia') =>
  (await control('state')).operations.filter(
    (o) => o.userId === userId && !o.reference.startsWith('ref-historic'),
  );
const balance = async (id: string) =>
  (await control('state')).accounts.find((a) => a.id === id).balanceCents as number;
const noMoneyMoved = /no money moved|was not sent|no record/i;

let n = 0;
async function propose(
  args: Record<string, unknown> = {},
  user = 'lucia',
  conversationId?: string,
) {
  const { body } = await callApi(user, 'actions', {
    name: 'transfer_money',
    arguments: {
      fromAccountId: `acc-${user}`,
      toAccountId: 'acc-bruno',
      amountCents: 1000,
      concept: `Alt ${++n}`,
      ...args,
    },
    intentId: `alt-${n}-${Date.now()}`,
    conversationId,
  });
  return body;
}
const confirm = async (approvalId: string, user = 'lucia') =>
  (await callApi(user, `approvals/${approvalId}/confirm`, {})).body;
async function proposeAndConfirm(args: Record<string, unknown> = {}, conversationId?: string) {
  const p = await propose(args, 'lucia', conversationId);
  assert.equal(p.status, 'requires_confirmation', JSON.stringify(p));
  return confirm(p.approval.id);
}

test('alt bank enforces the signature and clock window', async () => {
  assert.equal((await fetch(`${BANK}/v1/accounts`)).status, 401);
  const r = await fetch(`${BANK}/v1/accounts`, {
    headers: {
      'x-bank-actor': 'lucia',
      'x-bank-time': String(Date.now() - 61_000),
      'x-bank-signature': 'x',
    },
  });
  assert.equal(r.status, 401);
});

test('dashboard reads accounts, contacts and a smaller movements page', async () => {
  const { status, body } = await callApi('lucia', 'dashboard');
  assert.equal(status, 200);
  assert.deepEqual(body.accounts.map((a: any) => a.id).sort(), ['acc-lucia', 'acc-lucia-savings']);
  assert.equal(body.movements.length, 25);
  assert.ok(body.contacts.some((c: any) => c.id === 'acc-bruno' && c.name === 'Bruno Vidal'));
});

// ALT-1 / R4: the contract says "up to 100 recent movements" but not their order; the dashboard
// sorts them newest first so "Latest transactions" are the latest.
test('dashboard shows the newest movements first whatever order the bank uses', async () => {
  await configure({ movementsOrder: 'oldest' });
  const { body } = await callApi('lucia', 'dashboard');
  const times = body.movements.map((m: any) => m.createdAt);
  assert.deepEqual(times, [...times].sort().reverse());
});

// R2: a recipient person resolves to their main (non-savings) account with this bank's contacts.
test('a recipient by name resolves to their main account', async () => {
  for (const [user, name, id] of [
    ['bruno', 'Lucía Martín', 'acc-lucia'],
    ['lucia', 'carla', 'acc-carla'],
  ]) {
    const { body } = await callApi(user, 'actions', {
      name: 'transfer_money',
      arguments: { fromAccountId: `acc-${user}`, recipient: name, amountCents: 100, concept: 'R2' },
      intentId: `alt-r2-${user}`,
    });
    assert.equal(body.status, 'requires_confirmation', JSON.stringify(body));
    assert.equal(body.approval.toAccountId, id);
    assert.equal(body.destination.main, true);
  }
});

test('propose then confirm moves money exactly once', async () => {
  const before = await balance('acc-lucia');
  const r = await proposeAndConfirm();
  assert.equal(r.status, 'completed');
  assert.equal(r.operation.replay, false);
  assert.equal((await opsOf()).length, 1);
  assert.equal(await balance('acc-lucia'), before - 1000);
});

test('double confirm (concurrent and repeated) executes once', async () => {
  const p = await propose();
  const both = await Promise.all([confirm(p.approval.id), confirm(p.approval.id)]);
  for (const r of both)
    assert.ok(['completed', 'processing'].includes(r.status), JSON.stringify(r));
  const again = await confirm(p.approval.id);
  assert.equal(again.status, 'completed');
  assert.equal(again.verified, true);
  assert.equal((await opsOf()).length, 1);
});

test('three different transfers confirmed together under a slow, serialised bank', async () => {
  await configure({ commitDelayMs: 600 });
  const proposals = [await propose(), await propose(), await propose()];
  const results = await Promise.all(proposals.map((p) => confirm(p.approval.id)));
  for (const r of results)
    assert.ok(['completed', 'pending_verification'].includes(r.status), JSON.stringify(r));
  await sleep(1500);
  for (const p of proposals) assert.equal((await confirm(p.approval.id)).status, 'completed');
  assert.equal((await opsOf()).length, 3);
});

test('503 before effects: the retry completes once', async () => {
  await configure({ faults: ['reject-before'] });
  const r = await proposeAndConfirm();
  assert.equal(r.status, 'completed');
  assert.equal((await opsOf()).length, 1);
});

test('connection dropped after commit: the retry is a replay, one operation', async () => {
  await configure({ faults: ['drop'] });
  const r = await proposeAndConfirm();
  assert.equal(r.status, 'completed');
  assert.equal(r.operation.replay, true);
  assert.equal((await opsOf()).length, 1);
});

test('non-JSON 504 after commit on both attempts: verified completed by reference', async () => {
  await configure({ faults: ['gateway-504', 'gateway-504'] });
  const r = await proposeAndConfirm();
  assert.equal(r.status, 'completed');
  assert.equal(r.verified, true);
  assert.equal((await opsOf()).length, 1);
});

test('slow commit longer than one timeout: completed once', async () => {
  await configure({ commitDelayMs: 1200 });
  const r = await proposeAndConfirm();
  assert.equal(r.status, 'completed');
  assert.equal((await opsOf()).length, 1);
});

test('slow commit longer than both attempts: never "failed", completed once verified', async () => {
  await configure({ commitDelayMs: 2400 });
  const p = await propose();
  const r = await confirm(p.approval.id);
  assert.ok(['completed', 'pending_verification'].includes(r.status), JSON.stringify(r));
  assert.doesNotMatch(JSON.stringify(r), noMoneyMoved);
  await sleep(1500);
  const later = await confirm(p.approval.id);
  assert.equal(later.status, 'completed', JSON.stringify(later));
  assert.equal((await opsOf()).length, 1);
});

test('slow response after commit: completed once', async () => {
  await configure({ respondDelayMs: 1000 });
  const r = await proposeAndConfirm();
  assert.equal(r.status, 'completed');
  assert.equal((await opsOf()).length, 1);
});

test('read-after-write lag: never reports "no money moved" for a committed transfer', async () => {
  // The lag outlasts any run however slow the machine, and ends on a signal, not a clock: with a
  // 3.5 s lag and a fixed sleep, a loaded machine saw the operation turn visible mid-check.
  await configure({ faults: ['drop', 'drop'], readLagMs: 600_000 });
  const p = await propose();
  const r = await confirm(p.approval.id);
  assert.equal((await opsOf()).length, 1, 'the money moved');
  assert.equal(r.status, 'pending_verification', JSON.stringify(r));
  assert.doesNotMatch(String(r.message), noMoneyMoved);
  const status = (await runTool(
    'operation_status',
    { reference: r.reference },
    {
      userId: 'lucia',
      conversationId: null,
      runId: 'q',
      intentId: 'q',
    },
  )) as any;
  assert.equal(status.status, 'pending_verification');
  const recent = (
    await callApi('lucia', 'actions', { name: 'operation_status', arguments: { reference: null } })
  ).body;
  assert.ok(
    recent.transfers.every((t: any) => t.status !== 'failed'),
    JSON.stringify(recent),
  );
  await control('reveal', {});
  const later = await confirm(p.approval.id);
  assert.equal(later.status, 'completed');
  assert.equal(later.verified, true);
});

test('lookup unavailable (503) twice, then found: completed in the same confirm', async () => {
  await configure({ faults: ['drop', 'drop'], readFaults: 2 });
  const r = await proposeAndConfirm();
  assert.equal(r.status, 'completed', JSON.stringify(r));
  assert.equal((await opsOf()).length, 1);
});

test('409 on reference reuse with a different payload; replay:true on the same payload', async () => {
  const body = {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    amountCents: 700,
    concept: 'Direct',
    reference: 'alt-ref-1',
  };
  const first = await bankRequest<any>('lucia', '/v1/transfers', 'POST', body);
  assert.equal(first.replay, false);
  const again = await bankRequest<any>('lucia', '/v1/transfers', 'POST', body);
  assert.equal(again.replay, true);
  assert.equal(again.id, first.id);
  await assert.rejects(
    bankRequest('lucia', '/v1/transfers', 'POST', { ...body, amountCents: 701 }),
    (e: any) => e instanceof BankError && e.status === 409,
  );
  // Through the app: an intent whose reference the bank already holds for another payload.
  const input = {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    amountCents: 999,
    concept: 'Clash',
  };
  appDb()
    .prepare('INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      'alt-409',
      'lucia',
      null,
      'r',
      JSON.stringify(input),
      'created',
      'alt-ref-1',
      null,
      null,
      new Date().toISOString(),
    );
  const r = await transferMoney(
    { userId: 'lucia', conversationId: null, runId: 'r', intentId: 'alt-409' },
    input,
  );
  assert.equal(r.status, 'failed');
  assert.equal(r.code, 'conflict');
  assert.equal((await opsOf()).length, 1);
});

test('insufficient funds: refused at proposal and when the bank answers 422', async () => {
  const d = await propose({ amountCents: 9000 }, 'diego');
  assert.equal(d.status, 'failed');
  assert.equal(d.code, 'insufficient_funds');
  assert.equal(d.availableCents, 7500);
  const p = await propose({ amountCents: 5000 });
  await control('balance', { accountId: 'acc-lucia', balanceCents: 100 });
  const r = await confirm(p.approval.id);
  assert.equal(r.status, 'failed');
  assert.equal(r.code, 'insufficient_funds');
  assert.equal(r.availableCents, 100);
  assert.equal((await opsOf()).length, 0);
});

test("ownership: another customer's source account is refused (app and bank 403)", async () => {
  const r = await propose({ fromAccountId: 'acc-carla' });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /does not belong/);
  await assert.rejects(
    bankRequest('lucia', '/v1/transfers', 'POST', {
      fromAccountId: 'acc-carla',
      toAccountId: 'acc-bruno',
      amountCents: 1,
      concept: '',
      reference: 'own-1',
    }),
    (e: any) => e instanceof BankError && e.status === 403,
  );
  assert.equal(
    (await callApi('marta', 'actions', { name: 'list_accounts', arguments: {} })).status,
    403,
  );
});

test('unknown destination answered 404 by the bank is a plain "no money moved"', async () => {
  const input = {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-nobody',
    amountCents: 100,
    concept: 'x',
  };
  const r = await transferMoney(
    { userId: 'lucia', conversationId: null, runId: 'r', intentId: 'alt-404' },
    input,
  );
  assert.equal(r.status, 'failed');
  assert.match(String(r.error), /no money moved/i);
});

test('operator case detail: verified status, paginated listing, contacts refused, read lag', async () => {
  await configure({ operatorLimit: 2 });
  const conversationId = `alt-conv-${Date.now()}`;
  appDb()
    .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
    .run(conversationId, 'lucia', 'Alt', new Date().toISOString());
  for (let i = 0; i < 3; i++) {
    assert.equal((await proposeAndConfirm({}, conversationId)).status, 'completed');
    await sleep(5);
  }
  await configure({ faults: ['drop', 'drop'], readLagMs: 60_000 });
  const lagged = await proposeAndConfirm({}, conversationId);
  assert.equal(lagged.status, 'pending_verification');
  const human = (
    await callApi('lucia', 'actions', {
      name: 'request_human',
      arguments: { summary: 'Check my transfers' },
      conversationId,
    })
  ).body;
  const { status, body } = await callApi('marta', `incidents/${human.incidentId}`);
  assert.equal(status, 200);
  assert.equal(body.intents.length, 4);
  const verified = body.intents.map((i: any) => i.verified.status);
  // The two newest visible operations fit the page; the oldest one and the lagged one do not.
  assert.deepEqual(verified, ['unverified', 'completed', 'completed', 'unverified']);
  assert.equal(body.intents[3].status, 'pending_verification');
  assert.ok(
    !body.summary.text.some((l: string) => /failed|no money moved/i.test(l)),
    body.summary.text.join('\n'),
  );
  // OP1: operator contacts are refused by this bank; the customer's own labelled accounts (from
  // /v1/operator/customer) are named. FX6-e: and the recipient, by the name the proposals recorded.
  assert.deepEqual(Object.keys(body.accountNames).sort(), [
    'acc-bruno',
    'acc-lucia',
    'acc-lucia-savings',
  ]);
  assert.match(body.accountNames['acc-bruno'], /^Bruno Vidal · /);
});

// OP1 (ALT-3): /v1/contacts asked as an operator is not in the contract and this bank refuses it;
// the contract's own operator endpoint returns the customer's labelled accounts, used as fallback.
test("OP1: operator case detail names the customer's own accounts without operator contacts", async () => {
  const conversationId = `alt-conv3-${Date.now()}`;
  appDb()
    .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
    .run(conversationId, 'lucia', 'Alt', new Date().toISOString());
  await proposeAndConfirm({}, conversationId);
  const human = (
    await callApi('lucia', 'actions', {
      name: 'request_human',
      arguments: { summary: 'Names' },
      conversationId,
    })
  ).body;
  const { body } = await callApi('marta', `incidents/${human.incidentId}`);
  assert.match(body.accountNames['acc-lucia'] ?? '', /Aurora account/);
});

// FX6-a (ALT-3b): this bank gives an operator no contacts. A transfer the app refused before
// proposing it is named from what the customer's own session recorded with the refusal; an attempt
// that recorded no name keeps the id, said to be one.
test('FX6-a: a refused attempt names the other party from the recorded step, never from a guess', async () => {
  const conversationId = `alt-conv-fx6-${Date.now()}`;
  appDb()
    .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
    .run(conversationId, 'diego', 'Alt', new Date().toISOString());
  const big = { fromAccountId: 'acc-diego', amountCents: 9_000_000 };
  const byName = await propose(
    { ...big, toAccountId: null, recipient: 'Lucía' },
    'diego',
    conversationId,
  );
  assert.equal(byName.code, 'insufficient_funds');
  // Refused on its amount before any bank read: no name was resolved, so none is recorded.
  await propose({ ...big, toAccountId: 'acc-elena', amountCents: -5 }, 'diego', conversationId);
  const human = (
    await callApi('diego', 'actions', {
      name: 'request_human',
      arguments: { summary: 'Refused' },
      conversationId,
    })
  ).body;
  const { body } = await callApi('marta', `incidents/${human.incidentId}`);
  const [named, unnamed] = body.rejectedAttempts;
  assert.match(named.destination, /^Lucía Martín · /);
  assert.equal(unnamed.destination, 'account acc-elena');
  assert.match(body.summary.text.join('\n'), /€90,000\.00 to Lucía Martín · /);
  assert.doesNotMatch(body.summary.text.join('\n'), /as the customer named them/);
});
