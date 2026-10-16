// RG1: regular income and regular charges. Each account of the month forecast lists what comes
// every month (found by the rules over the last three full months, or added by the customer as
// monthly) and its average irregular spend; the customer can add a regular income by hand, and
// the projection counts it. Fixed dates; the route checks run on the demo bank (DECIDER=none).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
import type { ForecastAdjustment, ForecastInput } from '../src/forecast/month';
import type { PreparedView } from '../src/banking/prepared';

const { temp } = await setupEnv('banana-rg1-');
Object.assign(process.env, {
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { monthForecast } = await import('../src/forecast/month');
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const { forecastForModel, forecastOf } = await import('../src/agent/forecast');
const { bankView } = await import('../src/banking/view');
const route = await import('../app/api/[...path]/route');
seedApp();
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

async function api(userId: string, route_: string, body?: unknown) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await (route as any)[method](
    new Request(`http://localhost/api/${route_}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        cookie: `banana_actor=${sessionToken(userId)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: route_.split('/') }) },
  );
  return { status: response.status, body: (await response.json()) as any };
}

const TODAY = '2026-10-12';
type Row = NonNullable<ForecastInput['movements']>[number];
const row = (day: string, cents: number, description: string, more: Partial<Row> = {}): Row => ({
  accountId: 'acc',
  amountCents: cents,
  description,
  createdAt: `${day}T10:00:00.000Z`,
  ...more,
});
const monthly = (day: number, cents: number, description: string) =>
  ['07', '08', '09'].map((m) =>
    row(`2026-${m}-${String(day).padStart(2, '0')}`, cents, description),
  );
const HISTORY = [
  row('2026-07-01', 1000_00, 'Initial deposit'),
  ...monthly(3, -700_00, 'RECIBO ALQUILER CASA'),
  ...monthly(10, -39_90, 'DIGI SPAIN TELECOM'),
  ...monthly(14, -10_99, 'SPOTIFY'),
  ...monthly(28, 2150_00, 'NOMINA ACME CONSULTING'),
  row('2026-10-03', -700_00, 'RECIBO ALQUILER CASA'), // this month's rent, already paid
];
const input = (adjustments: ForecastAdjustment[] = [], over: Partial<ForecastInput> = {}) => ({
  accounts: [
    { id: 'acc', label: 'Main account', balanceCents: 300_00 },
    { id: 'sav', label: 'Savings', balanceCents: 500_00 },
  ],
  movements: HISTORY,
  prepared: [],
  adjustments,
  today: TODAY,
  ...over,
});
const expect = (over: Partial<ForecastAdjustment>): ForecastAdjustment => ({
  id: 'adj-1',
  kind: 'expect',
  accountId: 'acc',
  label: 'Freelance',
  amountCents: 400_00,
  repeats: 'monthly',
  day: 20,
  createdAt: '2026-10-06T08:00:00.000Z',
  ...over,
});
const main = (i: ForecastInput) => monthForecast(i).accounts.find((a) => a.id === 'acc')!;
const brief = (items: { label: string; amountCents: number; thisMonth: string }[]) =>
  items.map((r) => `${r.label} ${r.amountCents} ${r.thisMonth}`);

test('RG1 the regular income and charges are every usual item of the last three full months, those already paid this month included', () => {
  const { regular } = main(input());
  assert.deepEqual(brief(regular.charges), [
    'Alquiler Casa -70000 done',
    'Digi Spain Telecom -3990 late',
    'Spotify -1099 to_come',
  ]);
  assert.deepEqual(brief(regular.income), ['Nomina Acme Consulting 215000 to_come']);
  const rent = regular.charges[0];
  assert.equal(rent.id, 'ALQUILER CASA');
  assert.equal(rent.source, 'detected');
  assert.equal(rent.usualDay, 3);
  assert.deepEqual(rent.seenOn, ['2026-07-03', '2026-08-03', '2026-09-03']);
  assert.equal(rent.excludable, true);
  assert.equal(regular.income[0].usualDay, 28);
  // The savings account has no history of its own: nothing regular, no spend to average.
  const sav = monthForecast(input()).accounts.find((a) => a.id === 'sav')!;
  assert.deepEqual(sav.regular, {
    income: [],
    charges: [],
    irregularSpend: { monthlyCents: 0, months: ['2026-07', '2026-08', '2026-09'] },
  });
});

test('RG1 an excluded usual income or charge leaves the regular lists and the projection', () => {
  const before = main(input());
  const exclude = (key: string): ForecastAdjustment => ({
    id: `x-${key}`,
    kind: 'exclude',
    accountId: 'acc',
    merchantKey: key,
    label: key,
    createdAt: '2026-10-06T08:00:00.000Z',
  });
  const after_ = main(input([exclude('NOMINA ACME CONSULTING'), exclude('SPOTIFY')]));
  assert.deepEqual(after_.regular.income, []);
  assert.deepEqual(brief(after_.regular.charges), [
    'Alquiler Casa -70000 done',
    'Digi Spain Telecom -3990 late',
  ]);
  assert.equal(after_.endCents, before.endCents - 2150_00 + 10_99);
});

test('RG1 a monthly income added by the customer is regular and lifts the projection; a one-off is not regular', () => {
  const before = main(input());
  const added = main(input([expect({ direction: 'income' })]));
  assert.deepEqual(
    added.regular.income.map((r) => [
      r.label,
      r.amountCents,
      r.usualDay,
      r.source,
      r.thisMonth,
      r.adjustmentId,
      r.excludable,
    ]),
    [
      ['Freelance', 400_00, 20, 'added_by_you', 'to_come', 'adj-1', false],
      ['Nomina Acme Consulting', 2150_00, 28, 'detected', 'to_come', undefined, true],
    ],
  );
  assert.equal(added.endCents, before.endCents + 400_00);
  const event = added.events.find((e) => e.adjustmentId === 'adj-1')!;
  assert.deepEqual(
    [event.date, event.amountCents, event.source],
    ['2026-10-20', 400_00, 'expected_by_you'],
  );

  // A charge the customer adds as monthly is a regular charge; once, of either kind, is not.
  const more = main(
    input([
      expect({ id: 'gym', label: 'Gym', amountCents: 30_00, day: 15 }),
      expect({
        id: 'gift',
        direction: 'income',
        repeats: 'once',
        day: undefined,
        date: '2026-10-25',
      }),
      expect({
        id: 'car',
        amountCents: 90_00,
        repeats: 'once',
        day: undefined,
        date: '2026-10-26',
      }),
    ]),
  );
  assert.deepEqual(brief(more.regular.charges), [
    'Alquiler Casa -70000 done',
    'Digi Spain Telecom -3990 late',
    'Spotify -1099 to_come',
    'Gym -3000 to_come',
  ]);
  assert.deepEqual(brief(more.regular.income), ['Nomina Acme Consulting 215000 to_come']);
  assert.equal(more.endCents, before.endCents - 30_00 + 400_00 - 90_00);
});

test('RG1 an added income counts as a credit after the debits of its day, so a shortfall it covers is gone', () => {
  // €50: Digi (late) is kept on today, leaving €10.10; Spotify on the 14th takes it below zero.
  const tight = input([], {
    accounts: [{ id: 'acc', label: 'Main account', balanceCents: 50_00 }],
  });
  assert.equal(main(tight).shortfall?.date, '2026-10-14');
  const covered = main({ ...tight, adjustments: [expect({ direction: 'income', day: 13 })] });
  assert.equal(covered.shortfall, null);
  // On the charge's own day the charge still comes first.
  const sameDay = main({ ...tight, adjustments: [expect({ direction: 'income', day: 14 })] });
  assert.equal(sameDay.shortfall?.date, '2026-10-14');
  assert.equal(sameDay.lowest.balanceCents, -89);
});

test('RG1 irregular spend averages the debits that are not regular, not between own accounts and not prepared transfers', () => {
  const extra = [
    row('2026-07-05', -60_00, 'MERCADONA'),
    row('2026-08-09', -90_00, 'ZARA'),
    row('2026-09-12', -30_00, 'TRANSFERENCIA A ANA', {
      operationId: 'op-ana',
      fromAccountId: 'acc',
      toAccountId: 'ana',
    } as any),
    // Own accounts: known by the app's record, and by two legs of one operation.
    row('2026-08-20', -500_00, 'TRASPASO', {
      operationId: 'op-own',
      fromAccountId: 'acc',
      toAccountId: 'sav',
    } as any),
    row('2026-08-21', -200_00, 'TRASPASO', { operationId: 'op-legs' }),
    { ...row('2026-08-21', 200_00, 'TRASPASO', { operationId: 'op-legs' }), accountId: 'sav' },
    // A prepared transfer that was sent.
    row('2026-09-02', -120_00, 'TRANSFERENCIA A CASERO', {
      operationId: 'op-prep',
      fromAccountId: 'acc',
      toAccountId: 'landlord',
    } as any),
  ];
  const f = monthForecast(
    input([], { movements: [...HISTORY, ...extra], preparedOperationIds: ['op-prep'] }),
  );
  const acc = f.accounts.find((a) => a.id === 'acc')!;
  assert.deepEqual(acc.regular.irregularSpend, {
    monthlyCents: 60_00, // (60 + 90 + 30) / 3
    months: ['2026-07', '2026-08', '2026-09'],
  });
  // An excluded usual charge is the customer saying it is not regular: it counts as irregular.
  const noSpotify = monthForecast(
    input(
      [
        {
          id: 'x',
          kind: 'exclude',
          accountId: 'acc',
          merchantKey: 'SPOTIFY',
          label: 'Spotify',
          createdAt: '2026-10-06T08:00:00.000Z',
        },
      ],
      { movements: [...HISTORY, ...extra], preparedOperationIds: ['op-prep'] },
    ),
  ).accounts.find((a) => a.id === 'acc')!;
  assert.equal(noSpotify.regular.irregularSpend!.monthlyCents, 60_00 + 10_99);
  // No history, no average.
  const none = main(input([], { movements: [row('2026-10-01', 100_00, 'Initial deposit')] }));
  assert.deepEqual(none.regular, { income: [], charges: [], irregularSpend: null });
  assert.equal(main(input([], { movements: null })).regular.irregularSpend, null);
});

test('RG1 the route takes `direction: "income"`; without it an expected item is a charge as before; the chat sees the regular block with no label of the customer', async () => {
  const body = {
    kind: 'expect',
    accountId: 'acc-lucia',
    label: 'Side job',
    amountCents: 300_00,
    repeats: 'monthly',
    day: 27,
  };
  const income = await api('lucia', 'forecast/adjustments', { ...body, direction: 'income' });
  assert.equal(income.status, 201);
  assert.equal(income.body.adjustment.direction, 'income');
  assert.equal(income.body.adjustment.amountCents, 300_00);
  const charge = await api('lucia', 'forecast/adjustments', { ...body, label: 'Gym' });
  assert.equal(charge.status, 201);
  assert.equal('direction' in charge.body.adjustment, false);
  assert.equal(
    (await api('lucia', 'forecast/adjustments', { ...body, direction: 'gift' })).status,
    400,
  );

  const f = (await api('lucia', 'dashboard')).body.forecast;
  const acc = f.accounts.find((a: any) => a.id === 'acc-lucia');
  assert.ok(
    acc.regular.income.some(
      (r: any) =>
        r.label === 'Side job' &&
        r.amountCents === 300_00 &&
        r.source === 'added_by_you' &&
        r.usualDay === 27,
    ),
  );
  assert.ok(acc.regular.charges.some((r: any) => r.label === 'Gym' && r.amountCents === -300_00));
  if (f.today <= `${f.today.slice(0, 7)}-27`)
    assert.ok(
      acc.events.some((e: any) => e.source === 'expected_by_you' && e.amountCents === 300_00),
    );

  // Lucía's rules-found block (demo seed, which ends on 6 October 2026), on a fixed day.
  const lucia = forecastOf('lucia', await bankView('lucia', { classify: 'none' }), '2026-10-07');
  const her = lucia.accounts.find((a) => a.id === 'acc-lucia')!.regular;
  const found = (list: typeof her.income, name: RegExp) =>
    list
      .filter((r) => r.source === 'detected' && name.test(r.label))
      .map((r) => [r.amountCents, r.usualDay]);
  assert.deepEqual(found(her.income, /acme/i), [[2150_00, 28]]);
  assert.deepEqual(found(her.charges, /digi/i), [[-39_90, 10]]);
  assert.deepEqual(found(her.charges, /spotify/i), [[-10_99, 14]]);
  assert.deepEqual(found(her.charges, /transporte/i), [[-32_70, 31]]);
  assert.ok(her.irregularSpend!.monthlyCents > 0);

  const model = JSON.stringify(forecastForModel(f));
  assert.ok(model.includes('"regular"'));
  assert.match(model, /Acme/i);
  assert.ok(
    !model.includes('Side job') && !model.includes('Gym'),
    "the customer's labels stay out",
  );
});
