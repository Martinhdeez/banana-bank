// GL3 (plan 28 §4.5, D6, D9, §13; REQ-PL-25, REQ-PL-26): the Plan area in the chat. One check per
// real risk: a goal created without the customer's yes, money moving, a figure that is not the
// routes', the customer's own label reaching a model, another customer's data, the switches and
// the AI cap. The real route handlers on the bundled bank and a local fake of the OpenAI API whose
// turns are scripted: no provider is called.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
import { call, fakeOpenAI, say, type ModelBody } from './helpers/openai';

for (const level of ['info', 'warn', 'error'] as const) console[level] = () => {};
const { temp } = await setupEnv('banana-gl3-');
process.env.AI_DAILY_CAP_USD = '5';
process.env.OFFERS = 'off'; // a product suggestion would take the turn's one volunteered slot
const openai = await fakeOpenAI(() => say('ok'));
const { seedBank } = await import('../simulator/seed');
const { setScenario } = await import('../simulator/bank');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { today, occurrence } = await import('../src/banking/prepared');
const { operations } = await import('./helpers/data');
const { withEuros } = await import('../src/agent/goals');
seedApp();
seedBank();
const bank = await startSimulator();
setScenario('normal');
after(() => {
  bank.kill();
  openai.server.closeAllConnections();
  openai.server.close();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const count = (table: string) =>
  appDb().prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
// Everything a money path would leave behind.
const money = () => ({
  intents: count('intents'),
  approvals: count('approvals'),
  bank: operations(),
});
const before = money();
const conversation = async (user: string) =>
  (await callApi(user, 'conversations', {})).body.id as string;
type Script = (body: ModelBody) => object;
// One chat turn whose model is `script` (then "ok"). `results`: what the model was sent back for
// its tool calls; `extras`: what was stored with the answer.
async function turn(user: string, id: string, content: string, ...script: Script[]) {
  openai.script.length = 0;
  openai.script.push(...script);
  const from = openai.modelRequests.length;
  const r = await callApi(user, `conversations/${id}/messages`, { content });
  const requests = openai.modelRequests.slice(from);
  const results = (requests.at(-1)?.input ?? [])
    .filter((i) => i.type === 'function_call_output')
    .map((i) => JSON.parse(i.output!));
  const { messages } = (await callApi(user, `conversations/${id}`)).body;
  return { ...r, requests, results, extras: messages.at(-1).extras ?? {} };
}
const T = today();
const target = { targetCents: 120_000, targetDate: occurrence(T, 28, 5) };
const planCall = () => call('plan_goal', { name: 'Trip to Lisbon', ...target });

test('REQ-PL-25: create_goal creates nothing without a plan shown in this conversation and a yes; after the yes, exactly the plan shown', async () => {
  const a = await conversation('lucia');
  const none = await turn('lucia', a, 'Create a goal for me', () => call('create_goal', {}));
  assert.equal(none.results[0].reason, 'no_plan_shown');

  // The plan is shown: a card and its two replies are stored, nothing else is written.
  const shown = await turn('lucia', a, 'Can I save €1,200 for a trip?', planCall);
  const card = shown.extras.goalPlan;
  assert.deepEqual(shown.results[0].plan, card);
  assert.deepEqual(
    shown.extras.quickReplies.map((r: any) => r.label),
    ['Create this goal', 'Change something'],
  );
  // REQ-PL-26: the dry run of the route, to the cent.
  const route = await callApi('lucia', 'goals/plan', { ...target, day: 3 });
  const { monthlyCents, payments, firstDue, lastDue, fits } = card;
  assert.deepEqual({ monthlyCents, payments, firstDue, lastDue, fits }, route.body);
  assert.deepEqual(
    [card.name, card.from.id, card.to.id, card.day],
    ['Trip to Lisbon', 'acc-lucia', 'acc-lucia-savings', 3],
  );

  // A yes in another conversation of the same customer, and in another customer's.
  const other = await turn('lucia', await conversation('lucia'), 'Create this goal', () =>
    call('create_goal', {}),
  );
  assert.equal(other.results[0].reason, 'no_plan_shown');
  const bruno = await turn('bruno', await conversation('bruno'), 'Create this goal', () =>
    call('create_goal', {}),
  );
  assert.equal(bruno.results[0].reason, 'no_plan_shown');
  // Something other than a yes, whatever the model then does.
  const no = await turn('lucia', a, 'Hmm, what is my balance first?', () =>
    call('create_goal', {}),
  );
  assert.equal(no.results[0].reason, 'not_confirmed');
  assert.deepEqual([count('goals'), count('prepared_transfers')], [0, 0]);
  // That answer showed no plan, so a yes now has nothing to confirm.
  const late = await turn('lucia', a, 'Create this goal', () => call('create_goal', {}));
  assert.equal(late.results[0].reason, 'no_plan_shown');
  assert.deepEqual([count('goals'), count('prepared_transfers')], [0, 0]);

  // GL3 review: an acknowledgement is not a yes, and a turn that ended without an answer showed
  // no plan (no card, no replies), so a yes after it has nothing to confirm.
  await turn('lucia', a, 'Show me that plan', planCall);
  const ok = await turn('lucia', a, 'Ok, vale', () => call('create_goal', {}));
  assert.equal(ok.results[0].reason, 'not_confirmed');
  const stuck = await turn('lucia', a, 'Plan it', ...Array(7).fill(planCall));
  assert.deepEqual(stuck.extras, { turnFailed: 'no_answer' });
  assert.deepEqual([count('goals'), count('prepared_transfers')], [0, 0]);

  // Shown again, then the reply: one goal and one monthly prepared transfer with the figures
  // shown, although the model passes other numbers and asks twice.
  await turn('lucia', a, 'Show me that plan again', planCall);
  const lie = () => call('create_goal', { targetCents: 9_999_900, monthlyCents: 1, day: 15 });
  const yes = await turn('lucia', a, 'Create this goal', lie, lie);
  assert.deepEqual(
    yes.results.map((r) => r.reason ?? r.status),
    ['created', 'already_created'],
  );
  const goals = appDb().prepare('SELECT * FROM goals').all() as any[];
  const prepared = appDb().prepare('SELECT * FROM prepared_transfers').all() as any[];
  assert.deepEqual(
    goals.map((g) => [g.user_id, g.name, g.target_cents, g.target_date]),
    [['lucia', 'Trip to Lisbon', target.targetCents, target.targetDate]],
  );
  assert.deepEqual(
    prepared.map((p) => [p.goal_id, p.amount_cents, p.day, p.from_account_id, p.to_account_id]),
    [[goals[0].id, card.monthlyCents, 3, 'acc-lucia', 'acc-lucia-savings']],
  );
  assert.deepEqual(yes.extras.goalCreated, {
    id: goals[0].id,
    name: 'Trip to Lisbon',
    monthlyCents: card.monthlyCents,
    firstDue: card.firstDue,
    targetCents: target.targetCents,
    targetDate: target.targetDate,
    today: T,
  });
  assert.equal(yes.extras.goalPlan, undefined);
  // The goal is made; the same reply again creates no second one. A typed yes counts too.
  const again = await turn('lucia', a, 'Create this goal', () => call('create_goal', {}));
  assert.equal(again.results[0].reason, 'no_plan_shown');
  await turn('lucia', a, 'And one more like it', planCall);
  const typed = await turn('lucia', a, 'Yes, please!', () => call('create_goal', {}));
  assert.equal(typed.results[0].status, 'created');
  assert.deepEqual([count('goals'), count('prepared_transfers')], [2, 2]);
});

test("REQ-PL-26: the tools answer the figures of the routes, for the conversation's customer only", async () => {
  // Two due prepared transfers that each fit and together do not: a shortfall today.
  const { accounts } = (await callApi('lucia', 'dashboard')).body;
  const half = Math.floor(accounts.find((x: any) => x.id === 'acc-lucia').balanceCents * 0.6);
  for (const [concept, amountCents] of [
    ['Rent', half],
    ['Car', half + 100],
  ] as const) {
    const p = await callApi('lucia', 'prepared', {
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-bruno',
      amountCents,
      concept,
      when: 'on_date',
      date: T,
    });
    assert.equal(p.body.status, 'prepared', JSON.stringify(p.body));
  }
  const id = await conversation('lucia');
  const t = await turn(
    'lucia',
    id,
    'How are my goals and my month?',
    () => call('list_goals', {}),
    () => call('get_month_forecast', {}),
  );
  const [{ status, ...goals }, forecast] = t.results;
  assert.equal(status, 'ok');
  // GL4: the route's figures, each amount with its euro string beside it.
  assert.deepEqual(goals, withEuros((await callApi('lucia', 'goals')).body));
  assert.equal(goals.goals.length, 2);
  const page = (await callApi('lucia', 'dashboard')).body.forecast;
  assert.deepEqual(
    forecast.accounts.map((x: any) => [x.id, x.headline, x.explanation, x.shortfall, x.events]),
    page.accounts.map((x: any) => [
      x.id,
      x.headline,
      x.explanation,
      x.shortfall && (({ preparedId: _, ...s }) => s)(x.shortfall),
      x.events.map((e: any) => ({
        date: e.date,
        label: e.label,
        amountCents: e.amountCents,
        balanceAfterCents: e.balanceAfterCents,
        source: e.source,
        certainty: e.certainty,
        ...(e.note && { note: e.note }),
      })),
    ]),
  );
  assert.match(forecast.accounts.find((x: any) => x.shortfall).headline, /^€[\d,.]+ short on /);

  // Bruno's conversation: his own forecast, no goal of Lucía's, and no plan with one account.
  const b = await turn(
    'bruno',
    await conversation('bruno'),
    'And mine?',
    () => call('list_goals', {}),
    () => call('get_month_forecast', {}),
    () => call('plan_goal', { ...target }),
  );
  assert.deepEqual(b.results[0].goals, []);
  assert.deepEqual(
    b.results[1].accounts.map((x: any) => x.id),
    ['acc-bruno'],
  );
  assert.equal(b.results[2].reason, 'single_account');
  assert.equal(b.results[2].message, (await callApi('bruno', 'goals')).body.canSaveReason);
  assert.equal(b.extras.goalPlan, undefined);
  assert.ok(!JSON.stringify(b.requests).includes('Trip to Lisbon'), "Lucía's goal in Bruno's turn");
});

test('plan 28 §13: the label of a charge the customer added never reaches the model; its amount and date do', async () => {
  // Through the real route: one charge that causes a shortfall (the page's sentence names it) and
  // one that a prepared transfer already is (the page's "not counted" line names it).
  const { accounts } = (await callApi('lucia', 'dashboard')).body;
  const half = Math.floor(accounts.find((x: any) => x.id === 'acc-lucia').balanceCents * 0.6);
  const expect = { kind: 'expect', accountId: 'acc-lucia', repeats: 'once', date: T };
  for (const [label, amountCents] of [
    ['A-ZEBRA-ONE', 9_876_543],
    ['A-ZEBRA-TWO', half],
  ] as const) {
    const r = await callApi('lucia', 'forecast/adjustments', { ...expect, label, amountCents });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  // GL3 review: the key of an exclusion is the client's (its form is checked, not that a usual
  // item has it), and the page names it.
  const left = { kind: 'exclude', accountId: 'acc-lucia', merchantKey: 'ZEBRA THREE' };
  assert.equal((await callApi('lucia', 'forecast/adjustments', left)).status, 201);
  const page = JSON.stringify((await callApi('lucia', 'dashboard')).body.forecast);
  assert.ok(page.includes('Zebra Three: left out by you'));
  for (const shown of ['ZEBRA-ONE (€98,765.43, on the', 'ZEBRA-ONE, added by you', 'ZEBRA-TWO (€'])
    assert.ok(page.includes(shown), `the page's forecast should name "${shown}"`);

  const from = openai.modelRequests.length;
  const r = await turn(
    'lucia',
    await conversation('lucia'),
    'Will I make it?',
    () => call('get_month_forecast', {}),
    () => call('get_spending_observation', {}),
  );
  const [forecast, told] = r.results;
  const account = forecast.accounts.find((x: any) => x.id === 'acc-lucia');
  assert.deepEqual(
    account.events
      .filter((e: any) => e.source === 'expected_by_you')
      .map((e: any) => [e.label, e.amountCents, e.date]),
    [['a payment you added', -9_876_543, T]],
  );
  assert.equal(
    account.explanation,
    `${account.headline}, counting a payment you added. An estimate.`,
  );
  assert.equal(account.shortfall.forLabel, 'a payment you added');
  assert.ok(
    forecast.notCounted.includes('a payment you added: already counted once, not counted twice.'),
  );
  assert.match(forecast.addedByCustomer, /can differ/);
  // The observation of the same turn: the shortfall without the customer's charges, other figure.
  assert.equal(told.observation.kind, 'month_shortfall');
  assert.notEqual(told.observation.basis, account.explanation);
  // No field of any request of the turn, and nothing recorded, holds either label.
  assert.ok(forecast.notCounted.includes('A usual payment you left out: not counted.'));
  assert.doesNotMatch(JSON.stringify(openai.modelRequests.slice(from)), /zebra/i, 'label sent');
  const stored = appDb().prepare('SELECT group_concat(data) FROM events').pluck().get() as string;
  assert.doesNotMatch(stored, /zebra/i, 'label in an event');
  // Left as the next test needs it: no adjustment, nothing told yet.
  appDb().prepare('DELETE FROM forecast_adjustments').run();
  appDb().prepare("DELETE FROM events WHERE kind='observation.told'").run();
});

test("D12, D15: the shortfall is volunteered once in the chat with the forecast's own sentence, and not with observations off", async () => {
  const BLOCK = /SPENDING OBSERVATION[^\n]*\n?.*Kind: month_shortfall/s;
  const told = () =>
    appDb().prepare("SELECT data FROM events WHERE kind='observation.told'").pluck().all();
  const ask = async () =>
    turn(
      'lucia',
      await conversation('lucia'),
      'What were my last movements?',
      () => call('list_movements', {}),
      () => call('get_spending_observation', {}),
    );
  await callApi('lucia', 'assistant-settings', { observations: false });
  const off = await ask();
  assert.ok(off.requests.every((b) => !BLOCK.test(b.instructions)));
  assert.equal(off.results[1].observation, null);
  assert.deepEqual(told(), []);

  await callApi('lucia', 'assistant-settings', { observations: true });
  const on = await ask();
  const block = on.requests[1].instructions.split('SPENDING OBSERVATION (')[1] ?? '';
  assert.match(block, /Kind: month_shortfall\.[^]*no forecast of your own/);
  assert.doesNotMatch(block, /€|\d/); // the block names the kind only
  const short = (await callApi('lucia', 'dashboard')).body.forecast.accounts.find(
    (x: any) => x.shortfall,
  );
  assert.equal(on.results[1].observation.kind, 'month_shortfall');
  assert.equal(on.results[1].observation.basis, short.explanation);
  assert.equal(told().length, 1);
  const second = await ask();
  assert.ok(second.requests.every((b) => !BLOCK.test(b.instructions)));
  assert.equal(told().length, 1);
  // GL3 review: not volunteered again, but still answered when the customer asks.
  assert.equal(second.results[1].observation.kind, 'month_shortfall');
});

test('D9: no tool of GL3 moved money, and the AI cap stops the turn before any of them runs', async () => {
  assert.deepEqual(money(), before);
  appDb()
    .prepare(
      `INSERT INTO ai_usage(created_at,actor,user_id,consumer,seq,attempt,outcome,model,host,input_tokens,output_tokens,tools,cost_nano_usd,cost_basis)
       VALUES(?,'customer','lucia','assistant',1,1,'ok','m','h',0,0,'[]',5000000000,'estimated')`,
    )
    .run(new Date().toISOString());
  const id = await conversation('lucia');
  const requests = openai.modelRequests.length + openai.embeddingInputs.length;
  const events = count('events');
  const capped = await turn('lucia', id, 'Create this goal', () => call('create_goal', {}));
  assert.equal(capped.body.code, 'ai_daily_limit');
  assert.equal(openai.modelRequests.length + openai.embeddingInputs.length, requests);
  assert.equal(count('events'), events, 'no tool ran');
  assert.deepEqual([count('goals'), money()], [2, before]);
});
