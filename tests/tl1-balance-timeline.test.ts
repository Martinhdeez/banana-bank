// TL1: the balance timeline of the Plan chart, by calendar period. One check per real risk: a
// period that does not start on its first day, an actual day drawn as projected (or the reverse),
// a current month that disagrees with the month ahead, a change of the customer's that the chart
// does not show at once, a goal paid forever or never, and another customer's account. The rules
// take `today`; the route checks use the real day. Demo bank (tests/alt-bank), DECIDER=none.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
import type { PreparedView } from '../src/banking/prepared';

const { temp } = await setupEnv('banana-tl1-');
Object.assign(process.env, {
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json', // what `npm run demo` serves
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { balanceTimeline, timelineRange, TIMELINE_RANGES } =
  await import('../src/forecast/timeline');
const { monthForecast } = await import('../src/forecast/month');
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const { bankView } = await import('../src/banking/view');
const { today, occurrence } = await import('../src/banking/prepared');
const route = await import('../app/api/[...path]/route');
seedApp();
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

// The query string stays out of the path segments, as Next.js passes them.
async function api(userId: string, path: string, query = '', body?: unknown) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await (route as any)[method](
    new Request(`http://localhost/api/${path}${query}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        cookie: `banana_actor=${sessionToken(userId)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: path.split('/') }) },
  );
  return { status: response.status, body: (await response.json()) as any };
}
const timeline = (userId: string, query: string) => api(userId, 'forecast/timeline', query);

const TODAY = '2026-10-07'; // a Wednesday
const prepared = (over: Partial<PreparedView>): PreparedView =>
  ({
    id: 'p1',
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    to: 'Bruno',
    amountCents: 2915_00,
    when: { kind: 'on_date', date: '2026-10-20' },
    state: 'scheduled',
    nextDue: '2026-10-20',
    ...over,
  }) as PreparedView;
const lucia = async () => {
  const { accounts, movements } = await bankView('lucia', { classify: 'none' });
  return { accounts: accounts as any, movements };
};

test('TL1 every period is calendar aligned: weeks Monday to Sunday, months from the 1st', () => {
  assert.deepEqual(timelineRange('this_week', TODAY), { from: '2026-10-05', to: '2026-10-11' });
  // A week that crosses a month starts on the Monday of the month before.
  assert.deepEqual(timelineRange('this_week', '2026-10-01'), {
    from: '2026-09-28',
    to: '2026-10-04',
  });
  assert.deepEqual(timelineRange('last_week', TODAY), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepEqual(timelineRange('this_month', TODAY), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(timelineRange('last_month', TODAY), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(timelineRange('last_3_months', TODAY), {
    from: '2026-08-01',
    to: '2026-10-31',
  });
  assert.deepEqual(timelineRange('next_3_months', TODAY), {
    from: '2026-10-01',
    to: '2026-12-31',
  });
  assert.equal(timelineRange('next_week', TODAY), null);
});

test("TL1 this month: one point per day, actual up to today, and the projection is the month ahead's, Lucía's €28.28 short on 20 Oct included", async () => {
  const input = { ...(await lucia()), prepared: [prepared({})], today: TODAY };
  const t = balanceTimeline({ ...input, accountId: 'acc-lucia', range: 'this_month' });
  const forecast = monthForecast(input).accounts.find((a) => a.id === 'acc-lucia')!;
  assert.equal(t.points.length, 31);
  assert.equal(t.points[0].date, '2026-10-01');
  assert.deepEqual(
    t.points.filter((p) => p.actual).map((p) => p.date),
    ['01', '02', '03', '04', '05', '06', '07'].map((d) => `2026-10-${d}`),
  );
  assert.equal(t.points[6].balanceCents, forecast.balanceCents); // today = the bank's balance
  // Every projected day ends where the month ahead says, after its last item of that day or before.
  for (const p of t.points.filter((p) => !p.actual)) {
    const last = forecast.events.filter((e) => e.date <= p.date).at(-1);
    assert.equal(p.balanceCents, last?.balanceAfterCents ?? forecast.balanceCents, p.date);
  }
  assert.deepEqual(t.shortfall, { date: '2026-10-20', shortCents: 28_28 });
  assert.deepEqual(t.lowest, forecast.lowest);
  assert.equal(t.points.at(-1)!.balanceCents, forecast.endCents);
  assert.deepEqual(
    t.months.map((m) => [m.month, m.actual]),
    [['2026-10', 'partial']],
  );
});

test("TL1 a goal's monthly payment counts as certain every month until the target, and no more; a usual charge also prepared counts once", async () => {
  const goalTransfer = prepared({
    id: 'pg',
    toAccountId: 'acc-lucia-savings',
    to: 'Personal savings',
    amountCents: 200_00,
    when: { kind: 'monthly', day: 15 },
    nextDue: '2026-10-15',
  });
  const rent = prepared({
    id: 'pr',
    to: 'Inmob Castellana',
    amountCents: 950_00,
    when: { kind: 'monthly', day: 1 },
    nextDue: '2026-11-01',
  });
  const t = balanceTimeline({
    ...(await lucia()),
    // Lucía's rent (Alquiler Inmob Castellana, €950.00 around the 1st) prepared monthly as well.
    prepared: [goalTransfer, rent],
    goals: [{ preparedId: 'pg', goalId: 'g1', name: 'Trip', remainingCents: 700_00 }],
    today: TODAY,
    accountId: 'acc-lucia',
    range: 'next_6_months',
  });
  const paid = t.events.filter((e) => e.goalId === 'g1');
  // €700 left at €200 a month: four payments, the last one completes it.
  assert.deepEqual(
    paid.map((e) => [e.date, e.amountCents, e.source, e.certainty, e.preparedId]),
    ['2026-10-15', '2026-11-15', '2026-12-15', '2027-01-15'].map((d) => [
      d,
      -200_00,
      'goal',
      'certain',
      'pg',
    ]),
  );
  assert.ok(t.events.some((e) => e.source === 'everyday' && e.date > '2026-10-31'));
  const rentOn = (date: string) =>
    t.events.filter((e) => e.date === date && e.amountCents === -950_00).map((e) => e.source);
  for (const date of ['2026-11-01', '2026-12-01', '2027-03-01'])
    assert.deepEqual(rentOn(date), ['prepared'], date);
  assert.deepEqual(
    t.months.map((m) => m.month),
    ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'],
  );
});

test('TL1 the route: default this month equal to the dashboard, an added expense shown at once, unknown range and another customer refused', async () => {
  const day = today();
  const t = await timeline('lucia', '?accountId=acc-lucia');
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.range, 'this_month');
  assert.equal(t.body.from, `${day.slice(0, 7)}-01`);
  const month = (await api('lucia', 'dashboard')).body.forecast.accounts.find(
    (a: any) => a.id === 'acc-lucia',
  );
  assert.equal(t.body.points.at(-1).balanceCents, month.endCents);
  assert.deepEqual(t.body.lowest, month.lowest);

  // An expense the customer adds for the 10th of next month moves that month's line at once.
  const date = occurrence(day, 10, 1);
  const before = await timeline('lucia', '?accountId=acc-lucia&range=next_month');
  const added = await api('lucia', 'forecast/adjustments', '', {
    accountId: 'acc-lucia',
    kind: 'expect',
    label: 'Dentist',
    amountCents: 120_00,
    repeats: 'once',
    date,
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const after_ = await timeline('lucia', '?accountId=acc-lucia&range=next_month');
  const at = (r: any) => r.body.points.find((p: any) => p.date === date).balanceCents;
  assert.equal(at(after_), at(before) - 120_00);
  assert.ok(
    after_.body.events.some(
      (e: any) => e.date === date && e.label === 'Dentist' && e.source === 'expected_by_you',
    ),
  );

  assert.equal((await timeline('lucia', '?accountId=acc-lucia&range=forever')).status, 400);
  assert.equal((await timeline('bruno', '?accountId=acc-lucia')).status, 404);
});

// TL1b: the review's findings. Each actual day ends where the day before ended plus that day's
// movements (Madrid days), today on the bank's balance: a reversed sign or a day off shows here.
test('TL1b every actual day differs from the day before by exactly its own movements', async () => {
  const input = await lucia();
  const t = balanceTimeline({
    ...input,
    prepared: [],
    today: TODAY,
    accountId: 'acc-lucia',
    range: 'last_3_months',
  });
  const bankBalance = input.accounts.find((a: any) => a.id === 'acc-lucia').balanceCents;
  const ofDay = (date: string) =>
    input.movements
      .filter((m: any) => m.accountId === 'acc-lucia' && today(new Date(m.createdAt)) === date)
      .reduce((s: number, m: any) => s + m.amountCents, 0);
  const actual = t.points.filter((p) => p.actual);
  assert.equal(actual.at(-1)!.date, TODAY);
  assert.equal(actual.at(-1)!.balanceCents, bankBalance);
  let days = 0;
  for (let k = 1; k < actual.length; k++) {
    const moved = ofDay(actual[k].date);
    if (moved) days++;
    assert.equal(actual[k].balanceCents - actual[k - 1].balanceCents, moved, actual[k].date);
  }
  assert.ok(days > 10, `only ${days} days with movements`); // the check has something to check
});

// Every month entry adds up, and one follows the other, in every range; with an item the month
// ahead dates today (a due transfer) on the last day of a month and on a Sunday, where a period
// ends today.
test('TL1b months[]: start + income - out = end in every range, also when the period ends today with an item due today', async () => {
  const input = await lucia();
  const due = prepared({ id: 'pd', amountCents: 300_00, state: 'due', nextDue: '2026-10-02' });
  for (const day of ['2026-10-31', '2026-10-11', TODAY])
    for (const range of TIMELINE_RANGES) {
      const t = balanceTimeline({
        ...input,
        prepared: [due],
        today: day,
        accountId: 'acc-lucia',
        range,
      });
      t.months.forEach((m, k) => {
        const at = `${day} ${range} ${m.month}`;
        assert.equal(m.startBalanceCents + m.incomeCents - m.outCents, m.endBalanceCents, at);
        if (k) assert.equal(m.startBalanceCents, t.months[k - 1].endBalanceCents, at);
      });
    }
  // On the 31st, this month still matches the month ahead, the due transfer in it.
  const forecast = monthForecast({ ...input, prepared: [due], today: '2026-10-31' }).accounts.find(
    (a) => a.id === 'acc-lucia',
  )!;
  const t = balanceTimeline({
    ...input,
    prepared: [due],
    today: '2026-10-31',
    accountId: 'acc-lucia',
    range: 'this_month',
  });
  assert.equal(t.points.at(-1)!.balanceCents, forecast.balanceCents); // today: the bank's
  assert.equal(t.months[0].endBalanceCents, forecast.endCents); // the month: after the transfer
  assert.ok(forecast.events.some((e) => e.preparedId === 'pd' && e.date === '2026-10-31'));
  assert.ok(forecast.endCents <= forecast.balanceCents - 300_00);
  assert.deepEqual(t.lowest, forecast.lowest);
});

test("TL1b a goal's transfer overdue by more than a month still draws every payment the target needs", async () => {
  const goalTransfer = prepared({
    id: 'pg',
    toAccountId: 'acc-lucia-savings',
    to: 'Personal savings',
    amountCents: 200_00,
    when: { kind: 'monthly', day: 15 },
    state: 'due',
    nextDue: '2026-08-15',
  });
  const t = balanceTimeline({
    ...(await lucia()),
    prepared: [goalTransfer],
    goals: [{ preparedId: 'pg', goalId: 'g1', name: 'Trip', remainingCents: 700_00 }],
    today: TODAY,
    accountId: 'acc-lucia',
    range: 'next_6_months',
  });
  // €700 left at €200: four payments, the one due now (today) and three more.
  assert.deepEqual(
    t.events.filter((e) => e.goalId === 'g1').map((e) => e.date),
    [TODAY, '2026-11-15', '2026-12-15', '2027-01-15'],
  );
});

// TL1d: the timeline's own twin rule (FC1's 15% and 5 days). The detected rent is already left
// out of the regular money when prepared (RG1c); a monthly charge the customer added is not, so
// the timeline must count it once, as the transfer, after this month. One 9 days off still counts.
test('TL1d a monthly charge the customer added and also prepared counts once in later months; one 9 days off still counts', async () => {
  const added = (id: string, label: string, day: number) => ({
    id,
    kind: 'expect' as const,
    accountId: 'acc-lucia',
    label,
    amountCents: 950_00,
    repeats: 'monthly' as const,
    day,
    createdAt: '2026-10-01T10:00:00.000Z',
  });
  const rent = prepared({
    id: 'pr',
    to: 'Inmob Castellana',
    amountCents: 950_00,
    when: { kind: 'monthly', day: 1 },
    nextDue: '2026-11-01',
  });
  const run = (adjustments: ReturnType<typeof added>[]) =>
    lucia().then((input) =>
      balanceTimeline({
        ...input,
        adjustments,
        prepared: [rent],
        today: TODAY,
        accountId: 'acc-lucia',
        range: 'next_3_months',
      }),
    );
  const without = await run([]);
  const t = await run([added('a-rent', 'Rent', 1), added('a-storage', 'Storage', 10)]);
  const of950 = (date: string) =>
    t.events.filter((e) => e.date === date && e.amountCents === -950_00).map((e) => e.source);
  for (const date of ['2026-11-01', '2026-12-01'])
    assert.deepEqual(of950(date), ['prepared'], date);
  for (const date of ['2026-11-10', '2026-12-10'])
    assert.deepEqual(of950(date), ['expected_by_you'], date);
  // Each later month is out by the rent once (the transfer) plus the storage, no more.
  for (const month of ['2026-11', '2026-12'])
    assert.equal(
      t.months.find((m) => m.month === month)!.outCents,
      without.months.find((m) => m.month === month)!.outCents + 950_00,
      month,
    );
});

// TL1c: Lucía's goal of €1,200 by 31 Mar paid on the 29th. On 28 Feb (the 29th of a short month)
// the goal, the transport card and the day's spending go out before the payroll comes in: the
// day ends above zero but dips well below it. The chart must be able to draw that dip where
// `lowest` says it is.
const goalOn29 = async () =>
  balanceTimeline({
    ...(await lucia()),
    prepared: [
      prepared({
        id: 'pg',
        toAccountId: 'acc-lucia-savings',
        to: 'Personal savings',
        amountCents: 200_00,
        when: { kind: 'monthly', day: 29 },
        nextDue: '2026-10-29',
      }),
    ],
    goals: [{ preparedId: 'pg', goalId: 'g1', name: 'Lisboa', remainingCents: 1200_00 }],
    today: TODAY,
    accountId: 'acc-lucia',
    range: 'next_6_months',
  });

test('TL1c the lowest point is on the chart: the day it names carries it, as its end or as its intra-day low', async () => {
  const t = await goalOn29();
  const low = (p: (typeof t.points)[number]) => Math.min(p.balanceCents, p.lowCents ?? Infinity);
  const day = t.points.find((p) => p.date === t.lowest!.date)!;
  assert.equal(low(day), t.lowest!.balanceCents);
  assert.ok(day.lowCents! < day.balanceCents, 'the dip is below the end of the day');
  // Nothing on the chart is lower than `lowest`, and a low equal to the day's end is not sent.
  for (const p of t.points.filter((p) => p.date >= TODAY)) {
    assert.ok(low(p) >= t.lowest!.balanceCents, p.date);
    assert.notEqual(p.lowCents, p.balanceCents, p.date);
  }
});

test("TL1c a goal's payment is named as the goal, this month and later, on both of the customer's accounts", async () => {
  const t = await goalOn29();
  const paid = t.events.filter((e) => e.preparedId === 'pg');
  assert.ok(paid.length >= 2 && paid.some((e) => e.date > '2026-10-31'));
  for (const e of paid) assert.deepEqual([e.label, e.goalId], ['Goal: Lisboa', 'g1'], e.date);
  const savings = balanceTimeline({
    ...(await lucia()),
    prepared: [
      prepared({
        id: 'pg',
        toAccountId: 'acc-lucia-savings',
        to: 'Personal savings',
        amountCents: 200_00,
        when: { kind: 'monthly', day: 29 },
        nextDue: '2026-10-29',
      }),
    ],
    goals: [{ preparedId: 'pg', goalId: 'g1', name: 'Lisboa', remainingCents: 1200_00 }],
    today: TODAY,
    accountId: 'acc-lucia-savings',
    range: 'next_3_months',
  });
  const credits = savings.events.filter((e) => e.preparedId === 'pg');
  assert.ok(credits.length >= 2);
  for (const e of credits)
    assert.deepEqual([e.label, e.amountCents], ['Goal: Lisboa', 200_00], e.date);
});
