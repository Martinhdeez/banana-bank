// RG1b: a monthly prepared transfer (a savings goal's included) is regular money. User report of
// 2026-10-07: a goal paying €666.67 on the 1st, created on the 7th, appeared nowhere in the month
// ahead, because its first payment is next month. It is now a regular charge of the account it
// leaves (and a regular income of the own account it reaches), and a line of `nextMonth`; the
// projection still stops at the month's end (FC1). Fixed dates; the route check runs on the demo
// bank (DECIDER=none).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
import type { ForecastInput } from '../src/forecast/month';
import type { PreparedView } from '../src/banking/prepared';

const { temp } = await setupEnv('banana-rg1b-');
Object.assign(process.env, {
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { monthForecast } = await import('../src/forecast/month');
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const { forecastForModel } = await import('../src/agent/forecast');
const { bankView } = await import('../src/banking/view');
const route = await import('../app/api/[...path]/route');
seedApp();
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const TODAY = '2026-10-07';
type Row = NonNullable<ForecastInput['movements']>[number];
const row = (day: string, cents: number, description: string): Row => ({
  accountId: 'acc',
  amountCents: cents,
  description,
  createdAt: `${day}T10:00:00.000Z`,
});
const monthly = (day: number, cents: number, description: string) =>
  ['07', '08', '09'].map((m) =>
    row(`2026-${m}-${String(day).padStart(2, '0')}`, cents, description),
  );
const HISTORY = [
  row('2026-07-01', 1000_00, 'Initial deposit'),
  ...monthly(2, -950_00, 'RECIBO ALQUILER INMOB'),
  row('2026-10-02', -950_00, 'RECIBO ALQUILER INMOB'),
  ...monthly(14, -10_99, 'SPOTIFY'),
];
const prepared = (over: Partial<PreparedView>): PreparedView =>
  ({
    id: 'p-goal',
    fromAccountId: 'acc',
    toAccountId: 'sav',
    to: 'Personal savings',
    amountCents: 666_67,
    when: { kind: 'monthly', day: 1 },
    state: 'scheduled',
    nextDue: '2026-11-01',
    lastSentAt: null,
    ...over,
  }) as PreparedView;
const input = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  accounts: [
    { id: 'acc', label: 'Main account', balanceCents: 2000_00 },
    { id: 'sav', label: 'Personal savings', balanceCents: 500_00 },
  ],
  movements: HISTORY,
  prepared: [],
  today: TODAY,
  ...over,
});
const GOAL = [{ preparedId: 'p-goal', goalId: 'g-carla', name: 'Pagar a Carla' }];
const accountOf = (i: ForecastInput, id: string) =>
  monthForecast(i).accounts.find((a) => a.id === id)!;
const fromPrepared = <T extends { source: string }>(items: T[]) =>
  items.filter((r) => r.source === 'prepared');

test('RG1b a goal whose first payment is next month is a regular charge "next_month" and a line of nextMonth; the projection does not move', () => {
  const without = accountOf(input(), 'acc');
  const i = input({ prepared: [prepared({})], goals: GOAL });
  const acc = accountOf(i, 'acc');
  assert.deepEqual(fromPrepared(acc.regular.charges), [
    {
      id: 'p-goal',
      label: 'Goal: Pagar a Carla',
      amountCents: -666_67,
      usualDay: 1,
      source: 'prepared',
      thisMonth: 'next_month',
      excludable: false,
      nextDue: '2026-11-01',
      goalId: 'g-carla',
    },
  ]);
  // The other leg: an income of the savings account, the same goal.
  const sav = accountOf(i, 'sav');
  assert.deepEqual(
    fromPrepared(sav.regular.income).map((r) => [r.label, r.amountCents, r.thisMonth]),
    [['Goal: Pagar a Carla', 666_67, 'next_month']],
  );
  // Early next month: the goal on 1 Nov and the usual rent on 2 Nov; Spotify (14th) is not.
  assert.deepEqual(acc.nextMonth, [
    {
      date: '2026-11-01',
      label: 'Goal: Pagar a Carla',
      amountCents: -666_67,
      preparedId: 'p-goal',
      goalId: 'g-carla',
    },
    { date: '2026-11-02', label: 'Alquiler Inmob', amountCents: -950_00 },
  ]);
  assert.deepEqual(sav.nextMonth, [
    {
      date: '2026-11-01',
      label: 'Goal: Pagar a Carla',
      amountCents: 666_67,
      preparedId: 'p-goal',
      goalId: 'g-carla',
    },
  ]);
  // FC1 semantics: nothing of next month is projected.
  assert.deepEqual(acc.events, without.events);
  assert.equal(acc.endCents, without.endCents);
  assert.equal(monthForecast(i).until, '2026-10-31');
});

test('RG1b a monthly prepared transfer due this month is "to_come" and still counted; one sent this month is "done"; a paused one is left out', () => {
  const due = prepared({
    id: 'p-due',
    to: 'Bruno',
    toAccountId: 'acc-bruno',
    state: 'due',
    nextDue: '2026-10-05',
    when: { kind: 'monthly', day: 5 },
  });
  const later = prepared({
    id: 'p-later',
    to: 'Bruno',
    toAccountId: 'acc-bruno',
    nextDue: '2026-10-20',
    when: { kind: 'monthly', day: 20 },
  });
  const sent = prepared({
    id: 'p-sent',
    to: 'Ana',
    toAccountId: 'acc-ana',
    lastSentAt: '2026-10-01T08:00:00.000Z',
  });
  const paused = prepared({
    id: 'p-paused',
    to: 'Eva',
    toAccountId: 'acc-eva',
    state: 'paused',
    nextDue: '2026-10-25',
    when: { kind: 'monthly', day: 25 },
  });
  const acc = accountOf(input({ prepared: [due, later, sent, paused] }), 'acc');
  assert.deepEqual(
    fromPrepared(acc.regular.charges).map((r) => [r.id, r.label, r.thisMonth, r.nextDue]),
    [
      ['p-sent', 'To Ana', 'done', '2026-11-01'],
      ['p-due', 'To Bruno', 'to_come', '2026-10-05'],
      ['p-later', 'To Bruno', 'to_come', '2026-10-20'],
    ],
  );
  // Still in the projection as before: a due one on today, a scheduled one on its date.
  assert.deepEqual(
    acc.events.filter((e) => e.source === 'prepared').map((e) => [e.preparedId, e.date]),
    [
      ['p-due', TODAY],
      ['p-later', '2026-10-20'],
    ],
  );
  // Early next month: the sent one's next payment (1 Nov) and the due one's (5 Nov).
  assert.deepEqual(
    acc.nextMonth.map((n) => [n.date, n.label, n.preparedId]),
    [
      ['2026-11-01', 'To Ana', 'p-sent'],
      ['2026-11-02', 'Alquiler Inmob', undefined],
      ['2026-11-05', 'To Bruno', 'p-due'],
    ],
  );
  assert.ok(!JSON.stringify(acc.regular).includes('p-paused'));
  assert.ok(!JSON.stringify(acc.nextMonth).includes('p-paused'));
});

test('RG1b a monthly transfer between own accounts: a charge "To" on the source, an income "From" on the destination', () => {
  const i = input({
    prepared: [
      prepared({ id: 'p-own', nextDue: '2026-10-25', when: { kind: 'monthly', day: 25 } }),
    ],
  });
  const acc = accountOf(i, 'acc');
  const sav = accountOf(i, 'sav');
  assert.deepEqual(
    fromPrepared(acc.regular.charges).map((r) => [r.label, r.amountCents, r.usualDay, r.thisMonth]),
    [['To Personal savings', -666_67, 25, 'to_come']],
  );
  assert.deepEqual(fromPrepared(acc.regular.income), []);
  assert.deepEqual(
    fromPrepared(sav.regular.income).map((r) => [r.label, r.amountCents, r.usualDay, r.thisMonth]),
    [['From Main account', 666_67, 25, 'to_come']],
  );
  assert.deepEqual(fromPrepared(sav.regular.charges), []);
});

test('RG1b the €28.28 scene does not change with a €666.67 goal on the 1st, and the chat reads the goal and next month', async () => {
  const { accounts, movements } = await bankView('lucia', { classify: 'none' });
  const bruno = prepared({
    id: 'p1',
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    to: 'Bruno',
    amountCents: 2915_00,
    nextDue: '2026-10-20',
    when: { kind: 'on_date', date: '2026-10-20' },
  } as Partial<PreparedView>);
  const goal = prepared({ fromAccountId: 'acc-lucia', toAccountId: 'acc-lucia-savings' });
  const of = (list: PreparedView[]) =>
    monthForecast({
      accounts: accounts as any,
      movements,
      prepared: list,
      goals: GOAL,
      today: '2026-10-06',
    });
  const before = of([bruno]).accounts.find((a) => a.id === 'acc-lucia')!;
  const f = of([bruno, goal]);
  const a = f.accounts.find((x) => x.id === 'acc-lucia')!;
  assert.equal(a.headline, '€28.28 short on 20 Oct');
  assert.deepEqual(a.events, before.events);
  assert.equal(a.explanation, before.explanation);
  assert.deepEqual(a.options, before.options);
  assert.ok(
    a.nextMonth.some((n) => n.label === 'Goal: Pagar a Carla' && n.amountCents === -666_67),
  );

  const chat = forecastForModel(f).accounts.find((x) => x.id === 'acc-lucia')!;
  assert.ok(
    chat.regular.charges.some(
      (r) =>
        r.label === 'Goal: Pagar a Carla' &&
        r.amount === '€666.67' &&
        r.thisMonth === 'next_month' &&
        r.source === 'prepared',
    ),
    JSON.stringify(chat.regular.charges),
  );
  assert.ok(
    chat.nextMonth.some(
      (n) =>
        n.label === 'Goal: Pagar a Carla' && n.amount === '-€666.67' && n.date === '2026-11-01',
    ),
    JSON.stringify(chat.nextMonth),
  );
});

test('RG1b the dashboard lists a goal created through the route as a regular charge with its name', async () => {
  const api = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await (route as any)[method](
      new Request(`http://localhost/api/${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          cookie: `banana_actor=${sessionToken('lucia')}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: path.split('/') }) },
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const created = await api('POST', 'goals', {
    name: 'Pagar a Carla',
    targetCents: 8000_00,
    targetDate: '2027-12-31',
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-lucia-savings',
    day: 1,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const goal = created.body.goal;
  const f = (await api('GET', 'dashboard')).body.forecast;
  const charge = f.accounts
    .find((a: any) => a.id === 'acc-lucia')
    .regular.charges.find((r: any) => r.source === 'prepared');
  assert.equal(charge.label, 'Goal: Pagar a Carla');
  assert.equal(charge.goalId, goal.id);
  assert.equal(charge.id, goal.prepared.id);
  assert.equal(charge.amountCents, -goal.prepared.amountCents);
  assert.equal(charge.nextDue, goal.prepared.nextDue);
  const income = f.accounts
    .find((a: any) => a.id === 'acc-lucia-savings')
    .regular.income.find((r: any) => r.source === 'prepared');
  assert.equal(income.label, 'Goal: Pagar a Carla');
});
