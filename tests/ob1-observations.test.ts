// OB1: spending observations, the core (plan 26 §2–§4, §7; REQ-OB-1…8). The real risk is a false
// figure, so every amount of a basis is recomputed here from the input. No test reads the real
// date: detection takes `today`, and the route tests use `prepared_uncovered`, which has none.
// Rules only (DECIDER=none): no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { callApi, setupEnv, startSimulator } from './helpers/bank';
import type { Observation, ObservationInput } from '../src/observations/detect';
import type { PreparedView } from '../src/banking/prepared';
import type { CategoryId, MovementInput, RowCategory } from '../src/insights/taxonomy';
import { people } from '../src/people';

const { temp } = await setupEnv('banana-ob1-');
Object.assign(process.env, {
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json', // what `npm run demo` serves
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
// After setupEnv: detection imports the summary, which reads the configuration when it loads.
const { explainObservations, pickObservation } = await import('../src/observations/detect');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb, insert } = await import('../src/db');
const { config } = await import('../src/config');
const { bankView } = await import('../src/banking/view');
const { prepareTransfer } = await import('../src/banking/prepared');
const { observationGate, observationHistory, recordTold, setObservationsEnabled } =
  await import('../src/observations/state');
seedBank();
seedApp();
let bank: ChildProcess = await startSimulator('simulator');
setScenario('normal');
after(() => {
  bank.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const TODAY = '2026-10-04'; // M = September, P = August
const EATING = 'eating_out_leisure';
const euros = (cents: number) =>
  `€${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
const found = (i: ObservationInput, kind: Observation['kind']) =>
  explainObservations(i).find((k) => k.kind === kind)!.found;

// ---- built inputs ----

type Row = [day: string, cents: number, category?: Partial<RowCategory>];
function view(rows: Row[]) {
  const categories = new Map<string, RowCategory>();
  const movements = rows.map(([day, cents, category], n): MovementInput => {
    const id = `m${n}`;
    categories.set(id, {
      id: EATING,
      state: 'confirmed',
      source: 'rule',
      merchantKey: 'bar',
      ...category,
    } as RowCategory);
    return {
      id,
      accountId: 'acc',
      amountCents: -cents,
      description: 'BAR',
      createdAt: `${day}T10:00:00.000Z`,
    };
  });
  return { movements, categories };
}
const months = (september: number[], august: number[], extra: Row[] = []) =>
  view([
    ...september.map((c, n): Row => [`2026-09-${10 + n}`, c]),
    ...august.map((c, n): Row => [`2026-08-${10 + n}`, c]),
    ...extra,
  ]);
const input = (v: ObservationInput['view'], prepared: PreparedView[] = []): ObservationInput => ({
  accounts: [
    { id: 'acc', label: 'Main account', balanceCents: 100_00 },
    { id: 'acc-2', label: 'Second account', balanceCents: 900_00 },
  ],
  view: v,
  prepared,
  today: TODAY,
});
const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
const basis = (september: number[], august: number[], review = '') =>
  `Eating out & leisure: ${euros(sum(september))} in September (${september.length} payments), ${euros(sum(august))} in August (${august.length}). Only movements classified by a rule or confirmed by you are counted.${review}`;

// REQ-OB-2: each threshold at its value and one step below. REQ-OB-4: the amounts are the sums.
const BOUNDARIES: [string, number[], number[], boolean][] = [
  ['€50, 3 movements and +€15, all at the value', [2000, 2000, 1000], [3500], true],
  ['€49.99 in the month', [2000, 2000, 999], [3484], false],
  ['2 movements in the month', [3000, 2000], [3500], false],
  ['+€14.99', [2000, 2000, 1000], [3501], false],
  ['€20 the month before', [2000, 2000, 1000], [1000, 1000], true],
  ['€19.99 the month before', [2000, 2000, 1000], [1999], false],
  ['+25%', [5000, 3000, 2000], [8000], true],
  ['one cent under +25%', [5000, 3000, 1999], [8000], false],
];
for (const [name, september, august, fires] of BOUNDARIES)
  test(`REQ-OB-2 category_up: ${name} ${fires ? 'fires' : 'is silent'}`, () => {
    const i = input(months(september, august));
    const all = found(i, 'category_up');
    assert.equal(all.length, fires ? 1 : 0);
    if (!fires) return assert.equal(pickObservation(i, []), null);
    assert.deepEqual(all[0], {
      key: `category_up:${EATING}:2026-09`,
      kind: 'category_up',
      title: 'Eating out & leisure is up',
      basis: basis(september, august),
      // Newest first: September by day, then August.
      movementIds: [...september.keys()]
        .reverse()
        .concat([...august.keys()].reverse().map((n) => n + september.length))
        .map((n) => `m${n}`),
    });
    assert.deepEqual(explainObservations(i), explainObservations(i), 'same input, same output');
  });

const NOT_COUNTED = (n: number) =>
  n === 1
    ? ' 1 movement of those months is not classified by a rule or by you and is not in these figures.'
    : ` ${n} movements of those months are not classified by a rule or by you and are not in these figures.`;
test('REQ-OB-3: a model estimate or a movement in review is in no figure; the basis counts every payment left out', () => {
  const uncounted: Row[] = [
    ['2026-09-20', 9999, { source: 'model', state: 'estimated' }],
    ['2026-08-20', 7777, { source: 'rule', state: 'needs_review' }],
    ['2026-09-21', 5555, { source: 'none', state: 'pending' }],
    ['2026-10-01', 4444, { state: 'needs_review' }], // not in the two months: not in the count
  ];
  const [o] = found(input(months([2000, 2000, 1000], [3500], uncounted)), 'category_up');
  assert.equal(o.basis, basis([2000, 2000, 1000], [3500], NOT_COUNTED(3)));
  assert.deepEqual(o.movementIds, ['m2', 'm1', 'm0', 'm3']);
  const one = months([2000, 2000, 1000], [3500], [uncounted[0]]);
  assert.equal(
    found(input(one), 'category_up')[0].basis,
    basis([2000, 2000, 1000], [3500], NOT_COUNTED(1)),
  );
  // Counted alone they would not fire: three estimates of €30 against a counted €35.
  const estimates = months(
    [],
    [3500],
    [
      ['2026-09-10', 3000, { source: 'model', state: 'estimated' }],
      ['2026-09-11', 3000, { source: 'model', state: 'estimated' }],
      ['2026-09-12', 3000, { source: 'model', state: 'estimated' }],
    ],
  );
  assert.deepEqual(found(input(estimates), 'category_up'), []);
});

// OB4: measured live with a decider on, the Overview said "1 movement … still to review" and the
// chat said 9 for the same customer in the same minute: the sentence counted the movements in
// review only, so it changed with what the decider had done so far.
test('OB4: the count of what is not in the figures is the same whatever the decider did with those movements', () => {
  const STATES: [string, Partial<RowCategory> | null][] = [
    ['no decider, over budget or unavailable', { source: 'none', state: 'needs_review' }],
    ['estimated by a model', { source: 'model', state: 'estimated' }],
    ['a model answer below its bar', { source: 'model', state: 'needs_review' }],
    ['still being classified', { source: 'none', state: 'pending' }],
    ['never classified (no row)', null],
  ];
  for (const [name, state] of STATES) {
    const v = months(
      [2000, 2000, 1000],
      [3500],
      [
        ['2026-09-20', 900, { id: 'other', ...state }],
        ['2026-09-21', 800, { id: 'groceries', ...state }],
        ['2026-08-22', 700, { id: 'other', ...state }],
        // Never a payment to a merchant, so never in the count: a credit and an app transfer.
        ['2026-09-23', -600, { id: 'other', ...state }],
        ['2026-09-24', 500, { id: 'other', ...state }],
      ],
    );
    v.movements[8].operationId = 'op-1';
    if (!state) for (const n of [4, 5, 6, 7, 8]) v.categories.delete(`m${n}`);
    const [o] = found(input(v), 'category_up');
    assert.equal(o.basis, basis([2000, 2000, 1000], [3500], NOT_COUNTED(3)), name);
  }
});

// Review of #137: "Other is up" or "Transfers to people is up" is noise, not an observation.
test('REQ-OB-2 category_up: never names a bucket that is not spending (other, transfers to people, own transfers)', () => {
  for (const id of ['other', 'transfer_person', 'savings_internal'] as CategoryId[]) {
    const rows = (month: string, cents: number[]) =>
      cents.map((c, n): Row => [`2026-${month}-${10 + n}`, c, { id }]);
    const i = input(view([...rows('09', [2000, 2000, 1000]), ...rows('08', [3500])]));
    assert.deepEqual(found(i, 'category_up'), [], id);
  }
});

test('REQ-OB-3: a full bank page that starts inside the month before is silent; one that starts earlier fires', () => {
  const filler = (n: number): Row[] =>
    Array.from({ length: n }, (): Row => ['2026-10-02', 100, { id: 'groceries' as CategoryId }]);
  const cut = months([2000, 2000, 1000], [3500], filler(96));
  assert.equal(cut.movements.length, 100);
  const kind = explainObservations(input(cut)).find((k) => k.kind === 'category_up')!;
  assert.deepEqual(kind.found, []);
  assert.match(kind.why, /full page that starts in 2026-08/);
  const whole = months([2000, 2000, 1000], [3500], [...filler(95), ['2026-07-31', 100]]);
  assert.equal(whole.movements.length, 100);
  assert.equal(found(input(whole), 'category_up').length, 1);
  // Not a full page: nothing can be missing.
  assert.equal(
    found(input(months([2000, 2000, 1000], [3500], filler(95))), 'category_up').length,
    1,
  );
});

test('REQ-OB-1: category_up depends on the day passed in, never on the clock', () => {
  const v = months([2000, 2000, 1000], [3500]);
  assert.equal(found({ ...input(v), today: '2026-10-31' }, 'category_up').length, 1);
  assert.equal(found({ ...input(v), today: '2026-11-01' }, 'category_up').length, 0);
  assert.equal(found({ ...input(v), today: '2026-09-30' }, 'category_up').length, 0);
});

const prepared = (id: string, over: Partial<PreparedView> = {}): PreparedView => ({
  id,
  fromAccountId: 'acc',
  toAccountId: 'acc-x',
  to: 'Carla Ríos',
  amountCents: 100_01,
  concept: 'Rent',
  note: 'a private note',
  when: { kind: 'manual' },
  nextDue: null,
  state: 'ready',
  approvalId: null,
  expiresAt: null,
  lastAttempt: null,
  lastSentAt: null,
  ...over,
});
test('REQ-OB-2, REQ-OB-4 prepared_uncovered: above the balance of its own source account, within 7 days, never paused, awaiting or verifying', () => {
  const keys = (list: PreparedView[]) =>
    found(input(null, list), 'prepared_uncovered').map((o) => o.key);
  // One cent above the €100.00 of its source; equal is covered.
  assert.deepEqual(keys([prepared('a')]), ['prepared_uncovered:a:once']);
  assert.deepEqual(keys([prepared('a', { amountCents: 100_00 })]), []);
  // The same amount from the account that holds €900.00 is covered: the balance is the source's.
  assert.deepEqual(keys([prepared('a', { fromAccountId: 'acc-2' })]), []);
  assert.deepEqual(keys([prepared('a', { fromAccountId: 'acc-gone' })]), []);
  for (const state of ['paused', 'awaiting_confirmation', 'verifying'] as const)
    assert.deepEqual(keys([prepared('a', { state, nextDue: TODAY })]), [], state);
  const scheduled = (nextDue: string) => prepared('s', { state: 'scheduled', nextDue });
  assert.deepEqual(keys([scheduled('2026-10-11')]), ['prepared_uncovered:s:2026-10-11']);
  assert.deepEqual(keys([scheduled('2026-10-12')]), []);

  // By due date, a manual one last; before any category; with no movements read.
  const list = [
    prepared('manual'),
    scheduled('2026-10-09'),
    prepared('due', { state: 'due', nextDue: TODAY, fromAccountId: 'acc-2', amountCents: 950_00 }),
  ];
  const all = found(input(months([2000, 2000, 1000], [3500]), list), 'prepared_uncovered');
  assert.deepEqual(
    all.map((o) => o.basis),
    [
      'Your prepared transfer of €950.00 to Carla Ríos (due today) is more than the €900.00 in your Second account today.',
      'Your prepared transfer of €100.01 to Carla Ríos (due on 9 Oct) is more than the €100.00 in your Main account today.',
      'Your prepared transfer of €100.01 to Carla Ríos (ready to send) is more than the €100.00 in your Main account today.',
    ],
  );
  assert.deepEqual(all[0], {
    key: `prepared_uncovered:due:${TODAY}`,
    kind: 'prepared_uncovered',
    title: 'A prepared transfer is not covered',
    basis: all[0].basis,
    movementIds: [],
    preparedId: 'due',
  });
  const i = input(months([2000, 2000, 1000], [3500]), list);
  assert.equal(pickObservation(i, [])!.preparedId, 'due');
  assert.equal(
    pickObservation(
      i,
      all.map((o) => o.key),
    )!.kind,
    'category_up',
  );
});

// ---- REQ-OB-1: the seeded customers ----

const customers = people.filter((p) => p.role === 'customer').map((p) => p.id);
async function seededKeys(today: string) {
  const keys: Record<string, string | null> = {};
  for (const id of customers) {
    const v = await bankView(id);
    const i = {
      accounts: v.accounts as ObservationInput['accounts'],
      view: v,
      prepared: [],
      today,
    };
    assert.deepEqual(explainObservations(i), explainObservations(i), 'same input, same output');
    keys[id] = pickObservation(i, [])?.key ?? null;
  }
  return keys;
}
const nobody = Object.fromEntries(customers.map((id) => [id, null]));
test('REQ-OB-1: on the simulator nobody gets an observation', async () => {
  assert.deepEqual(await seededKeys(TODAY), nobody);
});

// ---- the gate, the state and the routes (simulator; Hugo has no seeded open case) ----

const USER = 'hugo';
const ctx = { userId: USER, conversationId: null, runId: 'run-ob1', intentId: '' };
const dashboard = async () => (await callApi(USER, 'dashboard')).body.observation as Observation;
const post = (body: unknown, userId = USER) => callApi(userId, 'observations', body);
// A prepared transfer for more than Hugo's balance (D8: preparing does not check the balance).
async function uncovered(extra: object = {}) {
  const [account] = (await bankView(USER)).accounts as ObservationInput['accounts'];
  const amountCents = account.balanceCents + 1;
  const result = await prepareTransfer(ctx, {
    fromAccountId: account.id,
    toAccountId: 'acc-lucia',
    amountCents,
    concept: 'Deposit',
    note: 'do not show this',
    when: 'manual',
    ...extra,
  });
  assert.equal(result.status, 'prepared', JSON.stringify(result));
  return { id: (result.prepared as PreparedView).id, account, amountCents };
}
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const intent = (
  status: 'pending_verification' | 'processing' | 'failed',
  created_at = hoursAgo(0),
) =>
  insert('intents', {
    id: `intent-ob1-${status}`,
    user_id: USER,
    conversation_id: null,
    payload: '{}',
    status,
    created_at,
  });
const incident = (created_at = hoursAgo(0)) =>
  insert('incidents', {
    id: 'case-ob1',
    user_id: USER,
    conversation_id: 'conv-hugo-welcome',
    summary: 's',
    status: 'open',
    created_at,
  });
const CAUSES: [reason: string, name: string, cause: () => unknown][] = [
  ['off', 'OBSERVATIONS=off', () => (config.observations = 'off')],
  ['disabled', 'turned off by the customer', () => setObservationsEnabled(ctx, false)],
  ['open_case', 'a case opened today', () => incident()],
  ['transfer_trouble', 'a transfer being verified', () => intent('pending_verification')],
  ['transfer_trouble', 'a transfer in process', () => intent('processing')],
  ['transfer_trouble', 'a transfer that failed today', () => intent('failed')],
  // Review of #137: a transfer waiting for the customer's confirmation.
  [
    'pending_approval',
    'a pending approval',
    () =>
      insert('approvals', {
        id: 'approval-ob1',
        user_id: USER,
        intent_id: 'intent-ob1',
        payload: '{}',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        consumed_at: null,
      }),
  ],
];
for (const [reason, name, cause] of CAUSES)
  test(`REQ-OB-5: ${name} → ${reason}, and no observation in the dashboard`, async () => {
    seedApp();
    const { id } = await uncovered();
    assert.deepEqual(observationGate(USER), { ok: true });
    assert.equal((await dashboard()).preparedId, id);
    try {
      cause();
      assert.deepEqual(observationGate(USER), { ok: false, reason });
      assert.equal(await dashboard(), null);
    } finally {
      config.observations = 'on';
    }
  });

test('REQ-OB-5: trouble older than a day does not silence the Overview', async () => {
  seedApp();
  const { id } = await uncovered();
  incident(hoursAgo(25));
  intent('failed', hoursAgo(25));
  assert.deepEqual(observationGate(USER), { ok: true });
  assert.equal((await dashboard()).preparedId, id);
});

test('REQ-OB-4, REQ-OB-7: the dashboard states the bank balance of this load and adds no bank request', async () => {
  seedApp();
  const { id, account, amountCents } = await uncovered();
  const paths: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (request, init) => {
    const url = String(request instanceof Request ? request.url : request);
    if (url.startsWith(process.env.BANK_URL!)) paths.push(new URL(url).pathname);
    return realFetch(request, init);
  };
  try {
    assert.deepEqual(await dashboard(), {
      key: `prepared_uncovered:${id}:once`,
      kind: 'prepared_uncovered',
      title: 'A prepared transfer is not covered',
      // The destination's name and the account label are the bank's; the customer's note and
      // concept are not in it.
      basis: `Your prepared transfer of ${euros(amountCents)} to Lucía Martín · Aurora account (ready to send) is more than the ${euros(account.balanceCents)} in your ${account.label} today.`,
      movementIds: [],
      preparedId: id,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(paths.sort(), ['/v1/accounts', '/v1/contacts', '/v1/movements']);
});

test('REQ-OB-6: dismiss and off are idempotent, survive a restart, and are wiped by seedApp', async () => {
  seedApp();
  const manual = await uncovered();
  const dated = await uncovered({ when: 'on_date', inDays: 3 });
  const events = (kind: string) =>
    (
      appDb()
        .prepare('SELECT COUNT(*) n FROM events WHERE user_id=? AND kind=?')
        .get(USER, kind) as {
        n: number;
      }
    ).n;
  const first = await dashboard();
  assert.equal(first.preparedId, dated.id, 'the dated one is first');

  for (let n = 0; n < 2; n++)
    assert.deepEqual(await post({ dismiss: first.key }), { status: 200, body: { status: 'ok' } });
  assert.equal(events('observation.dismissed'), 1);
  assert.equal((await dashboard()).preparedId, manual.id, 'the next observation');
  closeAppDb(); // a restart: the next read reopens the database file
  assert.deepEqual(observationHistory(USER).dismissed, [first.key]);
  assert.equal((await dashboard()).preparedId, manual.id);

  for (let n = 0; n < 2; n++) assert.equal((await post({ enabled: false })).status, 200);
  assert.equal(events('observations.disabled'), 1);
  assert.equal(await dashboard(), null);
  assert.equal((await post({ enabled: true })).status, 200);
  const second = await dashboard();
  assert.equal(second.preparedId, manual.id);

  // Told in the chat (OB3): once per key, and the page still shows it (D5).
  recordTold(ctx, second);
  recordTold(ctx, second);
  assert.deepEqual(observationHistory(USER).told, [second.key]);
  assert.equal((await dashboard()).key, second.key);

  await post({ dismiss: second.key });
  assert.equal(await dashboard(), null);

  for (const body of [
    {},
    { dismiss: 'recurring_new:x' },
    { dismiss: 'category_up:' },
    { dismiss: `category_up:${'x'.repeat(161)}` },
    { dismiss: 'category_up:a\nb' },
    { dismiss: 'category_up:a', enabled: true },
    { dismiss: 'category_up:a', extra: 1 },
    { enabled: 'yes' },
    { enabled: true, userId: 'lucia' },
  ])
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal((await post({ enabled: false }, 'marta')).status, 403, 'an operator');
  assert.equal((await callApi(USER, 'observations')).status, 405, 'GET');
  assert.equal(events('observation.dismissed'), 2, 'a refused request records nothing');

  seedApp();
  assert.deepEqual(observationHistory(USER), { dismissed: [], told: [], disabled: false });
});

// ---- REQ-OB-1: the demo bank (started last: it replaces the simulator on the same port) ----

test('REQ-OB-1: on the demo bank Bruno gets category_up with figures recomputed from his movements', async () => {
  bank.kill();
  seedApp();
  bank = await startSimulator('alt');
  assert.deepEqual(await seededKeys(TODAY), {
    ...nobody,
    bruno: `category_up:${EATING}:2026-09`,
  });
  assert.deepEqual(await seededKeys('2026-11-04'), nobody);

  const v = await bankView('bruno');
  const picked = pickObservation(
    { accounts: v.accounts as ObservationInput['accounts'], view: v, prepared: [], today: TODAY },
    [],
  )!;
  // Bruno's Eating out & leisure movements decided by a rule, per UTC month (none of them is
  // within two hours of a month's end, so the Madrid month is the same).
  const inMonth = (month: string) => v.movements.filter((m) => m.createdAt.startsWith(month));
  const counted = (month: string) =>
    inMonth(month).filter((m) => {
      const c = v.categories.get(m.id)!;
      return c.id === EATING && c.source === 'rule' && c.state !== 'needs_review';
    });
  const [september, august] = ['2026-09', '2026-08'].map(counted);
  // OB4: every payment of the two months that no rule decided (DECIDER=none: all in review).
  const review = ['2026-09', '2026-08'].flatMap(inMonth).filter((m) => {
    const c = v.categories.get(m.id)!;
    return c.source !== 'rule' && m.amountCents < 0 && !m.operationId;
  }).length;
  const spent = (list: typeof september) => list.map((m) => -m.amountCents);
  assert.ok(september.length >= 3 && review > 1, 'the seed has what the sentence states');
  assert.equal(picked.basis, basis(spent(september), spent(august), NOT_COUNTED(review)));
  assert.deepEqual(
    picked.movementIds,
    [...september, ...august].map((m) => m.id),
    'newest first, as the bank view is',
  );
});

test('REQ-OB-8: npm run observations:table needs no key and states the day it was computed for', () => {
  const { OPENAI_API_KEY: _key, ...env } = process.env;
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/observations-table.ts', '--today', TODAY],
    { env, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split('\n');
  assert.equal(lines[0], `Spending observations computed for ${TODAY} (Europe/Madrid).`);
  for (const id of customers)
    assert.equal(
      lines.filter((l) => l.startsWith(`${id} — `)).length,
      2,
      `${id}: one row per bank`,
    );
  assert.match(
    run.stdout,
    /\nlucia, with a made-up prepared transfer of €[\d,.]+ from Aurora account — /,
  );
  assert.match(
    run.stdout,
    /\n {2}prepared_uncovered — .* is more than the €[\d,.]+ in your Aurora account today\.\n/,
  );
  assert.match(run.stdout, /\n {2}category_up — Eating out & leisure is up\. /);
  assert.match(run.stdout, /\n15 of 16 seeded customers get no observation on 2026-10-04/);
});
