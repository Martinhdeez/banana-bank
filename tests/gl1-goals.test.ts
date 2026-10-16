// GL1 (plan 28, REQ-PL-12…17): savings goals. One check per real risk: money (a goal never
// sends; "saved" is only what the customer confirmed), security (owner or 404, customer only,
// strict bodies), a false figure (one fixture with a fixed day), data loss (migration 13, reset)
// and the copy rule of plan 25 D1. Simulator bank, no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { setupEnv, startSimulator } from './helpers/bank';

const { temp } = await setupEnv('banana-gl1-');
const { seedBank } = await import('../simulator/seed');
const { setScenario } = await import('../simulator/bank');
const { closeBankDb } = await import('../simulator/db');
const db = await import('../src/db');
const { appDb, closeAppDb } = db;
const { seedApp } = await import('../src/seed');
const route = await import('../app/api/[...path]/route');
const { sessionToken } = await import('../src/auth');
const { today } = await import('../src/banking/prepared');
const { operations } = await import('./helpers/data');
const plan = await import('../src/goals/plan');
seedApp();
seedBank();
const bank = await startSimulator();
setScenario('normal');
after(() => {
  bank.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

// `user` null: no session.
async function api(
  user: string | null,
  method: 'GET' | 'POST' | 'DELETE',
  route_: string,
  body?: unknown,
) {
  const response = await route[method](
    new Request(`http://localhost/api/${route_}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(user && { cookie: `banana_actor=${sessionToken(user)}` }),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve({ path: route_.split('/') }) },
  );
  return { status: response.status, body: (await response.json()) as any };
}
const count = (sql: string, ...args: unknown[]) =>
  (
    appDb()
      .prepare(`SELECT COUNT(*) n FROM ${sql}`)
      .get(...args) as { n: number }
  ).n;
// Everything a money path would leave behind: app intents and approvals, bank operations.
const money = () => ({
  intents: count('intents'),
  approvals: count('approvals'),
  bank: operations(),
});
const T = today();
const dayOfMonth = Number(T.slice(8)); // the first payment is due today
const inMonths = (n: number) => plan.occurrence(T, 28, n);
const holiday = {
  name: 'Holiday',
  targetCents: 120_000,
  targetDate: inMonths(5),
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-lucia-savings',
  day: dayOfMonth,
};
const goalOf = async (user: string, id: string) =>
  (await api(user, 'GET', 'goals')).body.goals.find((g: any) => g.id === id);
const activeRows = (id: string) =>
  count("prepared_transfers WHERE goal_id=? AND status='active'", id);
async function sendAndConfirm(user: string, preparedId: string) {
  const sent = await api(user, 'POST', `prepared/${preparedId}/send`);
  assert.equal(sent.body.status, 'requires_confirmation', JSON.stringify(sent.body));
  const done = await api(user, 'POST', `approvals/${sent.body.approval.id}/confirm`);
  assert.equal(done.body.status, 'completed', JSON.stringify(done.body));
}

test('GL1 money: a goal never sends; saved is exactly what the customer confirmed', async () => {
  const before = money();
  const start = (await api('lucia', 'GET', 'goals')).body;
  assert.equal(start.canSave, true);
  assert.equal(start.canSaveReason, null);
  assert.deepEqual(
    start.accounts.map((a: any) => a.id),
    ['acc-lucia', 'acc-lucia-savings'],
  );
  assert.deepEqual(start.goals, []);

  // REQ-PL-17: the dry run answers the plan and writes nothing.
  const { targetCents, targetDate, day } = holiday;
  const dry = await api('lucia', 'POST', 'goals/plan', { targetCents, targetDate, day });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.firstDue, T);
  assert.equal(dry.body.monthlyCents, Math.ceil(120_000 / dry.body.payments));
  assert.equal(count('goals') + count('prepared_transfers'), 0);

  // REQ-PL-13: create writes the goal and one monthly prepared transfer, as the dry run said.
  const created = await api('lucia', 'POST', 'goals', holiday);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.status, 'created');
  const { id } = created.body.goal;
  let goal = created.body.goal;
  assert.deepEqual(goal.prepared.when, { kind: 'monthly', day });
  assert.equal(goal.prepared.amountCents, dry.body.monthlyCents);
  assert.equal(goal.prepared.nextDue, dry.body.firstDue);
  assert.deepEqual(
    [goal.from, goal.to],
    [
      { id: 'acc-lucia', label: 'Aurora account' },
      { id: 'acc-lucia-savings', label: 'Personal savings' },
    ],
  );
  assert.equal(goal.savedCents, 0);
  assert.equal(activeRows(id), 1);
  // A request body cannot attach an ordinary prepared transfer to a goal.
  await api('lucia', 'POST', 'prepared', {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-lucia-savings',
    amountCents: 999,
    concept: 'Not the goal',
    when: 'manual',
    goalId: id,
    goal_id: id,
  });
  assert.equal(activeRows(id), 1);

  // Adjust replaces the transfer: still one, still nothing sent.
  const adjusted = await api('lucia', 'POST', `goals/${id}/adjust`, { monthlyCents: 15_000 });
  assert.equal(adjusted.body.status, 'adjusted', JSON.stringify(adjusted.body));
  goal = adjusted.body.goal;
  assert.equal(goal.monthlyCents, 15_000);
  assert.equal(goal.state, 'behind');
  assert.equal(activeRows(id), 1);
  assert.equal(count('prepared_transfers WHERE goal_id=?', id), 2);
  assert.deepEqual(money(), before, 'create and adjust left no intent, approval or bank write');

  // Send alone is a proposal: nothing is saved, and the goal cannot be adjusted under it.
  const sent = await api('lucia', 'POST', `prepared/${goal.prepared.id}/send`);
  assert.equal(sent.body.status, 'requires_confirmation');
  assert.equal((await goalOf('lucia', id)).savedCents, 0, 'an unconfirmed send saves nothing');
  const busy = await api('lucia', 'POST', `goals/${id}/adjust`, { monthlyCents: 20_000 });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'prepared_in_progress');
  assert.equal(activeRows(id), 1);
  assert.equal(operations(), before.bank);
  // The confirmation is the only thing that moves money, and saved rises by exactly that.
  await api('lucia', 'POST', `approvals/${sent.body.approval.id}/confirm`);
  assert.equal(operations(), before.bank + 1);
  goal = await goalOf('lucia', id);
  assert.equal(goal.savedCents, 15_000);
  assert.equal(goal.remainingCents, 105_000);
  assert.deepEqual(goal.history.at(-1), {
    month: T.slice(0, 7),
    plannedCents: 15_000,
    savedCents: 15_000,
  });

  // The what-if of this goal (dry run with `goalId`): this month is paid, so it starts next month.
  const whatIf = { targetCents: 105_000, targetDate, day, goalId: id };
  assert.equal(
    (await api('lucia', 'POST', 'goals/plan', whatIf)).body.firstDue,
    plan.occurrence(T, dayOfMonth, 1),
  );
  assert.equal((await api('carla', 'POST', 'goals/plan', whatIf)).status, 404);

  // REQ-PL-15: the transfer deleted in Transfers → no_plan, and what was saved is kept.
  assert.equal((await api('lucia', 'DELETE', `prepared/${goal.prepared.id}`)).status, 200);
  goal = await goalOf('lucia', id);
  assert.equal(goal.state, 'no_plan');
  assert.equal(goal.prepared, null);
  assert.equal(goal.monthlyCents, null);
  assert.equal(goal.savedCents, 15_000);
  assert.equal(goal.suggestion.kind, 'prepare_again');
  assert.equal(goal.to.id, 'acc-lucia-savings');

  // The suggestion applied; then the rest confirmed in one payment: reached, on that day.
  const again = await api('lucia', 'POST', `goals/${id}/adjust`, { monthlyCents: 105_000 });
  assert.equal(again.body.goal.requiredMonthlyCents <= 105_000, true);
  // This month is already paid: the new transfer starts next month, and the month's plan in
  // the history stays what was paid.
  assert.equal(again.body.goal.prepared.nextDue, plan.occurrence(T, dayOfMonth, 1));
  assert.equal(again.body.goal.history.at(-1).plannedCents, 15_000);
  await sendAndConfirm('lucia', again.body.goal.prepared.id);
  goal = await goalOf('lucia', id);
  assert.equal(goal.state, 'reached');
  assert.equal(goal.savedCents, 120_000);
  assert.equal(goal.reachedAt, T);
  assert.match(goal.headline, /^Reached on \d{1,2} [A-Z][a-z]{2}$/);
  assert.equal(operations(), before.bank + 2);

  // Deleting the goal deletes its transfer and undoes nothing.
  assert.deepEqual((await api('lucia', 'DELETE', `goals/${id}`)).body, { status: 'deleted' });
  assert.equal(activeRows(id), 0);
  assert.deepEqual((await api('lucia', 'GET', 'goals')).body.goals, []);
  assert.deepEqual(money(), {
    intents: before.intents + 2,
    approvals: before.approvals + 2,
    bank: before.bank + 2,
  });
});

test('GL1 security: owner or 404, customer only, strict bodies, one account cannot save', async () => {
  const { id } = (await api('lucia', 'POST', 'goals', holiday)).body.goal;
  const calls: [method: 'GET' | 'POST' | 'DELETE', route: string, body?: object][] = [
    ['GET', 'goals'],
    ['POST', 'goals/plan', { targetCents: 1000, targetDate: inMonths(3), day: 1 }],
    ['POST', 'goals', holiday],
    ['POST', `goals/${id}/adjust`, { monthlyCents: 100 }],
    ['DELETE', `goals/${id}`],
  ];
  for (const [method, route_, body] of calls) {
    assert.equal((await api(null, method, route_, body)).status, 401, `signed out ${route_}`);
    assert.equal((await api('marta', method, route_, body)).status, 403, `operator ${route_}`);
  }
  // Another customer: the goal is not in their list and its id is not found.
  const carla = (await api('carla', 'GET', 'goals')).body;
  assert.deepEqual(carla.goals, []);
  for (const [method, route_, body] of calls.slice(3))
    assert.equal((await api('carla', method, route_, body)).status, 404, `other ${route_}`);
  assert.equal((await goalOf('lucia', id)).monthlyCents > 100, true, 'untouched');
  // One account (Bruno): the reason, and no create path.
  const bruno = (await api('bruno', 'GET', 'goals')).body;
  assert.equal(bruno.canSave, false);
  assert.equal(bruno.canSaveReason, plan.CAN_SAVE_REASON);
  const refused = await api('bruno', 'POST', 'goals', {
    ...holiday,
    fromAccountId: 'acc-bruno',
    toAccountId: 'acc-lucia-savings',
  });
  assert.equal(refused.status, 409);
  // A goal moves money between the customer's own accounts only.
  const outside = await api('lucia', 'POST', 'goals', { ...holiday, toAccountId: 'acc-bruno' });
  assert.equal(outside.status, 400);
  const bad: [string, object][] = [
    ['goals', { ...holiday, extra: 1 }],
    ['goals', { ...holiday, targetCents: 12.5 }],
    ['goals', { ...holiday, targetDate: T }],
    ['goals', { ...holiday, targetDate: '2027-02-30' }],
    ['goals', { ...holiday, name: ' ' }],
    ['goals', { ...holiday, toAccountId: holiday.fromAccountId }],
    ['goals/plan', { targetCents: 1000, targetDate: inMonths(3), day: 32 }],
    ['goals/plan', { targetCents: 1000, targetDate: inMonths(3), day: 1, name: 'x' }],
    [`goals/${id}/adjust`, { monthlyCents: 100, targetDate: inMonths(9) }],
    [`goals/${id}/adjust`, {}],
    [`goals/${id}/adjust`, { monthlyCents: 0 }],
  ];
  for (const [route_, body] of bad)
    assert.equal((await api('lucia', 'POST', route_, body)).status, 400, JSON.stringify(body));
  assert.equal(count('goals'), 2, 'the first test left one (deleted), this one made one');
  assert.equal(count("prepared_transfers WHERE goal_id=? AND status='active'", id), 1);
});

// REQ-PL-15, REQ-PL-16: one goal, €1,200.00 by 31 Mar 2027, the 10th of each month, read on
// fixed days. Every sentence is §6.1's with its figures.
test('GL1 figures: one fixture with fixed days, every state and its sentence', () => {
  const goal = {
    targetCents: 120_000,
    targetDate: '2027-03-31',
    last: { amountCents: 20_000, day: 10 },
  };
  const monthly = (nextDue: string, state = 'scheduled' as const) => ({
    amountCents: 20_000,
    nextDue,
    state,
  });
  const texts: string[] = [plan.CAN_SAVE_REASON];
  const read = (f: Omit<Parameters<typeof plan.goalFigures>[0], keyof typeof goal>) => {
    const g = plan.goalFigures({ ...goal, ...f });
    texts.push(g.headline, g.basis, g.suggestion?.text ?? '', g.alternative?.text ?? '');
    return g;
  };
  // The plan: 10 Oct … 10 Mar is six payments of €200.00.
  assert.deepEqual(plan.planFor(120_000, plan.firstDue('2026-10-07', 10), 10, '2027-03-31'), {
    monthlyCents: 20_000,
    payments: 6,
    firstDue: '2026-10-10',
    lastDue: '2027-03-10',
  });
  assert.equal(plan.planFor(100_000, '2027-01-10', 10, '2027-03-31').monthlyCents, 33_334, 'ceil');
  assert.equal(plan.planFor(5_000, '2026-10-31', 31, '2026-10-01').payments, 1, 'at least one');
  assert.equal(plan.occurrence('2027-01-31', 31, 1), '2027-02-28', 'the 31st in February');

  assert.deepEqual(read({ savedCents: 0, prepared: monthly('2026-10-10'), today: '2026-10-07' }), {
    state: 'on_track',
    remainingCents: 120_000,
    behindCents: 0,
    monthlyCents: 20_000,
    requiredMonthlyCents: 20_000,
    headline: 'On plan',
    basis: '€0.00 of €1,200.00 saved. €200.00 a month, 6 payments left, the last on 10 Mar 2027.',
    suggestion: null,
    alternative: null,
  });
  // One payment confirmed, two skipped: three left of €200.00 reach €800.00.
  const behind = read({ savedCents: 20_000, prepared: monthly('2027-01-10'), today: '2026-12-15' });
  assert.deepEqual(behind, {
    state: 'behind',
    remainingCents: 100_000,
    behindCents: 40_000,
    monthlyCents: 20_000,
    requiredMonthlyCents: 33_334,
    headline: '€400.00 behind plan',
    basis:
      '€200.00 of €1,200.00 saved. At €200.00 a month you reach €800.00 by 31 Mar 2027, €400.00 short.',
    suggestion: {
      kind: 'raise',
      monthlyCents: 33_334,
      text: '€333.34 a month reaches €1,200.00 by 31 Mar 2027.',
    },
    alternative: {
      kind: 'extend',
      targetDate: '2027-05-10',
      text: '€200.00 a month reaches €1,200.00 by 10 May 2027.',
    },
  });
  // {projected}: target − behind = saved + monthly × payments left.
  assert.equal(120_000 - behind.behindCents, 20_000 + 20_000 * 3);
  // The extend button does what its text says: the new date keeps €200.00 a month.
  const later = plan.planFor(100_000, '2027-01-10', 10, '2027-05-10');
  assert.equal(plan.monthlyForDate(100_000, later, 20_000), 20_000);
  assert.equal(
    plan.monthlyForDate(100_000, plan.planFor(100_000, '2027-01-10', 10, '2027-02-28'), 20_000),
    50_000,
  );

  const waiting = read({
    savedCents: 0,
    prepared: monthly('2026-10-10', 'due' as any),
    today: '2026-10-12',
  });
  assert.deepEqual(
    [waiting.state, waiting.behindCents, waiting.headline, waiting.basis, waiting.suggestion],
    [
      'behind',
      0,
      'A payment is waiting',
      '€0.00 of €1,200.00 saved. The payment of 10 Oct is waiting for your confirmation.',
      null,
    ],
  );
  // Due today is on plan, not waiting.
  assert.equal(
    read({ savedCents: 0, prepared: monthly('2026-10-10', 'due' as any), today: '2026-10-10' })
      .state,
    'on_track',
  );
  const noPlan = read({ savedCents: 20_000, prepared: null, today: '2026-12-15' });
  assert.deepEqual(
    [noPlan.state, noPlan.monthlyCents, noPlan.requiredMonthlyCents, noPlan.headline, noPlan.basis],
    [
      'no_plan',
      null,
      33_334,
      'No monthly transfer',
      '€200.00 of €1,200.00 saved. No monthly transfer is set up for this goal, so nothing more is added.',
    ],
  );
  assert.deepEqual(noPlan.suggestion, {
    kind: 'prepare_again',
    monthlyCents: 33_334,
    text: 'A monthly transfer of €333.34 reaches €1,200.00 by 31 Mar 2027.',
  });
  assert.equal(
    read({ savedCents: 0, prepared: monthly('2026-10-10', 'paused' as any), today: '2026-10-07' })
      .state,
    'no_plan',
  );
  const passed = read({ savedCents: 80_000, prepared: monthly('2027-04-10'), today: '2027-04-02' });
  assert.deepEqual(
    [passed.state, passed.headline, passed.basis, passed.suggestion, passed.alternative],
    [
      'date_passed',
      'The date has passed',
      '€800.00 of €1,200.00 saved by 31 Mar. €400.00 remains.',
      {
        kind: 'extend',
        targetDate: '2027-05-10',
        text: '€200.00 a month reaches €1,200.00 by 10 May.',
      },
      null,
    ],
  );
  const reached = read({
    savedCents: 120_000,
    reachedAt: '2027-03-10',
    prepared: null,
    today: '2027-04-02',
  });
  assert.deepEqual(
    [reached.state, reached.remainingCents, reached.headline, reached.basis, reached.suggestion],
    ['reached', 0, 'Reached on 10 Mar', '€1,200.00 saved, with the transfers you confirmed.', null],
  );
  // Review: while the reached goal's transfer exists, the text says so.
  assert.equal(
    read({
      savedCents: 120_000,
      reachedAt: '2027-03-10',
      prepared: monthly('2027-04-10'),
      today: '2027-04-02',
    }).basis,
    '€1,200.00 saved, with the transfers you confirmed. Its monthly transfer of €200.00 is still in Transfers and stays there until you delete it.',
  );
  // Review: no occurrence left on or before the date (March skipped) is behind by all that
  // remains, never "On plan"; no raise can reach the date, the later date is offered.
  const late = read({
    savedCents: 100_000,
    prepared: monthly('2027-04-10'),
    last: { amountCents: 20_000, day: 10, paidThrough: '2027-02-10' },
    today: '2027-03-12',
  } as Parameters<typeof read>[0]);
  assert.deepEqual(
    [late.state, late.behindCents, late.basis, late.suggestion, late.alternative],
    [
      'behind',
      20_000,
      '€1,000.00 of €1,200.00 saved. At €200.00 a month you reach €1,000.00 by 31 Mar, €200.00 short.',
      null,
      {
        kind: 'extend',
        targetDate: '2027-04-10',
        text: '€200.00 a month reaches €1,200.00 by 10 Apr.',
      },
    ],
  );
  // Review: a monthly amount that would need more than 30 years offers no later date (it threw).
  const cent = plan.goalFigures({
    ...goal,
    targetCents: 1_000_000_000,
    savedCents: 0,
    prepared: { amountCents: 1, nextDue: '2026-10-10', state: 'scheduled' },
    last: { amountCents: 1, day: 10 },
    today: '2026-10-07',
  });
  assert.deepEqual([cent.state, cent.alternative], ['behind', null]);
  // History: October paid; November skipped; the transfer replaced on 20 Dec by one of €250.00
  // (the old one's December occurrence, the 10th, had fallen due; the new one starts in January).
  const history = (rows: Parameters<typeof plan.goalHistory>[3], today = '2027-01-05') =>
    plan.goalHistory('2026-10', today, [{ day: '2026-10-10', amountCents: 20_000 }], rows);
  const first = { amountCents: 20_000, day: 10, firstDue: '2026-10-10', paid: ['2026-10-10'] };
  assert.deepEqual(
    history([
      { ...first, deletedDay: '2026-12-20', skipped: ['2026-11-10'] },
      { amountCents: 25_000, day: 10, firstDue: '2027-01-10', skipped: [], paid: [] },
    ]),
    [
      { month: '2026-10', plannedCents: 20_000, savedCents: 20_000 },
      { month: '2026-11', plannedCents: 0, savedCents: 0 },
      { month: '2026-12', plannedCents: 20_000, savedCents: 0 },
      { month: '2027-01', plannedCents: 25_000, savedCents: 0 },
    ],
  );
  // Paid and replaced on the same day: October stays planned once, at what was paid; the new
  // transfer starts in November (nextStart), not on the day already paid.
  assert.equal(plan.nextStart('2026-10-10', 10, '2026-10-10'), '2026-11-10');
  assert.equal(plan.nextStart('2026-10-10', 10), '2026-10-10');
  assert.deepEqual(
    history(
      [
        { ...first, deletedDay: '2026-10-10', skipped: [] },
        { amountCents: 15_000, day: 10, firstDue: '2026-11-10', skipped: [], paid: [] },
      ],
      '2026-11-02',
    ),
    [
      { month: '2026-10', plannedCents: 20_000, savedCents: 20_000 },
      { month: '2026-11', plannedCents: 15_000, savedCents: 0 },
    ],
  );
  // Plan 25 D1: a prepared transfer is never "automatic" or "scheduled".
  for (const t of texts) assert.doesNotMatch(t, /automatic|scheduled/i);
  assert.equal(texts.filter(Boolean).length > 15, true);
});

// Last: these replace the database file.
test('GL1 data: a reseed clears goals; migration 13 applies on a version-12 database', () => {
  assert.equal(count('goals') > 0, true);
  seedApp();
  assert.equal(count('goals') + count('prepared_transfers'), 0);
  closeAppDb();
  for (const f of fs.readdirSync(temp))
    if (f.startsWith('app.sqlite')) fs.rmSync(path.join(temp, f));
  // What the code before GL1 leaves on disk: migrations 1–12 applied and recorded, with a row.
  const old = new Database(path.join(temp, 'app.sqlite'));
  old.exec(
    'CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)',
  );
  db.migrations.slice(0, 12).forEach((m, i) => {
    m.up(old);
    old.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(i + 1, m.name, 'then');
  });
  old.exec(
    "INSERT INTO prepared_transfers(id,user_id,from_account_id,to_account_id,to_name,amount_cents,concept,kind,created_at) VALUES('p1','lucia','acc-lucia','acc-carla','Carla',1250,'Rent','manual','2026-10-01T00:00:00.000Z')",
  );
  old.close();
  assert.equal(db.migrations[12].name, 'gl1-goals');
  assert.deepEqual(
    // FC2: a later migration (14) exists; this test is about 12 → 13.
    appDb().prepare('SELECT version,name FROM schema_migrations WHERE version IN (12,13)').all(),
    [
      { version: 12, name: 'tr1-ai-usage' },
      { version: 13, name: 'gl1-goals' },
    ],
  );
  assert.deepEqual(
    appDb().prepare('SELECT id,amount_cents,goal_id FROM prepared_transfers').all(),
    [{ id: 'p1', amount_cents: 1250, goal_id: null }],
  );
  assert.equal(count('goals'), 0);
});
