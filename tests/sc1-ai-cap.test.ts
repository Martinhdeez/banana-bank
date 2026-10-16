// SC1: a daily AI spend cap per customer (AI_DAILY_CAP_USD). At the cap a chat turn makes no
// provider request of any kind and takes the failed-turn path with one fixed sentence; the decider
// is not asked; money and support paths go on. The real route handlers on the bundled bank and a
// local fake of the OpenAI API: no provider is called.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
import { fakeOpenAI, say } from './helpers/openai';

for (const level of ['info', 'warn', 'error'] as const) console[level] = () => {};
const { temp } = await setupEnv('banana-sc1-');
process.env.AI_DAILY_CAP_USD = '0.001'; // 1,000,000 nano-dollars
const openai = await fakeOpenAI(() => say('ok'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { config } = await import('../src/config');
const { classifyMovements } = await import('../src/insights/classify');
seedApp();
const bank = await startSimulator();
after(() => {
  bank.kill();
  openai.server.closeAllConnections();
  openai.server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const SENTENCE =
  'The assistant is not available for the rest of today. Your accounts, transfers and confirmations still work from the other tabs, and you can ask for human support here.';
const CAP = 1_000_000;
const DAY = 24 * 3600_000;
// One recorded request of `userId`: a priced cost, or unpriced tokens (cost NULL).
function spent(
  userId: string,
  { cost = null as number | null, tokens = 0, actor = 'customer', at = Date.now() } = {},
) {
  appDb()
    .prepare(
      `INSERT INTO ai_usage(created_at,actor,user_id,consumer,seq,attempt,outcome,model,host,input_tokens,output_tokens,tools,cost_nano_usd,cost_basis)
       VALUES(?,?,?,'assistant',1,1,'ok','m','h',?,0,'[]',?,?)`,
    )
    .run(
      new Date(at).toISOString(),
      actor,
      userId,
      tokens,
      cost,
      cost === null ? 'unpriced' : 'estimated',
    );
}
const requests = () => openai.modelRequests.length + openai.embeddingInputs.length;
let n = 0;
async function turn(userId: string) {
  const { body } = await callApi(userId, 'conversations', {});
  // A new text each time: an embedding already cached would not be asked for again.
  const r = await callApi(userId, `conversations/${body.id}/messages`, { content: `Hello ${n++}` });
  return { conversationId: body.id as string, ...r };
}
const overview = async () => (await callApi('marta', 'usage')).body;

test('SC1: over the limit, a turn answers the fixed sentence with no provider request; support and money paths go on', async () => {
  spent('lucia', { cost: CAP });
  const before = requests(),
    rows = appDb().prepare('SELECT COUNT(*) FROM ai_usage').pluck().get();
  const r = await turn('lucia');
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'ai_daily_limit');
  assert.equal(r.body.error, SENTENCE);
  assert.equal(requests(), before, 'no model or embedding request');
  assert.equal(appDb().prepare('SELECT COUNT(*) FROM ai_usage').pluck().get(), rows);
  // Stored like any failed turn: the page offers "Ask for human support" on the marker.
  const { messages } = (await callApi('lucia', `conversations/${r.conversationId}`)).body;
  assert.deepEqual(
    messages.map((m: any) => [m.role, m.extras?.turnFailed ?? null]),
    [
      ['user', null],
      ['assistant', 'ai_daily_limit'],
    ],
  );
  assert.equal(messages[1].content, SENTENCE);
  assert.doesNotMatch(messages[1].content, /[$€\d]/);

  // The button's request, a transfer with its confirmation, a cancelled one, a prepared transfer
  // sent, the dashboard: none goes through the model.
  const human = await callApi('lucia', 'actions', {
    name: 'request_human',
    arguments: { summary: 'Help' },
    conversationId: r.conversationId,
  });
  assert.ok(human.body.incidentId, JSON.stringify(human.body));
  const transfer = {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    amountCents: 1200,
    concept: 'Lunch',
  };
  const propose = async () =>
    (await callApi('lucia', 'actions', { name: 'transfer_money', arguments: transfer })).body;
  const confirmed = await callApi(
    'lucia',
    `approvals/${(await propose()).approval.id}/confirm`,
    {},
  );
  assert.equal(confirmed.body.status, 'completed');
  const cancelled = await callApi('lucia', `approvals/${(await propose()).approval.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  const prepared = await callApi('lucia', 'prepared', { ...transfer, when: 'manual' });
  assert.equal(prepared.body.status, 'prepared', JSON.stringify(prepared.body));
  const sent = await callApi('lucia', `prepared/${prepared.body.prepared.id}/send`, {});
  assert.equal(sent.body.status, 'requires_confirmation', JSON.stringify(sent.body));
  assert.equal((await callApi('lucia', 'dashboard')).status, 200);
  assert.equal(requests(), before);

  // The operator's report: the limit, and who is at it today.
  const body = await overview();
  assert.equal(body.cap.dailyNanoUsd, CAP);
  assert.equal(body.cap.unpricedTokens, 1_000_000);
  assert.equal(new Date(body.cap.dayStart).toISOString(), body.cap.dayStart);
  assert.equal(body.byCustomer.find((c: any) => c.userId === 'lucia').capped, true);
});

test("SC1: yesterday's rows and operator or system rows do not trip the cap; unpriced tokens over the constant do", async () => {
  spent('bruno', { cost: CAP * 5, at: Date.now() - 2 * DAY });
  spent('bruno', { cost: CAP * 5, actor: 'operator' });
  spent('bruno', { cost: CAP * 5, actor: 'system' });
  spent('bruno', { cost: CAP - 1000 }); // today, under the limit
  spent('bruno', { tokens: 999_000 });
  const ok = await turn('bruno');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await overview()).byCustomer.find((c: any) => c.userId === 'bruno').capped, false);
  spent('bruno', { tokens: 1000 });
  const before = requests();
  assert.equal((await turn('bruno')).body.code, 'ai_daily_limit');
  assert.equal(requests(), before);
});

test('SC1: the usage table missing: the turn runs normally', async () => {
  appDb().exec('ALTER TABLE ai_usage RENAME TO ai_usage_gone');
  try {
    const r = await turn('lucia');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.answer, 'ok');
  } finally {
    appDb().exec('ALTER TABLE ai_usage_gone RENAME TO ai_usage');
  }
});

test('SC1: a capped customer gets no decider request; the movements go to "to sort" as decider_budget', async () => {
  let asked = 0;
  const input = {
    userId: 'lucia',
    movements: [
      {
        id: 'sc1-m1',
        accountId: 'acc-lucia',
        amountCents: -1234,
        description: 'ZZQ SCONE SHOP',
        createdAt: '2026-10-01T10:00:00.000Z',
      },
    ],
    ownAccountIds: new Set(['acc-lucia']),
    wait: true,
    deciders: [
      {
        id: 'systemone' as const,
        threshold: 0.8,
        classify: async () => {
          asked++;
          return {
            candidates: [{ category: 'shopping' as const, p: 0.99 }],
            confidence: 0.99,
            model: 'm',
          };
        },
      },
    ],
  };
  for (const _ of [1, 2]) {
    const row = (await classifyMovements(input)).get('sc1-m1')!;
    assert.deepEqual([row.state, row.reason], ['needs_review', 'decider_budget']);
  }
  assert.equal(asked, 0);
  // The day after (no row of today): the movement left over is asked for.
  appDb().prepare("DELETE FROM ai_usage WHERE user_id='lucia'").run();
  assert.equal((await classifyMovements(input)).get('sc1-m1')!.state, 'estimated');
  assert.equal(asked, 1);
});

test('SC1: no cap set: nothing changes, and the report says so', async () => {
  spent('lucia', { cost: CAP * 5 });
  assert.equal((await turn('lucia')).body.code, 'ai_daily_limit');
  const cap = config.aiDailyCapNanoUsd;
  config.aiDailyCapNanoUsd = null;
  try {
    assert.equal((await turn('lucia')).status, 200);
    const body = await overview();
    assert.equal(body.cap, null);
    assert.ok(body.byCustomer.every((c: any) => c.capped === false));
  } finally {
    config.aiDailyCapNanoUsd = cap;
  }
});

test('SC1: AI_DAILY_CAP_USD is whole nano-dollars; a bad value, or a value with AI_USAGE=off, stops startup', () => {
  const load = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        `const { config } = await import(${JSON.stringify(`${process.cwd()}/src/config.ts`)}); console.log(config.aiDailyCapNanoUsd);`,
      ],
      { cwd: temp, env: { ...process.env, AI_USAGE: 'on', ...env }, encoding: 'utf8' },
    );
  assert.equal(load({ AI_DAILY_CAP_USD: '0.25' }).stdout.trim(), '250000000');
  assert.equal(load({ AI_DAILY_CAP_USD: '0.0000005' }).stdout.trim(), '500');
  assert.equal(load({ AI_DAILY_CAP_USD: '' }).stdout.trim(), 'null');
  for (const value of ['abc', '-1', '0', '1e3', '0.0000000001', '$5']) {
    const bad = load({ AI_DAILY_CAP_USD: value });
    assert.notEqual(bad.status, 0, value);
    assert.match(bad.stderr, /AI_DAILY_CAP_USD must be/);
  }
  const off = load({ AI_DAILY_CAP_USD: '0.25', AI_USAGE: 'off' });
  assert.notEqual(off.status, 0);
  assert.match(off.stderr, /AI_DAILY_CAP_USD needs AI_USAGE=on/);
});
