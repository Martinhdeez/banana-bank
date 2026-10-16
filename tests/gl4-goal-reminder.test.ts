// GL4 (user request 2026-10-07): the monthly prepared transfer of a savings goal says what it is
// for and how and when it was set up, and the goal tools give the model every amount as a euro
// string (a live model wrote "23.079 €" for €230.79 from a figure in cents). Through the real routes
// and a scripted fake of the OpenAI API, on the simulator bank. The Plan path is called with a
// fixed `now` (the store's clock seam); the chat path has none, so it is read against today in Madrid.
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
import { call, fakeOpenAI, say } from './helpers/openai';

for (const level of ['info', 'warn', 'error'] as const) console[level] = () => {};
const { temp } = await setupEnv('banana-gl4-');
process.env.OFFERS = 'off';
const openai = await fakeOpenAI(() => say('ok'));
const { seedBank } = await import('../simulator/seed');
const { setScenario } = await import('../simulator/bank');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { createGoal, adjustGoal } = await import('../src/goals/store');
const { bankView } = await import('../src/banking/view');
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

const ctx = () => ({ userId: 'lucia', conversationId: null, runId: randomUUID(), intentId: '' });
const oct7 = new Date('2026-10-07T08:00:00Z');
const rowOf = (goalId: string) =>
  appDb()
    .prepare(
      "SELECT concept, note FROM prepared_transfers WHERE goal_id=? AND status='active' ORDER BY created_at DESC, rowid DESC",
    )
    .get(goalId) as { concept: string; note: string | null };
// The goal's prepared transfer as Plan (GET /api/goals) and Transfers (the dashboard) read it.
async function cards(goalId: string) {
  const plan = (await callApi('lucia', 'goals')).body.goals.find((g: any) => g.id === goalId);
  const { prepared } = (await callApi('lucia', 'dashboard')).body;
  return [plan.prepared, prepared.find((p: any) => p.id === plan.prepared.id)];
}
const body = {
  name: 'Trip to Lisbon',
  targetCents: 120_000,
  targetDate: '2027-03-31',
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-lucia-savings',
  day: 1,
};
// Every `…Cents` number of a tool result has a `…Euros` string beside it, in the app's format.
function eurosBesideCents(value: unknown, where = 'result'): void {
  if (Array.isArray(value)) return value.forEach((v, i) => eurosBesideCents(v, `${where}[${i}]`));
  if (!value || typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(o)) {
    if (/Cents$/.test(key) && typeof v === 'number')
      assert.match(
        String(o[key.replace(/Cents$/, 'Euros')]),
        /^-?€[\d,]+\.\d{2}$/,
        `${where}.${key} has no euro string beside it`,
      );
    eurosBesideCents(v, `${where}.${key}`);
  }
}

test('a goal made in Plan: bank concept "Savings: <name>", note says what it is for and when it was set up in Plan; an adjust keeps the setup line', async () => {
  const created = await createGoal(ctx(), body, await bankView('lucia'), oct7);
  const id = created.goal.id;
  assert.deepEqual(rowOf(id), {
    concept: 'Savings: Trip to Lisbon',
    note: 'For your goal ‘Trip to Lisbon’ (€1,200.00 by 31 Mar 2027). Set up in Plan on 7 Oct 2026.',
  });
  // The Transfers list (and Plan, which reads the same view) carries the note to the card.
  for (const shown of await cards(id))
    assert.deepEqual([shown.concept, shown.note], Object.values(rowOf(id)));

  // A month later the date moves: the new transfer's note names the new date, and still the day
  // and the way it was first set up.
  const nov2 = new Date('2026-11-02T08:00:00Z');
  const view = await bankView('lucia');
  await adjustGoal(ctx(), id, { targetDate: '2027-06-30' }, view, nov2);
  assert.deepEqual(rowOf(id), {
    concept: 'Savings: Trip to Lisbon',
    note: 'For your goal ‘Trip to Lisbon’ (€1,200.00 by 30 Jun 2027). Set up in Plan on 7 Oct 2026.',
  });
  await adjustGoal(ctx(), id, { monthlyCents: 30_000 }, view, nov2);
  assert.match(rowOf(id).note!, /\(€1,200\.00 by 30 Jun 2027\)\. Set up in Plan on 7 Oct 2026\.$/);
});

test('the longest name and target still fit: the note within its 140 characters, the bank concept within 200 and without a date or "assistant"', async () => {
  const name = 'A'.repeat(60);
  const r = await createGoal(
    ctx(),
    { ...body, name, targetCents: 1_000_000_000, targetDate: '2056-09-30' },
    await bankView('lucia'),
    oct7,
    'assistant',
  );
  const { concept, note } = rowOf(r.goal.id);
  assert.equal(concept, `Savings: ${name}`);
  assert.ok(concept.length <= 200);
  assert.doesNotMatch(concept, /\d|assistant/i);
  assert.ok(note!.length <= 140, `${note!.length}: ${note}`);
  assert.match(
    note!,
    /^For your goal ‘A+…’ \(€10,000,000\.00 by 30 Sep 2056\)\. Set up with the assistant on 7 Oct 2026\.$/,
  );
});

// Today as "7 Oct 2026", worked out apart from the app's own formatter.
const madridToday = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})
  .format(new Date())
  .replace('Sept', 'Sep');

test('a goal made in the chat: the note says it was set up with the assistant; the three tools give every amount as a euro string', async () => {
  const conv = (await callApi('lucia', 'conversations', {})).body.id as string;
  const turn = async (content: string, ...script: (() => object)[]) => {
    openai.script.length = 0;
    openai.script.push(...script);
    await callApi('lucia', `conversations/${conv}/messages`, { content });
    return (openai.modelRequests.at(-1)?.input ?? [])
      .filter((i) => i.type === 'function_call_output')
      .map((i) => JSON.parse(i.output!));
  };
  const [planned] = await turn('Save €1,200 for Lisbon by March', () =>
    call('plan_goal', {
      name: 'Lisbon',
      targetCents: 120_000,
      targetDate: '2027-03-31',
      day: null,
      fromAccountId: null,
      toAccountId: null,
    }),
  );
  assert.equal(planned.status, 'ok', JSON.stringify(planned));
  assert.equal(planned.plan.targetEuros, '€1,200.00');
  eurosBesideCents(planned);

  const [created] = await turn('Create this goal', () => call('create_goal', {}));
  assert.equal(created.status, 'created', JSON.stringify(created));
  assert.equal(created.goal.targetEuros, '€1,200.00');
  eurosBesideCents(created);
  assert.deepEqual(rowOf(created.goal.id), {
    concept: 'Savings: Lisbon',
    note: `For your goal ‘Lisbon’ (€1,200.00 by 31 Mar 2027). Set up with the assistant on ${madridToday}.`,
  });

  const [listed] = await turn('How are my goals?', () => call('list_goals', {}));
  assert.equal(listed.status, 'ok');
  assert.ok(listed.goals.length >= 1);
  eurosBesideCents(listed);
});
