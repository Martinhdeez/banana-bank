// PA1: a prepared transfer that leaves its account short this month is told in the same answer.
// After prepare_transfer and create_goal the result carries `afterThis`: the server's month
// forecast of the source account (the get_month_forecast figures), never the model's. The save
// never depends on it. Demo bank (tests/alt-bank) behind a local proxy that can refuse the
// movements read; a local fake of the OpenAI API whose turns are scripted. Dates are relative to
// the real day: the shortfall is made by setting the balance, so no check depends on the date.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
import { call, fakeOpenAI, say, type ModelBody } from './helpers/openai';

for (const level of ['info', 'warn', 'error'] as const) console[level] = () => {};
const { temp } = await setupEnv('banana-pa1-');
Object.assign(process.env, {
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
  OFFERS: 'off',
});
const bank = await startSimulator('alt');
const bankUrl = process.env.BANK_URL!;
// The app talks to the bank through this proxy; `down` makes it refuse GET /v1/movements.
let down = false;
const proxy = http.createServer(async (req, res) => {
  if (down && req.url?.startsWith('/v1/movements')) {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unavailable', code: 'temporarily_unavailable' }));
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const r = await fetch(`${bankUrl}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: body || undefined,
  });
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
process.env.BANK_URL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

const openai = await fakeOpenAI(() => say('ok'));
const { seedApp } = await import('../src/seed');
const { money } = await import('../src/ui-helpers');
const { closeAppDb } = await import('../src/db');
const { today, occurrence, preparedList } = await import('../src/banking/prepared');
seedApp();
after(() => {
  bank.kill();
  proxy.closeAllConnections();
  proxy.close();
  openai.server.closeAllConnections();
  openai.server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const control = (path: string, body: object) =>
  fetch(`${bankUrl}/_control/${path}`, {
    method: 'POST',
    headers: { 'x-alt-control': 'alt-control' },
    body: JSON.stringify(body),
  });
const balance = (accountId: string, balanceCents: number) =>
  control('balance', { accountId, balanceCents });
const conversation = async () => (await callApi('lucia', 'conversations', {})).body.id as string;
type Script = (body: ModelBody) => object;
async function turn(id: string, content: string, ...script: Script[]) {
  openai.script.length = 0;
  openai.script.push(...script);
  const from = openai.modelRequests.length;
  await callApi('lucia', `conversations/${id}/messages`, { content });
  const requests = openai.modelRequests.slice(from);
  const results = (requests.at(-1)?.input ?? [])
    .filter((i) => i.type === 'function_call_output')
    .map((i) => JSON.parse(i.output!));
  const { messages } = (await callApi('lucia', `conversations/${id}`)).body;
  return { requests, results, extras: messages.at(-1).extras ?? {} };
}
const T = today();
// Tomorrow, or today on the month's last day (occurrence keeps the date inside the month).
const NEXT = occurrence(T, Number(T.slice(8)) + 1);
const prepare = (amountCents: number, date: string) => () =>
  call('prepare_transfer', {
    fromAccountId: 'acc-lucia',
    recipient: 'Bruno',
    toAccountId: null,
    amountCents,
    concept: 'Rent',
    note: null,
    when: 'on_date',
    date,
    inDays: null,
    day: null,
  });
const EUROS = /^€\d{1,3}(,\d{3})*\.\d{2}$/;

test('PA1: a prepare that keeps the account covered says so in one line, and no shortfall', async () => {
  await balance('acc-lucia', 100_000_000);
  const r = await turn(await conversation(), 'Leave €1 ready for Bruno', prepare(100, NEXT));
  assert.equal(r.results[0].status, 'prepared');
  assert.equal(r.results[0].afterThis.covered, true);
  assert.match(r.results[0].afterThis.headline, /^Covered until /);
  assert.equal(r.results[0].afterThis.shortfall, undefined);
  assert.equal(r.extras.quickReplies, undefined);
});

test("PA1: a prepare that leaves the account short carries the forecast's shortfall and cover, offered and not prepared", async () => {
  await balance('acc-lucia', 1_000_00);
  await balance('acc-lucia-savings', 100_000_000);
  const id = await conversation();
  const r = await turn(id, 'Leave the rent ready for Bruno', prepare(2_915_00, NEXT));
  assert.equal(r.results[0].status, 'prepared');
  const { shortfall, cover } = r.results[0].afterThis;
  assert.ok(shortfall, 'a shortfall is told with the prepare');
  assert.match(shortfall.shortEuros, EUROS);
  assert.ok(shortfall.date >= T && shortfall.date <= NEXT);
  // The same figures get_month_forecast gives for that account (asked in another conversation, so
  // the offer stays this conversation's newest answer).
  const f = await turn(await conversation(), 'Will I make it to the end of the month?', () =>
    call('get_month_forecast', {}),
  );
  const account = f.results[0].accounts.find((a: any) => a.id === 'acc-lucia');
  assert.equal(shortfall.shortCents, account.shortfall.shortCents);
  assert.equal(shortfall.explanation, account.explanation);
  assert.match(shortfall.forLabel, /^your prepared transfer to Bruno Vidal/);
  if (NEXT > T) {
    assert.deepEqual(
      [cover.title, cover.consequence],
      [account.coverOptions[0].title, account.coverOptions[0].consequence],
    );
    assert.match(cover.title, /^Move €[\d,.]+ from Personal savings on /);
    // Offered: one reply that asks for it; the turn prepared only the rent.
    assert.deepEqual(
      r.extras.quickReplies?.map((q: any) => q.label),
      ['Yes, prepare it'],
    );
    // Review of #198: the model gets no arguments to copy. On the "Yes, prepare it" reply
    // prepare_cover (no arguments) prepares the offer stored with the answer, and the account the
    // rent leaves is covered afterwards.
    const yes = await turn(id, 'Yes, prepare the transfer that covers it', () =>
      call('prepare_cover', {}),
    );
    assert.equal(yes.results[0].status, 'prepared');
    const made = preparedList('lucia').find((p) => p.id === yes.results[0].prepared.id)!;
    assert.deepEqual([made.fromAccountId, made.toAccountId], ['acc-lucia-savings', 'acc-lucia']);
    assert.ok(cover.title.startsWith(`Move ${money(made.amountCents)} from Personal savings`));
    const after = await turn(id, 'And now?', () => call('get_month_forecast', {}));
    const aurora = after.results[0].accounts.find((a: any) => a.id === 'acc-lucia');
    assert.ok(!aurora.shortfall, 'Aurora, the source of the rent, is covered');
  } else assert.equal(cover, null);
  assert.equal(r.results.length, 1);
  assert.match(r.requests[0].instructions, /afterThis/);
});

// Review of #198: the cover is prepared on the server from the offer stored with the previous
// answer, after a yes, once. Each refusal prepares nothing.
const NO_COVER = NEXT === T && 'no cover on the last day of the month';
const count = () => preparedList('lucia').length;
async function offered() {
  await balance('acc-lucia', 1_000_00);
  await balance('acc-lucia-savings', 100_000_000);
  const id = await conversation();
  const r = await turn(id, 'Leave the rent ready for Bruno', prepare(2_915_00, NEXT));
  assert.ok(r.results[0].afterThis?.cover, 'a cover is offered');
  return id;
}

test('PA1 review: prepare_cover with no cover offered in the previous answer prepares nothing', async () => {
  const id = await conversation();
  await turn(id, 'Hello');
  const before = count();
  const r = await turn(id, 'yes', () => call('prepare_cover', {}));
  assert.equal(r.results[0].status, 'refused');
  assert.match(r.results[0].message, /^Nothing was prepared/);
  assert.equal(count(), before);
});

test(
  'PA1 review: prepare_cover without a yes from the customer prepares nothing',
  { skip: NO_COVER },
  async () => {
    const id = await offered();
    const before = count();
    const r = await turn(id, 'What would that cost me?', () => call('prepare_cover', {}));
    assert.equal(r.results[0].status, 'refused');
    assert.match(r.results[0].message, /^Nothing was prepared/);
    assert.equal(count(), before);
  },
);

test(
  'PA1 review: prepare_cover prepares the offer once, in the run and on a later yes',
  { skip: NO_COVER },
  async () => {
    const id = await offered();
    const before = count();
    const r = await turn(
      id,
      'sí',
      () => call('prepare_cover', {}),
      () => call('prepare_cover', {}),
    );
    assert.deepEqual(
      r.results.map((x) => x.status),
      ['prepared', 'refused'],
    );
    const again = await turn(id, 'yes', () => call('prepare_cover', {}));
    assert.equal(again.results[0].status, 'refused');
    assert.equal(count(), before + 1);
  },
);

test('PA1: create_goal whose first monthly transfer leaves the account short carries the shortfall', async () => {
  await balance('acc-lucia', 0);
  const id = await conversation();
  await turn(id, 'Can I save €1,200?', () =>
    call('plan_goal', {
      name: 'Trip',
      targetCents: 120_000,
      targetDate: occurrence(T, 28, 5),
      day: Number(T.slice(8)), // the first payment is due today
      fromAccountId: null,
      toAccountId: null,
    }),
  );
  const r = await turn(id, 'Create this goal', () => call('create_goal', {}));
  assert.equal(r.results[0].status, 'created');
  assert.ok(r.results[0].afterThis?.shortfall, "the goal's shortfall is told with it");
  assert.equal(r.results[0].afterThis.shortfall.date, T);
  assert.match(r.results[0].afterThis.shortfall.shortEuros, EUROS);
});

test('PA1: when the forecast cannot be worked out the prepare still succeeds, with no afterThis', async () => {
  const id = await conversation();
  // The bank's movements cannot be read.
  down = true;
  const r = await turn(id, 'Leave €1 ready for Bruno', prepare(100, NEXT)).finally(
    () => (down = false),
  );
  assert.equal(r.results[0].status, 'prepared');
  assert.equal('afterThis' in r.results[0], false);
  // A full page of movements that does not reach three months back (the last check of the file:
  // the movements stay).
  for (let i = 0; i < 100; i++)
    await control('movement', { accountId: 'acc-lucia', amountCents: -1, description: 'Coffee' });
  const s = await turn(id, 'Leave €1 ready for Bruno', prepare(100, NEXT));
  assert.equal(s.results[0].status, 'prepared');
  assert.equal('afterThis' in s.results[0], false);
});
