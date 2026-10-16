// FC2 (plan 28 §13, §6.1 "Forecast adjustments"; REQ-PL-35…40): the customer's adjustments to
// the month forecast. One check per real risk: a false figure, a payment counted twice, another
// customer's data, the free-text label leaving the customer's own page, and data loss. The rules
// take `today`; the route checks assert nothing that depends on the day they run. Demo bank
// (tests/alt-bank), DECIDER=none: no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { setupEnv, startSimulator } from './helpers/bank';
import type { ForecastAdjustment, ForecastInput } from '../src/forecast/month';
import type { PreparedView } from '../src/banking/prepared';

const { temp } = await setupEnv('banana-fc2-');
Object.assign(process.env, {
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { monthForecast } = await import('../src/forecast/month');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb, SCHEMA_VERSION } = await import('../src/db');
const { today } = await import('../src/banking/prepared');
const { explainObservations } = await import('../src/observations/detect');
const { sessionToken } = await import('../src/auth');
const route = await import('../app/api/[...path]/route');
seedApp();
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

// Every line the app logs while this file runs (the access log included).
const logged: string[] = [];
for (const level of ['info', 'warn', 'error', 'log'] as const) {
  const print = console[level];
  console[level] = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
    if (!String(args[0]).includes('"event":"api_request"')) print(...args);
  };
}
// `userId` null: signed out.
async function api(userId: string | null, route_: string, body?: unknown, method?: string) {
  method ??= body === undefined ? 'GET' : 'POST';
  const response = await (route as any)[method](
    new Request(`http://localhost/api/${route_}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(userId && { cookie: `banana_actor=${sessionToken(userId)}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: route_.split('/') }) },
  );
  return { status: response.status, body: (await response.json()) as any };
}
const forecastOf = async (userId: string) => (await api(userId, 'dashboard')).body.forecast;
const count = (table: string) =>
  (appDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

const TODAY = '2026-10-06';
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
  ...monthly(10, -39_90, 'DIGI SPAIN TELECOM'),
  ...monthly(14, -10_99, 'SPOTIFY'),
];
const input = (adjustments: ForecastAdjustment[], over: Partial<ForecastInput> = {}) => ({
  accounts: [
    { id: 'acc', label: 'Main account', balanceCents: 450_00 },
    { id: 'sav', label: 'Savings', balanceCents: 500_00 },
  ],
  movements: HISTORY,
  prepared: [],
  adjustments,
  today: TODAY,
  ...over,
});
const adjustment = (over: Partial<ForecastAdjustment>): ForecastAdjustment => ({
  id: 'adj-car',
  kind: 'expect',
  accountId: 'acc',
  label: 'Car insurance',
  amountCents: 420_00,
  repeats: 'once',
  date: '2026-10-25',
  createdAt: '2026-10-06T08:00:00.000Z',
  ...over,
});
const CAR = adjustment({});
const NO_SPOTIFY = adjustment({
  id: 'adj-spotify',
  kind: 'exclude',
  merchantKey: 'SPOTIFY',
  label: 'Spotify',
  amountCents: undefined,
  repeats: undefined,
  date: undefined,
});
const main = (i: ForecastInput) => monthForecast(i).accounts.find((a) => a.id === 'acc')!;
const cents = (text: string) =>
  [...text.matchAll(/€([\d,]+\.\d\d)/g)].map((m) =>
    Math.round(Number(m[1].replace(/,/g, '')) * 100),
  );

test('REQ-PL-35/40 a charge the customer adds gives the exact shortfall, as an estimate that names it as theirs; leaving a usual charge out removes exactly its amount', () => {
  const before = monthForecast(input([]));
  const covered = main(input([]));
  assert.equal(covered.shortfall, null);
  assert.equal(covered.endCents, 399_11); // 450.00 − 39.90 − 10.99
  assert.equal(before.adjustable, true);

  const f = monthForecast(input([CAR]));
  const a = f.accounts[0];
  assert.deepEqual(a.shortfall, {
    date: '2026-10-25',
    shortCents: 20_89, // 450.00 − 39.90 − 10.99 − 420.00
    certainty: 'estimated',
    forLabel: 'Car insurance, added by you',
  });
  assert.equal(a.headline, '€20.89 short on 25 Oct');
  assert.equal(
    a.explanation,
    'If Digi Spain Telecom (€39.90, around the 10th) and Spotify (€10.99, around the 14th) come as in July–September and Car insurance (€420.00, on the 25th, added by you) comes, on 25 Oct you would be €20.89 short for Car insurance, added by you. An estimate.',
  );
  assert.deepEqual(
    a.events.map((e) => [e.date, e.amountCents, e.balanceAfterCents, e.source, e.certainty]),
    [
      ['2026-10-10', -39_90, 410_10, 'usual_charge', 'estimated'],
      ['2026-10-14', -10_99, 399_11, 'usual_charge', 'estimated'],
      ['2026-10-25', -420_00, -20_89, 'expected_by_you', 'estimated'],
    ],
  );
  assert.equal(a.events[2].adjustmentId, 'adj-car');
  assert.equal(a.events[0].merchantKey, 'DIGI SPAIN TELECOM');
  const figures = a.events.flatMap((e) => [Math.abs(e.amountCents), Math.abs(e.balanceAfterCents)]);
  for (const c of cents(a.headline + a.explanation)) assert.ok(figures.includes(c), `${c}`);
  assert.deepEqual(
    a.options.map((o) => [o.title, o.consequence]),
    [['Move €30.00 from Savings on 24 Oct', 'Lowest point €9.11 on 25 Oct. An estimate.']],
  );
  assert.deepEqual(f.adjustments, [CAR]);
  assert.match(f.sourceLine, /and what you added or left out\. No AI is involved/);

  // Left out: exactly Spotify's €10.99 leaves the projection, and the line says who left it out.
  const less = monthForecast(input([CAR, NO_SPOTIFY]));
  assert.equal(less.accounts[0].shortfall!.shortCents, 9_90);
  assert.equal(less.accounts[0].endCents, a.endCents + 10_99);
  assert.ok(!less.accounts[0].events.some((e) => e.merchantKey === 'SPOTIFY'));
  assert.deepEqual(less.notCounted, [
    {
      label: 'Spotify',
      reason: 'excluded_by_you',
      adjustmentId: 'adj-spotify',
      text: 'Spotify: left out by you, not counted.',
    },
  ]);
  // Another account's exclusion, or another customer's adjustment, changes nothing here.
  assert.deepEqual(
    monthForecast(input([{ ...NO_SPOTIFY, accountId: 'sav' }])).accounts,
    before.accounts,
  );
  assert.deepEqual(monthForecast(input([{ ...CAR, accountId: 'acc-of-another' }])), before);

  // Only the customer's own item counted: no "as in July–September", still an estimate.
  const alone = main(input([adjustment({ amountCents: 470_00 })], { movements: [] }));
  assert.equal(
    alone.explanation,
    'If Car insurance (€470.00, on the 25th, added by you) comes, on 25 Oct you would be €20.00 short for Car insurance, added by you. An estimate.',
  );
  assert.equal(alone.shortfall!.certainty, 'estimated');
  // Covered with it: the count keeps the two kinds apart. Monthly on the 31st, a full month.
  const small = main(input([adjustment({ amountCents: 20_00, repeats: 'monthly', day: 31 })]));
  assert.equal(
    small.explanation,
    'Lowest point €379.11 on 31 Oct. An estimate: it counts 2 usual payments and 1 added by you.',
  );
  // A monthly day already passed, and a one-off of another month, are not in this month.
  for (const out of [
    adjustment({ repeats: 'monthly', day: 5, date: undefined }),
    adjustment({ date: '2026-11-25' }),
  ]) {
    const later = monthForecast(input([out]));
    // RG1: a monthly one is still a regular charge (`regular`); RG1b: on the 5th, it is also a
    // line of `nextMonth`; nothing else changes.
    const unregular = (accounts: typeof before.accounts) =>
      accounts.map(({ regular: _, nextMonth: __, ...a }) => a);
    assert.deepEqual(unregular(later.accounts), unregular(before.accounts));
    assert.deepEqual(later.adjustments, [out], 'still listed, so it can be removed');
  }
});

test('REQ-PL-36 an expected charge that a movement of this month or a prepared transfer already is, is not counted twice', () => {
  const paid = monthForecast(
    input([CAR], { movements: [...HISTORY, row('2026-10-21', -410_00, 'SEGUROS MUTUA')] }),
  );
  assert.ok(!paid.accounts[0].events.some((e) => e.source === 'expected_by_you'));
  assert.deepEqual(paid.notCounted, [
    {
      label: 'Car insurance (€420.00, added by you)',
      reason: 'already_seen',
      adjustmentId: 'adj-car',
      text: 'Car insurance (€420.00, added by you): a payment like it is already in your movements this month, not counted twice.',
    },
  ]);
  const prepared = monthForecast(
    input([CAR], {
      prepared: [
        {
          id: 'p1',
          fromAccountId: 'acc',
          toAccountId: 'acc-mutua',
          to: 'Mutua',
          amountCents: 400_00,
          state: 'scheduled',
          nextDue: '2026-10-24',
        } as PreparedView,
      ],
    }),
  );
  const a = prepared.accounts.find((x) => x.id === 'acc')!;
  assert.deepEqual(
    a.events.map((e) => [e.source, e.amountCents]),
    [
      ['usual_charge', -39_90],
      ['usual_charge', -10_99],
      ['prepared', -400_00],
    ],
  );
  assert.equal(prepared.notCounted[0].reason, 'already_prepared');
  assert.equal(
    prepared.notCounted[0].text,
    'Car insurance (€420.00, added by you): a prepared transfer like it is already counted, not counted twice.',
  );
  // Too far in amount (more than 15%) or in days (more than 5): it is another payment.
  for (const other of [row('2026-10-21', -300_00, 'X'), row('2026-10-01', -420_00, 'X')])
    assert.equal(
      main(input([CAR], { movements: [...HISTORY, other] })).events.at(-1)!.source,
      'expected_by_you',
    );
});

// FC2 review: the observation is worked out without what the customer added. A shortfall their
// charge alone causes is none; one that exists without it is still found, without their label.
test('REQ-PL-38 a month_shortfall observation never carries the label, and a shortfall that exists without the added charge is still an observation', () => {
  const view = {
    movements: HISTORY.map((m, n) => ({ ...m, id: `m${n}` })),
    categories: new Map(),
  };
  const shortfall = (i: ForecastInput) =>
    explainObservations({ ...i, view, forecast: monthForecast(i) }).find(
      (k) => k.kind === 'month_shortfall',
    )!.found;
  assert.ok(monthForecast(input([CAR])).accounts[0].shortfall);
  assert.deepEqual(shortfall(input([CAR])), [], 'only the added charge takes it below zero');

  const two = ['2026-10-12', '2026-10-15'].map(
    (nextDue, n) =>
      ({
        id: `p${n}`,
        fromAccountId: 'acc',
        toAccountId: 'acc-landlord',
        to: 'Landlord',
        amountCents: 250_00,
        state: 'scheduled',
        nextDue,
      }) as PreparedView,
  );
  const without = shortfall(input([], { prepared: two }));
  assert.match(without[0].basis, /on 15 Oct you would be €100\.89 short/); // 450 − 39.90 − 250 − 10.99 − 250
  // The customer's charge before the shortfall: their page counts it, the observation does not.
  const early = input([adjustment({ amountCents: 5_00, date: '2026-10-08' })], { prepared: two });
  assert.match(monthForecast(early).accounts[0].explanation, /Car insurance.*€105\.89 short/);
  assert.deepEqual(shortfall(early), without);
  // What the customer left out stays out of the observation too.
  const less = shortfall(input([CAR, NO_SPOTIFY], { prepared: two }));
  assert.match(less[0].basis, /on 15 Oct you would be €89\.90 short/);
  assert.doesNotMatch(JSON.stringify([without, less]), /Car insurance|added by you/);
});

const LABEL = 'Zq insurance 7731';
const expectBody = (over: object = {}) => ({
  kind: 'expect',
  accountId: 'acc-lucia',
  label: LABEL,
  amountCents: 9_000_000,
  repeats: 'once',
  date: today(),
  ...over,
});

test('REQ-PL-37/38 routes: the owner only, strict bodies, the label refused when unsafe and never logged, and removing restores the forecast byte for byte', async () => {
  const before = JSON.stringify(await forecastOf('lucia'));
  const brunoBefore = JSON.stringify(await forecastOf('bruno'));
  const [intents, approvals, prepared, events] = [
    'intents',
    'approvals',
    'prepared_transfers',
    'events',
  ].map(count);

  assert.equal((await api(null, 'forecast/adjustments', expectBody())).status, 401);
  assert.equal((await api('marta', 'forecast/adjustments', expectBody())).status, 403); // operator
  assert.equal((await api('marta', 'forecast/adjustments/x', undefined, 'DELETE')).status, 403);
  assert.equal((await api('lucia', 'forecast/adjustments')).status, 405);
  // Another customer's account, and an unknown one: not found.
  assert.equal((await api('bruno', 'forecast/adjustments', expectBody())).status, 404);
  assert.equal(
    (await api('lucia', 'forecast/adjustments', expectBody({ accountId: 'nope' }))).status,
    404,
  );
  const yesterday = new Date(Date.parse(`${today()}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const bad of [
    expectBody({ extra: 1 }),
    expectBody({ label: 'x'.repeat(41) }),
    expectBody({ label: '   ' }),
    expectBody({ label: 'Car ‮ecnarusni' }), // right-to-left override
    expectBody({ label: 'Car ⁦insurance' }), // isolate
    expectBody({ label: 'Car\u0007insurance' }), // control character
    expectBody({ label: 'Car\ninsurance' }),
    expectBody({ amountCents: 0 }),
    expectBody({ amountCents: 10.5 }),
    expectBody({ amountCents: 10_000_001 }),
    expectBody({ date: yesterday }),
    expectBody({ date: '2026-02-30' }),
    expectBody({ date: '2099-01-01' }),
    expectBody({ repeats: 'monthly' }), // a date where a day belongs
    {
      kind: 'expect',
      accountId: 'acc-lucia',
      label: 'a',
      amountCents: 1,
      repeats: 'monthly',
      day: 32,
    },
    { kind: 'exclude', accountId: 'acc-lucia', merchantKey: 'spotify' }, // not a key
    { kind: 'exclude', accountId: 'acc-lucia', merchantKey: 'SPOTIFY', label: 'x' },
    { kind: 'income', accountId: 'acc-lucia', label: 'a', amountCents: 1 },
  ])
    assert.equal(
      (await api('lucia', 'forecast/adjustments', bad)).status,
      400,
      JSON.stringify(bad),
    );
  assert.equal(count('forecast_adjustments'), 0, 'nothing refused was stored');
  assert.equal(JSON.stringify(await forecastOf('lucia')), before);

  // Added: €90,000 today takes the account below zero, as an estimate, named as her own.
  const added = await api('lucia', 'forecast/adjustments', expectBody({ label: `  ${LABEL} ` }));
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const { id } = added.body.adjustment;
  assert.deepEqual(added.body, {
    adjustment: {
      id,
      kind: 'expect',
      accountId: 'acc-lucia',
      label: LABEL, // trimmed
      amountCents: 9_000_000,
      repeats: 'once',
      date: today(),
      createdAt: added.body.adjustment.createdAt,
    },
  });
  const short = await forecastOf('lucia');
  const account = short.accounts[0];
  assert.equal(account.id, 'acc-lucia');
  assert.equal(account.shortfall.certainty, 'estimated');
  assert.equal(account.shortfall.forLabel, `${LABEL}, added by you`);
  assert.match(account.explanation, /added by you\) comes?[, ].* An estimate\.$/);
  assert.equal(account.events.find((e: any) => e.adjustmentId === id).source, 'expected_by_you');
  assert.deepEqual(short.adjustments, [added.body.adjustment]);
  // The same key left out twice is one exclusion; it is listed whatever the day.
  const out = { kind: 'exclude', accountId: 'acc-lucia', merchantKey: 'SPOTIFY' };
  const excluded = await api('lucia', 'forecast/adjustments', out);
  const again = await api('lucia', 'forecast/adjustments', out);
  assert.deepEqual([excluded.status, again.status], [201, 200]);
  assert.equal(again.body.adjustment.id, excluded.body.adjustment.id);
  assert.deepEqual(
    (await forecastOf('lucia')).notCounted.filter((n: any) => n.adjustmentId),
    [
      {
        label: 'Spotify',
        reason: 'excluded_by_you',
        adjustmentId: excluded.body.adjustment.id,
        text: 'Spotify: left out by you, not counted.',
      },
    ],
  );

  // Bruno sees none of it and cannot remove it.
  assert.equal(JSON.stringify(await forecastOf('bruno')), brunoBefore);
  assert.deepEqual((await api('bruno', `forecast/adjustments/${id}`, undefined, 'DELETE')).body, {
    removed: false,
  });
  assert.equal((await forecastOf('lucia')).adjustments.length, 2);

  // The label: in no observation (told in the chat, recorded for the operator), no event, no
  // usage row, no log line. Nothing was sent, proposed or prepared.
  const dashboard = (await api('lucia', 'dashboard')).body;
  const observations = explainObservations({
    accounts: dashboard.accounts,
    view: null,
    prepared: [],
    today: today(),
    forecast: short,
  });
  assert.deepEqual(observations.find((k) => k.kind === 'month_shortfall')!.found, []);
  assert.deepEqual(['intents', 'approvals', 'prepared_transfers', 'events'].map(count), [
    intents,
    approvals,
    prepared,
    events,
  ]);
  for (const table of ['events', 'ai_usage', 'messages', 'incidents'])
    assert.doesNotMatch(
      JSON.stringify(appDb().prepare(`SELECT * FROM ${table}`).all()),
      /Zq insurance/,
    );

  // Removed: the forecast is what it was, byte for byte; a second removal removes nothing.
  for (const each of [id, excluded.body.adjustment.id])
    assert.deepEqual(
      (await api('lucia', `forecast/adjustments/${each}`, undefined, 'DELETE')).body,
      {
        removed: true,
      },
    );
  assert.deepEqual((await api('lucia', `forecast/adjustments/${id}`, undefined, 'DELETE')).body, {
    removed: false,
  });
  assert.equal(JSON.stringify(await forecastOf('lucia')), before);

  const lines = logged.join('\n');
  assert.match(lines, /"route":"forecast\/adjustments"/, 'the access log was captured');
  assert.match(lines, /"route":"forecast\/adjustments\/:id"/);
  assert.doesNotMatch(lines, /Zq insurance|ecnarusni/);
  assert.doesNotMatch(lines, new RegExp(id));
});

test('REQ-PL-37/39 the cap answers 409 with its sentence; a reseed (what `npm run reset` runs) clears the table; the migration applies on the previous version', async (t) => {
  for (let n = 1; n <= 20; n++)
    assert.equal(
      (
        await api(
          'lucia',
          'forecast/adjustments',
          expectBody({ label: `Bill ${n}`, amountCents: 100 }),
        )
      ).status,
      201,
    );
  const over = await api('lucia', 'forecast/adjustments', expectBody({ label: 'Bill 21' }));
  assert.equal(over.status, 409);
  assert.deepEqual(over.body, {
    error: 'You already have 20 changes to your month ahead. Remove one before adding another.',
    code: 'too_many',
  });
  // Carla's own count is her own.
  assert.equal(
    (await api('carla', 'forecast/adjustments', expectBody({ accountId: 'acc-carla' }))).status,
    201,
  );
  assert.equal(count('forecast_adjustments'), 23); // 21 active and the two removed above, kept
  assert.match(fs.readFileSync('scripts/reset.ts', 'utf8'), /seedApp\(\)/);
  seedApp();
  assert.equal(count('forecast_adjustments'), 0);

  // A database one version back: no table, its migration not recorded, a customer's row in place.
  const name = 'fc2-forecast-adjustments';
  const version = appDb()
    .prepare('SELECT version FROM schema_migrations WHERE name=?')
    .pluck()
    .get(name) as number;
  appDb()
    .prepare(
      "INSERT INTO conversations(id,user_id,title,created_at) VALUES('fc2-kept','lucia','T','2026-10-01T00:00:00.000Z')",
    )
    .run();
  closeAppDb();
  const old = new Database(path.join(temp, 'app.sqlite'));
  old.exec('DROP TABLE forecast_adjustments');
  old.prepare('DELETE FROM schema_migrations WHERE version>=?').run(version);
  old.close();
  assert.equal(
    appDb().prepare('SELECT name FROM schema_migrations WHERE version=?').pluck().get(version),
    name,
  );
  assert.equal(count('forecast_adjustments'), 0);
  assert.equal(
    appDb().prepare("SELECT COUNT(*) FROM conversations WHERE id='fc2-kept'").pluck().get(),
    1,
  );
  assert.equal((await api('lucia', 'forecast/adjustments', expectBody())).status, 201);
});
