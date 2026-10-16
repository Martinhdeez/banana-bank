// TR1 (plan 27, REQ-TR-1…9): one row of `ai_usage` per model request, for the right customer,
// written as each request returns, never able to fail a turn; exact integer costs; an
// operator-only report with no customer text. The real route handlers on the bundled bank, a local
// fake of the OpenAI API and a local stand-in of the System One wire format: no provider is called.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
import { call, fakeOpenAI, say } from './helpers/openai';

for (const level of ['info', 'warn'] as const) console[level] = () => {};
const MARKER = 'ZXMARKERQ7';
// System One stand-in: `RETRY` answers 429 once, `BADANSWER` a 200 nobody can use (with usage),
// anything else a usable 200. The retried one also carries a gateway's `usage.cost`.
const retried = new Set<string>();
const decider = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const description = String(JSON.parse(raw).state.description);
  const send = (status: number, body: object, headers: Record<string, string> = {}) =>
    res
      .writeHead(status, { 'Content-Type': 'application/json', ...headers })
      .end(JSON.stringify(body));
  if (description.includes('RETRY') && !retried.has(description)) {
    retried.add(description);
    return send(429, {}, { 'retry-after': '0' });
  }
  if (description.includes('BADANSWER'))
    return send(200, { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 33 } });
  send(200, {
    model: 'jev-1.13.0',
    answers: {
      category: {
        type: 'choice',
        choice: 'transport',
        confidence: 0.97,
        probabilities: { transport: 0.97, shopping: 0.03 },
      },
    },
    usage: description.includes('RETRY')
      ? { input_tokens: 40, output_tokens: 1, cost: 0.000002 }
      : {
          input_tokens: description.includes('ALPHA')
            ? 51
            : description.includes('BRAVO')
              ? 52
              : 30,
          output_tokens: 1,
        },
  });
});
await new Promise<void>((r) => decider.listen(0, '127.0.0.1', () => r()));
const { temp } = await setupEnv('banana-tr1-');
Object.assign(process.env, {
  DECIDER: 'systemone',
  DECIDER_API_KEY: 'tr1-test-not-a-key',
  DECIDER_BASE_URL: `http://127.0.0.1:${(decider.address() as AddressInfo).port}`,
  AI_PRICES: 'fake-model=1/0.5/2', // the fake's model id: 1000 / 500 / 2000 nano-dollars a token
});
const openai = await fakeOpenAI(() => say('ok'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { config } = await import('../src/config');
const { sessionToken } = await import('../src/auth');
const { costNanoUsd, priceFor } = await import('../src/usage/prices');
const { usageScope } = await import('../src/usage/record');
const { madridDayStart } = await import('../src/usage/report');
const { classifyMovements } = await import('../src/insights/classify');
const { embedTexts } = await import('../src/retrieval/embeddings');
const api = await import('../app/api/[...path]/route');
seedApp();
const bank = await startSimulator();
after(() => {
  bank.kill();
  for (const s of [decider, openai.server]) {
    s.closeAllConnections();
    s.close();
  }
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

type Row = Record<string, any>;
const rows = (where = '1', ...params: unknown[]) =>
  appDb()
    .prepare(`SELECT * FROM ai_usage WHERE ${where} ORDER BY id`)
    .all(...params) as Row[];
const count = () => rows().length;
async function get(userId: string | null, route: string) {
  const response = await api.GET(
    new Request(`http://localhost/api/${route}`, {
      headers: userId ? { cookie: `banana_actor=${sessionToken(userId)}` } : {},
    }),
    { params: Promise.resolve({ path: route.split('?')[0].split('/') }) },
  );
  const text = await response.text();
  return { status: response.status, text, body: text.startsWith('{') ? JSON.parse(text) : null };
}
async function turn(userId: string, content: string) {
  const { body } = await callApi(userId, 'conversations', {});
  const r = await callApi(userId, `conversations/${body.id}/messages`, { content });
  return { conversationId: body.id as string, ...r };
}
const assistant = (runId: string) => rows("run_id=? AND consumer='assistant'", runId);
let luciaRun = '';

test('REQ-TR-1: three model requests of a turn are three rows with their usage, tools, customer and run', async () => {
  openai.script.push(
    () => ({
      ...call('list_accounts', {}),
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 5 },
      },
    }),
    () => ({
      ...call('request_human', { summary: `Help ${MARKER}` }),
      usage: { input_tokens: 200, output_tokens: 30 },
    }),
    () => ({ ...say(`Done ${MARKER}`), usage: { input_tokens: 300, output_tokens: 40 } }),
  );
  const r = await turn('lucia', `Please open a case ${MARKER}`);
  assert.equal(r.status, 200);
  luciaRun = r.body.runId;
  const made = assistant(luciaRun);
  assert.deepEqual(
    made.map((x) => [
      x.seq,
      x.tools,
      x.input_tokens,
      x.cached_input_tokens,
      x.output_tokens,
      x.reasoning_tokens,
    ]),
    [
      [1, '["list_accounts"]', 100, 40, 20, 5],
      [2, '["request_human"]', 200, null, 30, null],
      [3, '[]', 300, null, 40, null],
    ],
  );
  for (const x of made)
    assert.deepEqual(
      [x.actor, x.user_id, x.conversation_id, x.outcome, x.attempt, x.host, x.model],
      ['customer', 'lucia', r.conversationId, 'ok', 1, '127.0.0.1', 'fake-model'],
    );
  // (100 − 40) × 1000 + 40 × 500 + 20 × 2000, with the price and its source copied into the row.
  assert.deepEqual(
    [made[0].cost_nano_usd, made[0].cost_basis, made[0].price_input, made[0].price_source],
    [120000, 'estimated', 1000, 'AI_PRICES setting'],
  );
  // The message's embedding request belongs to the same run and customer.
  const embedded = rows("run_id=? AND consumer='embeddings'", luciaRun);
  assert.ok(embedded.length >= 1);
  assert.ok(embedded.every((x) => x.user_id === 'lucia' && x.input_tokens === 1));
  // The case view: the run's line data.
  const caseId = appDb()
    .prepare('SELECT id FROM incidents WHERE conversation_id=?')
    .pluck()
    .get(r.conversationId) as string;
  const detail = await get('marta', `incidents/${caseId}`);
  const run = detail.body.runs.find((x: Row) => x.id === luciaRun);
  assert.equal(run.usage.requests, rows('run_id=?', luciaRun).length);
  assert.ok(run.usage.inputTokens >= 600);
});

test('REQ-TR-2: a turn whose third request fails keeps the two billed rows and one failed row without tokens', async () => {
  const quiet = test.mock.method(console, 'error', () => {});
  openai.script.push(
    () => call('list_accounts', {}),
    () => call('list_accounts', {}),
    () => ({ fail: 500 }),
  );
  const r = await turn('bruno', 'What are my accounts?');
  quiet.mock.restore();
  assert.deepEqual([r.status, r.body.code], [502, 'provider_busy']);
  const runId = appDb()
    .prepare('SELECT id FROM runs WHERE conversation_id=?')
    .pluck()
    .get(r.conversationId) as string;
  assert.deepEqual(
    assistant(runId).map((x) => [
      x.seq,
      x.outcome,
      x.input_tokens,
      x.output_tokens,
      x.cost_nano_usd,
      x.cost_basis,
      x.model,
    ]),
    [
      [1, 'ok', 1, 1, 3000, 'estimated', 'fake-model'],
      [2, 'ok', 1, 1, 3000, 'estimated', 'fake-model'],
      [3, 'failed', null, null, null, 'unpriced', config.chatModel],
    ],
  );
});

// Review of TR1: the row is written before the answer is parsed.
test('REQ-TR-2: a billed answer the turn cannot parse (an unknown output item) still leaves its row', async () => {
  const quiet = test.mock.method(console, 'error', () => {});
  openai.script.push(() => ({ type: 'tr1_item_no_sdk_knows' }));
  const r = await turn('bruno', 'What are my accounts?');
  quiet.mock.restore();
  assert.ok(r.status >= 500, `the turn fails as before: ${r.status}`);
  const runId = appDb()
    .prepare('SELECT id FROM runs WHERE conversation_id=?')
    .pluck()
    .get(r.conversationId) as string;
  assert.deepEqual(
    assistant(runId).map((x) => [x.seq, x.outcome, x.input_tokens, x.cost_nano_usd, x.tools]),
    [[1, 'ok', 1, 3000, '[]']],
  );
});

test('Attribution: two turns at once keep their own customer; no scope is `system`', async () => {
  const [a, b] = await Promise.all([turn('carla', 'Hello from one'), turn('diego', 'Hello two')]);
  for (const [r, userId] of [
    [a, 'carla'],
    [b, 'diego'],
  ] as const) {
    const made = rows('conversation_id=?', r.conversationId);
    assert.ok(made.length >= 2); // the model request and the embedding
    assert.ok(made.every((x) => x.user_id === userId && x.run_id === r.body.runId));
  }
  const before = count();
  await embedTexts(['a text nobody embedded before']);
  const [row] = rows('id>?', before);
  assert.deepEqual([row.actor, row.user_id, row.run_id], ['system', null, null]);
});

test('REQ-TR-4: every System One attempt is a row for the customer classified; a kept answer costs nothing', async () => {
  const movement = (id: string, description: string) => ({
    id,
    accountId: 'acc-elena',
    amountCents: -1234,
    description,
    createdAt: '2026-10-01T10:00:00.000Z',
  });
  const input = {
    userId: 'elena',
    movements: [
      movement('tr1-a', 'ZZQ RETRY SHOP'),
      movement('tr1-b', 'ZZQ PLAIN STORE'),
      movement('tr1-c', 'ZZQ BADANSWER MART'),
    ],
    ownAccountIds: new Set(['acc-elena']),
    wait: true,
  };
  const first = count();
  // Started inside someone else's open scope: the rows are still Elena's, with no conversation.
  await usageScope(
    { actor: 'customer', userId: 'hugo', conversationId: 'conv-x', runId: 'x' },
    () => classifyMovements(input),
  );
  const made = rows('id>?', first);
  assert.ok(made.every((x) => x.consumer === 'decider:systemone'));
  assert.ok(made.every((x) => x.user_id === 'elena' && x.conversation_id === null && !x.run_id));
  assert.deepEqual(
    made
      .map((x) => [x.attempt, x.outcome, x.input_tokens, x.cost_nano_usd, x.cost_basis])
      .sort((x, y) => String(x).localeCompare(String(y))),
    [
      [1, 'failed', null, null, 'unpriced'], // the 429 reported nothing
      [1, 'failed', 33, 1386, 'estimated'], // a 200 nobody can use was billed: 33 × 42
      [1, 'ok', 30, 1260, 'estimated'], // 30 × 42, output is free
      [2, 'ok', 40, 2000, 'provider'], // REQ-TR-5: the provider's own figure wins
    ],
  );
  assert.ok(made.every((x) => x.host === '127.0.0.1' && x.model.startsWith('jev-1.13')));
  const before = count();
  await classifyMovements(input);
  assert.equal(count(), before);
});

test('Attribution: two customers classified at once, more merchants than the decider queue lets through', async () => {
  const WORDS = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN'];
  const input = (userId: string, word: string) => ({
    userId,
    movements: WORDS.map((w, i) => ({
      id: `tr1-${word}-${i}`,
      accountId: `acc-${userId}`,
      amountCents: -1234,
      description: `ZZQ ${word} ${w} SHOP`,
      createdAt: '2026-10-01T10:00:00.000Z',
    })),
    ownAccountIds: new Set([`acc-${userId}`]),
    wait: true,
  });
  const first = count();
  await Promise.all([
    classifyMovements(input('felix', 'ALPHA')),
    classifyMovements(input('gema', 'BRAVO')),
  ]);
  // The stand-in answers 51 tokens for one customer's merchants and 52 for the other's.
  const made = rows('id>?', first).map((x) => `${x.user_id} ${x.input_tokens}`);
  assert.deepEqual([...new Set(made)].sort(), ['felix 51', 'gema 52']);
  assert.equal(made.length, 2 * WORDS.length); // 14 requests through a queue of 8
});

test('REQ-TR-5: a cost is exact integer arithmetic, or null', () => {
  const cost = (model: string, tokens: Parameters<typeof costNanoUsd>[0]) =>
    costNanoUsd(tokens, priceFor(model, {}));
  // 600 × 100 + 400 × 10 + 100 × 500: cached at its own rate, reasoning not added again.
  assert.equal(cost('gpt-6-luna-2026-09-01', { input: 1000, cached: 400, output: 100 }), 114000);
  assert.equal(cost('text-embedding-3-small', { input: 10, output: 0 }), 200);
  assert.equal(cost('jev-1.13.0', { input: 1000 }), 42000);
  assert.equal(cost('some-other-model', { input: 1000, output: 10 }), null);
  assert.equal(cost('gpt-6-luna', { output: 10 }), null);
  assert.equal(cost('gpt-6-luna', { input: 10 }), null);
  assert.equal(cost('gpt-6-luna', { input: 10, cached: 11, output: 1 }), null);
  assert.equal(cost('text-embedding-3-small', { input: 10, cached: 5, output: 0 }), null);
});

test('REQ-TR-7, REQ-TR-6: operator only, strict query, totals that add up; a price change leaves stored rows alone', async () => {
  for (const route of ['usage', 'usage/export.csv']) {
    assert.equal((await get('lucia', route)).status, 403);
    assert.equal((await get(null, route)).status, 401);
  }
  for (const query of ['nope=1', 'period=all&period=7d', 'period=month', 'customer=lucia&run=x'])
    assert.equal((await get('marta', `usage?${query}`)).status, 400, query);
  assert.equal((await get('marta', 'usage/export.csv?customer=lucia')).status, 400);
  const { body } = await get('marta', 'usage?period=all');
  const KEYS = ['requests', 'failed', 'inputTokens', 'outputTokens', 'costNanoUsd'] as const;
  const add = (list: Row[]) => KEYS.map((k) => list.reduce((sum, t) => sum + (t[k] ?? 0), 0));
  const total = add([body.totals]);
  assert.equal(body.totals.requests, count());
  assert.deepEqual(add([...body.byCustomer, body.staffAndSystem]), total);
  assert.deepEqual(add(body.byConsumer), total);
  const shares = body.byCustomer.reduce((sum: number, c: Row) => sum + (c.sharePct ?? 0), 0);
  assert.ok(Math.abs(shares - 100) <= 1, String(shares));
  assert.deepEqual(
    body.byTool.find((t: Row) => t.tool === 'request_human'),
    {
      tool: 'request_human',
      calls: 1,
      runs: 1,
    },
  );
  assert.equal(body.prices.find((p: Row) => p.model === 'fake-model').source, 'AI_PRICES setting');
  assert.match(body.prices.find((p: Row) => p.model === 'gpt-6-luna').source, /read 2026-10-05/);
  // The price is copied into each row: changing it later does not rewrite what was spent.
  config.aiPrices['fake-model'] = { input: 9000, cached: 9000, output: 9000 };
  assert.deepEqual((await get('marta', 'usage?period=all')).body.totals, body.totals);
  const csv = await get('marta', 'usage/export.csv?period=all');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^﻿?customer_id,name,requests,/);
  assert.match(csv.text, /\r\nstaff_and_system,Staff and system,/);
});

test('REQ-TR-8: no message, tool argument, answer or key in the table or in any answer of the route', async () => {
  const customer = await get('marta', 'usage?customer=lucia&period=all');
  const run = await get('marta', `usage?run=${luciaRun}`);
  assert.deepEqual(
    customer.body.conversations[0].runs.map((r: Row) => r.runId),
    [luciaRun],
  );
  assert.deepEqual(
    run.body.requests.filter((r: Row) => r.consumer === 'assistant').map((r: Row) => r.tools),
    [['list_accounts'], ['request_human'], []],
  );
  const all = [
    JSON.stringify(rows()),
    (await get('marta', 'usage?period=all')).text,
    customer.text,
    run.text,
    (await get('marta', 'usage/export.csv?period=all')).text,
  ].join('\n');
  assert.doesNotMatch(all, new RegExp(`${MARKER}|test-fake|tr1-test-not-a-key|Bearer|"title"|ZZQ`));
});

test('Periods start on a Europe/Madrid day, not a UTC day', () => {
  assert.equal(madridDayStart(new Date('2026-10-05T10:00:00Z')), '2026-10-04T22:00:00.000Z');
  assert.equal(madridDayStart(new Date('2026-10-05T23:30:00Z')), '2026-10-05T22:00:00.000Z');
  assert.equal(madridDayStart(new Date('2026-12-01T10:00:00Z'), 6), '2026-11-24T23:00:00.000Z');
});

test('REQ-TR-9: AI_USAGE=off writes nothing', async () => {
  const before = count();
  config.aiUsage = 'off';
  try {
    assert.equal((await turn('ines', 'Hello while off')).status, 200);
    assert.equal((await get('marta', 'usage')).body.enabled, false);
  } finally {
    config.aiUsage = 'on';
  }
  assert.equal(count(), before);
});

// Last: it drops the table.
test('REQ-TR-3: a usage write that fails changes nothing for the customer and logs once', async (t) => {
  appDb().exec('DROP TABLE ai_usage');
  const logged = t.mock.method(console, 'error', () => {});
  openai.script.push(() => say('Still answering'));
  const r = await turn('omar', 'Hello after the table is gone');
  assert.deepEqual([r.status, r.body.answer], [200, 'Still answering']);
  const dashboard = await get('omar', 'dashboard');
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.body.accounts.length);
  const lines = logged.mock.calls.filter((c) =>
    String(c.arguments[0]).includes('usage_write_failed'),
  );
  assert.equal(lines.length, 1);
});
