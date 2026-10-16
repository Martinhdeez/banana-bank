// FC1 (plan 28 §4.4, §5.1, §6.1; REQ-PL-18…24): the month forecast. One check per real risk: a
// false figure, an estimate read as a fact, a usual item invented from too little history, a
// payment counted twice, the video scene on the merged demo seed, an option that would move
// money, and another customer's accounts. The rules take `today`; the route checks use a
// transfer due on the real day, so no check depends on the date it runs. Demo bank
// (tests/alt-bank), DECIDER=none: no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { callApi, setupEnv, startSimulator } from './helpers/bank';
import type { ForecastInput } from '../src/forecast/month';
import type { PreparedView } from '../src/banking/prepared';

const { temp } = await setupEnv('banana-fc1-');
Object.assign(process.env, {
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json', // what `npm run demo` serves
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { monthForecast } = await import('../src/forecast/month');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { today } = await import('../src/banking/prepared');
const { currentObservation, setObservationsEnabled } = await import('../src/observations/state');
const { explainObservations } = await import('../src/observations/detect');
const { dismissObservation } = await import('../src/observations/state');
const { assistantSettingsOf } = await import('../src/assistant-settings');
const { bankView } = await import('../src/banking/view');
seedApp();
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const TODAY = '2026-10-06';
type Row = NonNullable<ForecastInput['movements']>[number];
const row = (day: string, cents: number, description: string, accountId = 'acc'): Row => ({
  accountId,
  amountCents: cents,
  description,
  createdAt: `${day}T10:00:00.000Z`,
});
// One movement on the same day of July, August and September 2026.
const monthly = (day: number, cents: number, description: string) =>
  ['07', '08', '09'].map((m) =>
    row(`2026-${m}-${String(day).padStart(2, '0')}`, cents, description),
  );
const prepared = (over: Partial<PreparedView>): PreparedView =>
  ({
    id: 'p1',
    fromAccountId: 'acc',
    toAccountId: 'acc-bruno',
    to: 'Bruno',
    amountCents: 3000_00,
    state: 'scheduled',
    nextDue: '2026-10-20',
    ...over,
  }) as PreparedView;
const HISTORY = [
  row('2026-07-01', 1000_00, 'Initial deposit'),
  ...monthly(1, -950_00, 'RECIBO ALQUILER INMOB'),
  row('2026-10-01', -950_00, 'RECIBO ALQUILER INMOB'), // already paid this month
  ...monthly(10, -39_90, 'DIGI SPAIN TELECOM'),
  ...monthly(14, -10_99, 'SPOTIFY'),
];
const input = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  accounts: [
    { id: 'acc', label: 'Main account', balanceCents: 3022_61 },
    { id: 'sav', label: 'Savings', balanceCents: 500_00 },
  ],
  movements: HISTORY,
  prepared: [prepared({})],
  today: TODAY,
  ...over,
});
const main = (i: ForecastInput) => monthForecast(i).accounts[0];
const cents = (text: string) =>
  [...text.matchAll(/€([\d,]+\.\d\d)/g)].map((m) =>
    Math.round(Number(m[1].replace(/,/g, '')) * 100),
  );

test('REQ-PL-18/19/21 an estimated shortfall is exact to the cent, built only from its events, and says it is an estimate', () => {
  const a = main(input());
  assert.deepEqual(a.shortfall, {
    date: '2026-10-20',
    shortCents: 28_28, // 3,022.61 − 39.90 − 10.99 − 3,000.00
    certainty: 'estimated',
    forLabel: 'your prepared transfer to Bruno',
    preparedId: 'p1',
  });
  assert.equal(a.headline, '€28.28 short on 20 Oct');
  assert.equal(
    a.explanation,
    'If Digi Spain Telecom (€39.90, around the 10th) and Spotify (€10.99, around the 14th) come as in July–September, on 20 Oct you would be €28.28 short for your prepared transfer to Bruno. An estimate.',
  );
  // The rent of 1 October is in the balance already: it is not projected a second time.
  assert.deepEqual(
    a.events.map((e) => [e.date, e.amountCents, e.balanceAfterCents, e.certainty]),
    [
      ['2026-10-10', -39_90, 2982_71, 'estimated'],
      ['2026-10-14', -10_99, 2971_72, 'estimated'],
      ['2026-10-20', -3000_00, -28_28, 'certain'],
    ],
  );
  const figures = a.events.flatMap((e) => [Math.abs(e.amountCents), Math.abs(e.balanceAfterCents)]);
  for (const c of cents(a.headline + a.explanation)) assert.ok(figures.includes(c), `${c}`);
  // The way to cover it: the gap rounded up to €10, the day before, from the account that can.
  assert.deepEqual(a.options, [
    {
      id: 'move:sav',
      title: 'Move €30.00 from Savings on 19 Oct',
      consequence: 'Lowest point €1.72 on 20 Oct. An estimate.',
      change: { kind: 'add', date: '2026-10-19', amountCents: 30_00, label: 'From Savings' },
      prepare: {
        fromAccountId: 'sav',
        toAccountId: 'acc',
        amountCents: 30_00,
        concept: 'Cover for 20 Oct',
        when: 'on_date',
        date: '2026-10-19',
      },
    },
  ]);
  // Accounts are never netted: the savings would cover it, and the account is still short.
  assert.equal(monthForecast(input()).accounts[1].shortfall, null);
});

test('REQ-PL-21 a certain shortfall names no usual charge and is not worded as an estimate', () => {
  const a = main(input({ prepared: [prepared({ amountCents: 3100_00, state: 'due' })] }));
  assert.equal(a.shortfall?.certainty, 'certain');
  assert.equal(
    a.explanation,
    'On 6 Oct you are €77.39 short for your prepared transfer to Bruno. Your prepared transfers alone take this account below zero.',
  );
  assert.doesNotMatch(a.explanation, /If |estimate|Digi|Spotify/);
  // Review: a usual charge of the shortfall day, after the transfer that crossed, is in the
  // day's figure (3,022.61 − 39.90 − 10.99 − 2,975 − 20 = −23.28): named, and an estimate.
  const sameDay = main(
    input({
      movements: [...HISTORY, ...monthly(20, -20_00, 'ZETA GYM')],
      prepared: [prepared({ amountCents: 2975_00 })],
    }),
  );
  assert.deepEqual(
    sameDay.events.slice(2).map((e) => [e.label, e.balanceAfterCents, e.merchantKey]),
    [
      ['Prepared transfer to Bruno', -3_28, undefined],
      ['Zeta Gym', -23_28, 'ZETA GYM'], // merchantKey: the key the rule grouped by (for FC2)
    ],
  );
  assert.equal(sameDay.shortfall?.certainty, 'estimated');
  assert.match(
    sameDay.explanation,
    /^If .*Zeta Gym \(€20\.00, around the 20th\) come .*€23\.28 short.* An estimate\.$/,
  );
});

test('REQ-PL-19 review: a late charge stays on today for 7 days, late income is not counted, and day 31 is the last day of a shorter month', () => {
  const movements = [...HISTORY, ...monthly(8, 1500_00, 'NOMINA ACME')];
  const on = (today: string) => main(input({ movements, prepared: [], today })).events;
  assert.deepEqual(
    on('2026-10-17').map((e) => [e.date, e.label, e.late, e.note]),
    [
      // Spotify (the 14th) and Digi (the 10th, 7 days ago) are late: on today. The income of the 8th is not counted.
      [
        '2026-10-17',
        'Digi Spain Telecom',
        true,
        'Usually around the 10th, not seen yet this month. An estimate.',
      ],
      [
        '2026-10-17',
        'Spotify',
        true,
        'Usually around the 14th, not seen yet this month. An estimate.',
      ],
    ],
  );
  assert.deepEqual(
    on('2026-10-18').map((e) => e.label),
    ['Spotify'],
  );
  // Seen on 31 Aug, 30 Sep, 31 Oct: expected on 30 Nov, and nothing of December is counted.
  const november = monthForecast(
    input({
      movements: [
        row('2026-07-01', 1, 'Initial deposit'),
        row('2026-08-31', -50_00, 'RENT X'),
        row('2026-09-30', -50_00, 'RENT X'),
        row('2026-10-31', -50_00, 'RENT X'),
      ],
      prepared: [prepared({ nextDue: '2026-12-01' })],
      today: '2026-11-06',
    }),
  );
  assert.equal(november.until, '2026-11-30');
  assert.deepEqual(
    november.accounts[0].events.map((e) => [e.date, e.label, e.usualDay]),
    [['2026-11-30', 'Rent X', 31]],
  );
});

test('REQ-PL-20 silence: a truncated window and irregular income give no usual item and no income', () => {
  // A full page (100 rows) that starts in August: July may be missing, so nothing is "usual".
  const page = [
    ...HISTORY.filter((m) => m.createdAt > '2026-08'),
    ...Array.from({ length: 100 }, (_, n) => row('2026-09-20', -100, `BAR ${n}`)),
  ].slice(0, 100);
  const cut = monthForecast(input({ movements: page }));
  assert.deepEqual(cut.history, { months: null, reason: 'window_short' });
  assert.deepEqual(cut.notes, [
    'Not enough history to find usual charges: only your prepared transfers are counted.',
  ]);
  assert.deepEqual(
    cut.accounts[0].events.map((e) => e.source),
    ['prepared'],
  );
  assert.equal(cut.accounts[0].shortfall, null); // 3,022.61 covers 3,000 on its own

  const irregular = monthForecast(
    input({
      movements: [
        ...HISTORY,
        row('2026-07-07', 1250_00, 'TRANSFERENCIA RECIBIDA ESTUDIO NORTE'),
        row('2026-08-12', 1400_00, 'TRANSFERENCIA RECIBIDA ESTUDIO NORTE'),
        row('2026-09-30', 1650_00, 'TRANSFERENCIA RECIBIDA ESTUDIO NORTE'),
      ],
    }),
  );
  assert.equal(irregular.income, 'none_regular');
  assert.deepEqual(irregular.notes, ['No regular income found; none is counted.']);
  assert.deepEqual(irregular.notCounted, [
    {
      label: 'Transferencia Recibida Estudio Norte',
      reason: 'irregular',
      text: 'Transferencia Recibida Estudio Norte: not regular, not counted.',
    },
  ]);
  assert.ok(irregular.accounts[0].events.every((e) => e.source !== 'usual_income'));
});

test('REQ-PL-19 a usual charge the customer also prepared as a transfer is counted once', () => {
  const twin = prepared({ id: 'p2', to: 'Digi', amountCents: 39_90, nextDue: '2026-10-12' });
  const a = main(input({ prepared: [twin] }));
  assert.deepEqual(
    a.events.map((e) => [e.date, e.amountCents, e.source]),
    [
      ['2026-10-12', -39_90, 'prepared'],
      ['2026-10-14', -10_99, 'usual_charge'],
    ],
  );
});

test('REQ-PL-24 the video scene on the merged demo seed, as the demo bank serves it: Lucía, €2,915 to Bruno on 20 Oct', async () => {
  const of = async (userId: string, list: PreparedView[]) => {
    const { accounts, movements } = await bankView(userId, { classify: 'none' });
    return monthForecast({ accounts: accounts as any, movements, prepared: list, today: TODAY });
  };
  const lucia = await of('lucia', [prepared({ fromAccountId: 'acc-lucia', amountCents: 2915_00 })]);
  const [a] = lucia.accounts;
  assert.equal(a.balanceCents, 2937_61);
  assert.deepEqual(
    a.events.map((e) => [e.date, e.label, e.amountCents, e.balanceAfterCents]),
    [
      ['2026-10-10', 'Digi Spain Telecom', -39_90, 2897_71],
      ['2026-10-14', 'Spotify', -10_99, 2886_72],
      ['2026-10-20', 'Prepared transfer to Bruno', -2915_00, -28_28],
      ['2026-10-28', 'Nomina Acme Consulting', 2150_00, 2121_72],
      ['2026-10-31', 'Recarga Abono Transporte Crtm', -32_70, 2089_02],
    ],
  );
  assert.equal(a.headline, '€28.28 short on 20 Oct');
  assert.equal(a.options[0]?.title, 'Move €30.00 from Personal savings on 19 Oct');
  assert.equal(lucia.income, 'counted');
  // Bruno, same seed: two payers, neither regular.
  assert.deepEqual((await of('bruno', [])).notes, ['No regular income found; none is counted.']);
});

const count = (table: string) =>
  (appDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
const bankOperations = async () =>
  (
    (await (
      await fetch(`${process.env.BANK_URL}/_control/state`, {
        headers: { 'x-alt-control': 'alt-control' },
      })
    ).json()) as { operations: unknown[] }
  ).operations.length;

test('REQ-PL-23 the dashboard holds only the owner\'s accounts, and "Prepare this" prepares one transfer and moves no money', async (t) => {
  const before = (await callApi('lucia', 'dashboard')).body.forecast;
  assert.deepEqual(
    before.accounts.map((a: any) => a.id),
    ['acc-lucia', 'acc-lucia-savings'],
  );
  assert.ok(before.accounts.every((a: any) => a.headline && a.explanation && !a.shortfall));
  assert.equal((await callApi('marta', 'dashboard')).body.forecast, undefined); // operator

  // €3,100 to Bruno for tomorrow (the real one): more than the €2,937.61 of the account.
  const tomorrow = new Date(Date.parse(`${today()}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (tomorrow.slice(0, 7) !== today().slice(0, 7))
    return t.skip('the last day of a month: tomorrow is past what the forecast covers');
  const due = await callApi('lucia', 'prepared', {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-bruno',
    amountCents: 3100_00,
    concept: 'Loan',
    when: 'on_date',
    date: tomorrow,
  });
  assert.equal(due.body.status, 'prepared', JSON.stringify(due.body));
  const short = (await callApi('lucia', 'dashboard')).body.forecast.accounts[0];
  assert.equal(short.shortfall.preparedId, due.body.prepared.id);
  const [option] = short.options;
  assert.equal(option.prepare.fromAccountId, 'acc-lucia-savings');

  const [intents, approvals, operations] = [
    count('intents'),
    count('approvals'),
    await bankOperations(),
  ];
  const taken = await callApi('lucia', 'prepared', option.prepare);
  assert.equal(taken.body.status, 'prepared', JSON.stringify(taken.body));
  assert.deepEqual(
    [count('intents'), count('approvals'), await bankOperations()],
    [intents, approvals, operations],
    'no intent, no approval, no bank operation',
  );
  const after = (await callApi('lucia', 'dashboard')).body;
  assert.equal(after.prepared.length, 2);
  assert.equal(after.forecast.accounts[0].shortfall, null);
  assert.ok(after.forecast.accounts[0].lowest.balanceCents >= 0);
  // Bruno sees nothing of it: his forecast holds his own account only.
  const bruno = (await callApi('bruno', 'dashboard')).body.forecast;
  assert.deepEqual(
    bruno.accounts.map((a: any) => a.id),
    ['acc-bruno'],
  );
  assert.doesNotMatch(JSON.stringify(bruno), /lucia|Cover for/i);
});

test('REQ-PL-22 month_shortfall: never on the page, in the chat only, not next to prepared_uncovered, not when switched off', () => {
  const i = input();
  const o = {
    accounts: i.accounts,
    view: null,
    prepared: i.prepared,
    today: TODAY,
    forecast: monthForecast(i),
  };
  assert.equal(currentObservation('carla', o, 'page'), null);
  assert.deepEqual(currentObservation('carla', o, 'chat'), {
    key: 'month_shortfall:acc:2026-10',
    kind: 'month_shortfall',
    title: 'Short before the month ends',
    basis: o.forecast.accounts[0].explanation,
    movementIds: [],
    preparedId: 'p1',
  });
  // Due today for more than the balance: `prepared_uncovered` names it, the shortfall is silent.
  const big = input({
    prepared: [prepared({ amountCents: 3100_00, state: 'due', nextDue: TODAY })],
  });
  const both = { ...o, prepared: big.prepared, forecast: monthForecast(big) };
  assert.equal(currentObservation('carla', both, 'chat')?.kind, 'prepared_uncovered');
  assert.deepEqual(explainObservations(both).find((k) => k.kind === 'month_shortfall')!.found, []);
  const ctx = { userId: 'carla', conversationId: null, runId: 'run', intentId: '' };
  // A dismissed one keeps its title in what was recorded (GET /api/assistant-settings, AC1).
  dismissObservation(ctx, 'month_shortfall:acc:2026-10');
  assert.equal(
    assistantSettingsOf('carla').recorded[0].text,
    'You dismissed: Short before the month ends',
  );
  setObservationsEnabled(ctx, false);
  assert.equal(currentObservation('carla', o, 'chat'), null);
  setObservationsEnabled(ctx, true);
});
