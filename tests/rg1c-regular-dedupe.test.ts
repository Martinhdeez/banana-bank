// RG1c: a usual charge the customer has also prepared as a transfer is listed once, as the
// prepared item, in `regular` and in `nextMonth` (FC1's twin rule, the one the projection uses:
// same account, within 15% and 5 days). Plus the RG1b review's untested points: an added item's
// label never reaches the model through `nextMonth`, the 7-day window of `nextMonth`, and a
// one-off prepared transfer early next month. Pure, fixed dates.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv } from './helpers/bank';
import type { ForecastInput } from '../src/forecast/month';
import type { PreparedView } from '../src/banking/prepared';

const { temp } = await setupEnv('banana-rg1c-');
const { monthForecast } = await import('../src/forecast/month');
const { forecastForModel } = await import('../src/agent/forecast');
const { regularTotal, fromNextMonth } = await import('../app/_components/plan/logic');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

type Row = NonNullable<ForecastInput['movements']>[number];
const row = (day: string, cents: number, description: string): Row => ({
  accountId: 'acc',
  amountCents: cents,
  description,
  createdAt: `${day}T10:00:00.000Z`,
});
const monthly = (day: number, cents: number, description: string, months = ['07', '08', '09']) =>
  months.map((m) => row(`2026-${m}-${String(day).padStart(2, '0')}`, cents, description));
const input = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  accounts: [{ id: 'acc', label: 'Main account', balanceCents: 2000_00 }],
  movements: [
    row('2026-06-30', 3000_00, 'Initial deposit'),
    ...monthly(1, -950_00, 'RECIBO ALQUILER INMOB CASTELLANA', ['07', '08', '09', '10']),
  ],
  prepared: [],
  today: '2026-10-07',
  ...over,
});
const prepared = (over: Partial<PreparedView>): PreparedView =>
  ({
    id: 'p-rent',
    fromAccountId: 'acc',
    toAccountId: 'acc-inmob',
    to: 'Inmob Castellana',
    amountCents: 950_00,
    when: { kind: 'monthly', day: 1 },
    state: 'scheduled',
    nextDue: '2026-11-01',
    lastSentAt: null,
    ...over,
  }) as PreparedView;
const acc = (i: ForecastInput) => monthForecast(i).accounts[0];

test('RG1c rent prepared as a monthly transfer is listed once, as the prepared item, in regular and nextMonth; the projection does not move', () => {
  const without = acc(input());
  const a = acc(input({ prepared: [prepared({})] }));
  assert.deepEqual(
    a.regular.charges.map((r) => [r.label, r.amountCents, r.source]),
    [['To Inmob Castellana', -950_00, 'prepared']],
  );
  assert.deepEqual(a.nextMonth, [
    {
      date: '2026-11-01',
      label: 'To Inmob Castellana',
      amountCents: -950_00,
      preparedId: 'p-rent',
    },
  ]);
  assert.deepEqual(a.events, without.events);
  assert.equal(a.endCents, without.endCents);
  // A one-off prepared on 2 Nov, within 5 days and 15%, is the same rent in nextMonth too.
  const once = acc(
    input({
      prepared: [
        prepared({
          id: 'p-once',
          amountCents: 900_00,
          when: { kind: 'on_date', date: '2026-11-02' },
          nextDue: '2026-11-02',
        } as Partial<PreparedView>),
      ],
    }),
  );
  assert.deepEqual(
    once.nextMonth.map((n) => [n.date, n.amountCents, n.preparedId]),
    [['2026-11-02', -900_00, 'p-once']],
  );
});

test("RG1c an added item's own label never reaches the model through nextMonth", () => {
  const f = monthForecast(
    input({
      adjustments: [
        {
          id: 'adj-1',
          kind: 'expect',
          accountId: 'acc',
          label: 'Clases de piano de Marta',
          amountCents: 40_00,
          repeats: 'monthly',
          day: 3,
          createdAt: '2026-10-01T10:00:00.000Z',
        },
      ],
    }),
  );
  assert.ok(f.accounts[0].nextMonth.some((n) => n.label === 'Clases de piano de Marta'));
  const model = forecastForModel(f);
  assert.ok(!JSON.stringify(model).includes('piano'));
  assert.ok(model.accounts[0].nextMonth.some((n) => n.date === '2026-11-03'));
});

test('RG1c nextMonth covers days 1 to 7 of next month: day 7 is in, day 8 is out', () => {
  const a = acc(
    input({
      movements: [
        ...input().movements!,
        ...monthly(7, -30_00, 'GIMNASIO SIETE'),
        ...monthly(8, -45_00, 'SEGURO OCHO'),
      ],
    }),
  );
  const dates = a.nextMonth.map((n) => n.date);
  assert.ok(dates.includes('2026-11-07'));
  assert.ok(!dates.includes('2026-11-08'));
  assert.ok(
    a.regular.charges.some((r) => r.usualDay === 8),
    'day 8 is a regular charge',
  );
});

test('RG1c a one-off prepared transfer dated in the first week of next month is in nextMonth', () => {
  const a = acc(
    input({
      prepared: [
        prepared({
          id: 'p-bruno',
          to: 'Bruno',
          toAccountId: 'acc-bruno',
          amountCents: 120_00,
          when: { kind: 'on_date', date: '2026-11-04' },
          nextDue: '2026-11-04',
        } as Partial<PreparedView>),
      ],
    }),
  );
  assert.ok(
    a.nextMonth.some(
      (n) =>
        n.date === '2026-11-04' &&
        n.label === 'To Bruno' &&
        n.amountCents === -120_00 &&
        n.preparedId === 'p-bruno',
    ),
  );
});

test("RG1c the kept prepared twin takes the dropped charge's this-month state: rent paid on the 1st, prepared from 1 Nov, is Done and in the monthly total", () => {
  const without = acc(input());
  const a = acc(input({ prepared: [prepared({})] }));
  assert.equal(without.regular.charges[0].thisMonth, 'done');
  assert.deepEqual(
    a.regular.charges.map((r) => [r.source, r.thisMonth]),
    [['prepared', 'done']],
  );
  assert.equal(regularTotal(a.regular.charges), regularTotal(without.regular.charges));
  assert.equal(regularTotal(a.regular.charges), -950_00);
  assert.equal(fromNextMonth(a.regular.charges), 0);
  // Without a twin this month the prepared item still starts next month.
  const alone = acc(
    input({ movements: [row('2026-06-30', 3000_00, 'Initial deposit')], prepared: [prepared({})] }),
  );
  assert.equal(alone.regular.charges[0].thisMonth, 'next_month');
});

test('RG1c the twin rule ends at 5 days: a prepared payment 6 days from the usual charge is not its twin', () => {
  const on = (day: number) =>
    acc(
      input({
        prepared: [
          prepared({
            when: { kind: 'monthly', day },
            nextDue: `2026-11-0${day}`,
          } as Partial<PreparedView>),
        ],
      }),
    ).regular.charges.length;
  assert.equal(on(6), 1);
  assert.equal(on(7), 2);
});

test('RG1c a prepared payment still to come this month stays to_come, even when its twin was already paid', () => {
  // Rent paid by hand on 1 Oct; a monthly transfer prepared on day 3, first payment 3 Oct, not sent.
  const f = monthForecast(
    input({
      prepared: [
        prepared({
          when: { kind: 'monthly', day: 3 },
          nextDue: '2026-10-03',
        } as Partial<PreparedView>),
      ],
    }),
  );
  const a = f.accounts[0];
  assert.ok(a.events.some((e) => e.date === '2026-10-03' && e.amountCents === -950_00));
  assert.deepEqual(
    a.regular.charges.map((r) => [r.source, r.thisMonth]),
    [['prepared', 'to_come']],
  );
  assert.equal(forecastForModel(f).accounts[0].regular.charges[0].thisMonth, 'to_come');
});

// RG1d: a monthly charge the customer added that is the twin of a monthly prepared transfer
// (15% and 5 days) is listed once, as the prepared item; one 9 days off is a charge of its own.
const added = (id: string, label: string, day: number, direction?: 'income') => ({
  id,
  kind: 'expect' as const,
  accountId: 'acc',
  label,
  amountCents: 950_00,
  repeats: 'monthly' as const,
  day,
  ...(direction && { direction }),
  createdAt: '2026-10-01T10:00:00.000Z',
});
const twinSetup = input({
  prepared: [prepared({})],
  adjustments: [added('adj-rent', 'Rent', 1), added('adj-storage', 'Storage', 10)],
});

test('RG1d an added monthly charge twin of a prepared transfer is listed once in regular and nextMonth; one 9 days off is kept; the projection does not move', () => {
  const plain = acc(
    input({ prepared: [prepared({})], adjustments: [added('adj-storage', 'Storage', 10)] }),
  );
  const a = acc(twinSetup);
  assert.deepEqual(
    a.regular.charges.map((r) => [r.label, r.amountCents, r.source]),
    [
      ['To Inmob Castellana', -950_00, 'prepared'],
      ['Storage', -950_00, 'added_by_you'],
    ],
  );
  assert.equal(regularTotal(a.regular.charges), -1900_00);
  assert.deepEqual(
    a.nextMonth.map((n) => [n.date, n.amountCents, n.preparedId ?? n.adjustmentId]),
    [['2026-11-01', -950_00, 'p-rent']],
  );
  assert.deepEqual(a.events, plain.events);
  assert.equal(a.endCents, plain.endCents);
});

test("RG1d the timeline's monthly basis counts an added twin of a prepared transfer once", async () => {
  const { balanceTimeline } = await import('../src/forecast/timeline');
  const t = balanceTimeline({ ...twinSetup, goals: [], accountId: 'acc', range: 'next_3_months' });
  // The prepared rent (€950) and Storage (€950); the added "Rent" is the prepared rent.
  assert.equal(t.basis.regularChargesMonthlyCents, 1900_00);
});

test("RG1d the prepared item takes an added twin's state: no detected rent, an added Rent paid on 1 Oct makes a prepared rent from 1 Nov 'done', one still to come this month stays 'to_come'", () => {
  const base = {
    movements: [
      row('2026-06-30', 3000_00, 'Initial deposit'),
      row('2026-10-01', -950_00, 'TRANSFERENCIA ALQUILER OCTUBRE'),
    ],
    adjustments: [added('adj-rent', 'Rent', 1)],
  };
  const state = (p: Partial<PreparedView>) =>
    acc(input({ ...base, prepared: [prepared(p)] })).regular.charges.map((r) => [
      r.source,
      r.thisMonth,
    ]);
  assert.deepEqual(state({}), [['prepared', 'done']]);
  assert.deepEqual(
    state({ when: { kind: 'monthly', day: 3 }, nextDue: '2026-10-03' } as Partial<PreparedView>),
    [['prepared', 'to_come']],
  );
});

// RG1e: a monthly charge the customer added that is the twin of a detected usual charge (no
// prepared transfer) is that charge. The list follows the projection: listed once, as the
// detected item, unless the projection counts the added one on its own this month.
const rentOn = (day: number, months: string[]) =>
  monthly(day, -950_00, 'RECIBO ALQUILER INMOB CASTELLANA', months);
test('RG1e an added Rent twin of the detected rent, paid this month, is listed once as the detected item in regular and nextMonth, as the projection counts it once', () => {
  const a = acc(input({ adjustments: [added('adj-rent', 'Rent', 1)] }));
  assert.deepEqual(a.events, []);
  assert.deepEqual(
    a.regular.charges.map((r) => [r.label, r.source, r.thisMonth]),
    [['Alquiler Inmob Castellana', 'detected', 'done']],
  );
  assert.deepEqual(
    a.nextMonth.map((n) => [n.date, n.amountCents, n.adjustmentId ?? null]),
    [['2026-11-01', -950_00, null]],
  );
  // Paid on the 3rd, added on the 8th: FC2 lists it as already seen, the list once.
  const later = acc(
    input({
      movements: [
        row('2026-06-30', 3000_00, 'Initial deposit'),
        ...rentOn(3, ['07', '08', '09', '10']),
      ],
      adjustments: [added('adj-rent', 'Rent', 8)],
    }),
  );
  assert.deepEqual(
    later.regular.charges.map((r) => r.source),
    ['detected'],
  );
});

// RG1f: an added charge that is the twin of a detected usual charge still to come this month is
// that charge: the projection counts it once, lists the added one under notCounted, and the list
// and the timeline follow. A charge 10 days off (Storage) is its own and still counted.
const toCome = (adjustments: ForecastInput['adjustments']) =>
  input({
    movements: [row('2026-06-30', 3000_00, 'Initial deposit'), ...rentOn(20, ['07', '08', '09'])],
    adjustments,
  });
test('RG1f an added Rent twin of the detected rent still to come is counted once, in notCounted as usual_like_it; Storage 10 days off is still counted', () => {
  const plain = monthForecast(toCome([]));
  const f = monthForecast(
    toCome([added('adj-rent', 'Rent', 20), added('adj-storage', 'Storage', 10)]),
  );
  const a = f.accounts[0];
  assert.deepEqual(
    a.events.map((e) => [e.date, e.source, e.amountCents]),
    [
      ['2026-10-10', 'expected_by_you', -950_00],
      ['2026-10-20', 'usual_charge', -950_00],
    ],
  );
  assert.equal(a.endCents, plain.accounts[0].endCents - 950_00);
  assert.deepEqual(
    f.notCounted.map((n) => [n.reason, n.adjustmentId, n.text]),
    [
      [
        'usual_like_it',
        'adj-rent',
        'Rent (€950.00, added by you): a usual charge like it is already counted, not counted twice.',
      ],
    ],
  );
  assert.deepEqual(
    a.regular.charges.map((r) => [r.label, r.source]),
    [
      ['Storage', 'added_by_you'],
      ['Alquiler Inmob Castellana', 'detected'],
    ],
  );
  assert.deepEqual(f.adjustments.find((x) => x.id === 'adj-rent')?.countedWith, {
    label: 'Alquiler Inmob Castellana',
    source: 'detected',
  });
  // The twin rule is per account: a Rent added on another account is that account's own charge.
  const other = monthForecast({
    ...toCome([{ ...added('adj-rent', 'Rent', 20), accountId: 'acc2' }]),
    accounts: [
      { id: 'acc', label: 'Main account', balanceCents: 2000_00 },
      { id: 'acc2', label: 'Second account', balanceCents: 2000_00 },
    ],
  });
  assert.deepEqual(
    other.accounts[1].events.map((e) => e.source),
    ['expected_by_you'],
  );
  // Late detected rent (usually the 3rd, not seen by the 7th), added on the 8th: counted once.
  const late = acc(
    input({
      movements: [row('2026-06-30', 3000_00, 'Initial deposit'), ...rentOn(3, ['07', '08', '09'])],
      adjustments: [added('adj-rent', 'Rent', 8)],
    }),
  );
  assert.deepEqual(
    late.events.map((e) => [e.date, e.source]),
    [['2026-10-07', 'usual_charge']],
  );
});

test('RG1f the timeline counts an added twin of a detected charge once in every month; months[] add up', async () => {
  const { balanceTimeline } = await import('../src/forecast/timeline');
  const t = balanceTimeline({
    ...toCome([added('adj-rent', 'Rent', 20)]),
    goals: [],
    accountId: 'acc',
    range: 'next_3_months',
  });
  const rent = t.events.filter((e) => e.amountCents === -950_00).map((e) => [e.date, e.source]);
  assert.deepEqual(rent, [
    ['2026-10-20', 'usual_charge'],
    ['2026-11-20', 'usual_charge'],
    ['2026-12-20', 'usual_charge'],
  ]);
  assert.equal(t.basis.regularChargesMonthlyCents, 950_00);
  for (const m of t.months)
    if (m.actual === 'none')
      assert.equal(m.endBalanceCents, m.startBalanceCents + m.incomeCents - m.outCents);
});

test('RG1f an added income of €950 on the 20th beside the usual €950 rent on the 20th is still counted: the twin rule is for charges only', () => {
  const plain = monthForecast(toCome([]));
  const f = monthForecast(toCome([added('adj-pay', 'Freelance pay', 20, 'income')]));
  const a = f.accounts[0];
  // Same day: the order of the two is not the rule, so compare them sorted by amount.
  assert.deepEqual(
    a.events
      .map((e) => [e.date, e.source, e.amountCents])
      .sort((x, y) => Number(x[2]) - Number(y[2])),
    [
      ['2026-10-20', 'usual_charge', -950_00],
      ['2026-10-20', 'expected_by_you', 950_00],
    ],
  );
  assert.deepEqual(f.notCounted, []);
  assert.equal(a.endCents, plain.accounts[0].endCents + 950_00);
});

test('RG1f a late usual charge on the 3rd (counted today) and an added charge on the 12th are two charges: both counted, both listed', () => {
  const f = monthForecast(
    input({
      movements: [row('2026-06-30', 3000_00, 'Initial deposit'), ...rentOn(3, ['07', '08', '09'])],
      adjustments: [added('adj-rent', 'Rent', 12)],
    }),
  );
  const a = f.accounts[0];
  // The twin rule compares usual days (3rd and 12th: 9 days apart), not the day a late charge is
  // counted on (today, the 7th: 5 days from the 12th).
  assert.deepEqual(
    a.events.map((e) => [e.date, e.source, e.amountCents]),
    [
      ['2026-10-07', 'usual_charge', -950_00],
      ['2026-10-12', 'expected_by_you', -950_00],
    ],
  );
  assert.deepEqual(f.notCounted, []);
  // The list agrees with the projection: both charges, each on its own.
  assert.deepEqual(
    a.regular.charges.map((r) => [r.label, r.source, r.amountCents]),
    [
      ['Alquiler Inmob Castellana', 'detected', -950_00],
      ['Rent', 'added_by_you', -950_00],
    ],
  );
});

// RG1e (orchestrator's live check): an added monthly charge takes at most one past movement per
// calendar month as its payment (the closest in amount, then in days), within 15% and 5 days of
// its day, across a month's end.
test("RG1e Lucía's added Gimnasio (€45, day 2) takes at most one movement a month from her irregular spend, not four card purchases", async () => {
  const seed = (await import('./alt-bank/demo-seed.json', { with: { type: 'json' } })).default;
  const lucia = {
    accounts: [{ id: 'acc-lucia', label: 'Main account', balanceCents: 2000_00 }],
    movements: seed.movements.filter((m: Row) => m.accountId === 'acc-lucia') as Row[],
    prepared: [],
    today: '2026-10-07',
  };
  const spend = (over: Partial<ForecastInput> = {}) =>
    monthForecast({ ...lucia, ...over }).accounts[0].regular.irregularSpend!.monthlyCents;
  const gym = { ...added('adj-gym', 'Gimnasio', 2), accountId: 'acc-lucia', amountCents: 45_00 };
  // July: Renfe €43.60 (closest to €45 of three); August: none; September: Mercadona €48.90.
  // Not taken: Mercadona €47.80 (3 Jul) and El Rincón €46.80 (4 Jul).
  const removed = spend() - spend({ adjustments: [gym] });
  assert.ok(Math.abs(removed - (43_60 + 48_90) / 3) <= 1, `removed ${removed} a month`);
});

test('RG1e a charge added for the 1st takes a payment made on the 30th or 31st before it', () => {
  const a = acc(
    input({
      movements: [
        row('2026-06-30', 3000_00, 'Initial deposit'),
        row('2026-07-31', -45_00, 'BASIC FIT'),
        row('2026-08-31', -45_00, 'GO FIT'),
        row('2026-09-30', -45_00, 'ALTAFIT'),
      ],
      adjustments: [{ ...added('adj-gym', 'Gym', 1), amountCents: 45_00 }],
    }),
  );
  assert.equal(a.regular.irregularSpend!.monthlyCents, 0);
});

test('RG1e an added item listed inside its twin says which one in adjustments (countedWith): the prepared rent, the detected rent; absent for Storage; never sent to the model', () => {
  const counted = (f: ReturnType<typeof monthForecast>) =>
    Object.fromEntries(f.adjustments.map((a) => [a.label, a.countedWith ?? null]));
  const withPrepared = monthForecast(twinSetup);
  assert.deepEqual(counted(withPrepared), {
    Rent: { label: 'To Inmob Castellana', source: 'prepared' },
    Storage: null,
  });
  assert.deepEqual(counted(monthForecast(input({ adjustments: [added('adj-rent', 'Rent', 1)] }))), {
    Rent: { label: 'Alquiler Inmob Castellana', source: 'detected' },
  });
  // No detected rent: the added Rent is the prepared transfer's twin only.
  const noDetected = input({
    movements: [row('2026-06-30', 3000_00, 'Initial deposit')],
    prepared: [prepared({})],
    adjustments: [added('adj-rent', 'Rent', 1)],
  });
  assert.deepEqual(counted(monthForecast(noDetected)), {
    Rent: { label: 'To Inmob Castellana', source: 'prepared' },
  });
  const model = JSON.stringify(forecastForModel(withPrepared));
  assert.ok(!model.includes('countedWith') && !model.includes('Storage'));
});
